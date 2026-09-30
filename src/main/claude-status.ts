import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeCodeStatus } from '../shared/types';

/**
 * Find the claude CLI executable. We always return an ABSOLUTE PATH because
 * the Claude Code SDK passes `pathToClaudeCodeExecutable` to a child-process
 * spawn that doesn't do PATH lookup — handing it a bare `"claude"` makes the
 * SDK throw "Claude Code native binary not found at claude" even when the
 * binary works fine from the terminal.
 *
 * Resolution order:
 *   1. `where claude` / `which claude` — picks up wherever the user's shell
 *      finds it (covers any custom install location they've put on PATH).
 *   2. Common known install dirs (claude.ai/install.{cmd,sh} default,
 *      Homebrew, npm-global, bun) — fallback when Electron's inherited PATH
 *      doesn't include the user's `~/.local/bin` etc.
 *   3. `npm prefix -g` derived path — for npm-installed builds.
 */
function findClaudePath(): ResolvedClaude | null {
  const isWin = process.platform === 'win32';

  // 1. Resolve absolute path via `where`/`which`
  const lookupCmd = isWin ? 'where claude' : 'which claude';
  try {
    const out = execSync(lookupCmd, { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
    // `where` on Windows can return multiple paths separated by newlines
    // (typically `...\npm\claude` AND `...\npm\claude.cmd`) — take the first
    // one that exists and is (or maps to) something spawnable without a shell.
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      const resolved = resolveCandidate(line);
      if (resolved) return resolved;
    }
  } catch {}

  // 2. Common install locations (absolute paths)
  const candidates: string[] = [];

  if (isWin) {
    const appData = process.env.APPDATA || '';
    const userProfile = process.env.USERPROFILE || '';
    candidates.push(
      // Native installer (claude.ai/install.cmd) — a real .exe, first-class.
      path.join(userProfile, '.local', 'bin', 'claude.exe'),
      // npm-global shims — mapped to the package's bin\claude.exe / cli.js.
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(userProfile, '.npm-global', 'claude.cmd'),
      'C:\\Program Files\\nodejs\\claude.cmd',
    );
    try {
      const prefix = execSync('npm prefix -g', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
      if (prefix) candidates.push(path.join(prefix, 'claude.cmd'));
    } catch {}
  } else {
    const home = process.env.HOME || '';
    candidates.push(
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.bun', 'bin', 'claude'),
    );
  }

  for (const c of candidates) {
    const resolved = c ? resolveCandidate(c) : null;
    if (resolved) return resolved;
  }

  return null;
}

interface ResolvedClaude {
  /** Path handed to the SDK's `pathToClaudeCodeExecutable` — spawned directly,
   *  without a shell. On Windows always a `.exe` or a `.js` entry point. */
  exec: string;
  /** Path to use when invoking the CLI through a shell / terminal. Usually the
   *  same as `exec`; for npm installs it is the original `claude.cmd` shim,
   *  which a shell can run but `spawn()` cannot. */
  shell: string;
}

/**
 * Turn a found path into something the SDK can spawn.
 *
 * The SDK calls `child_process.spawn(path)` with no shell. On Windows that
 * fails with EINVAL for `.cmd`/`.bat` shims, and the extensionless sh shim npm
 * also writes isn't executable at all. So on win32 we accept only `.exe` or
 * `.js`; a shim is mapped to the package it launches:
 *   <npm dir>\node_modules\@anthropic-ai\claude-code\bin\claude.exe  (native)
 *   <npm dir>\node_modules\@anthropic-ai\claude-code\cli.js           (JS build)
 */
function resolveCandidate(candidate: string): ResolvedClaude | null {
  if (!candidate || !fs.existsSync(candidate)) return null;
  if (process.platform !== 'win32') return { exec: candidate, shell: candidate };

  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.exe' || ext === '.js') return { exec: candidate, shell: candidate };

  if (ext === '' || ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
    const pkgDir = path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code');
    // For shell use keep a cmd.exe-runnable shim when there is one.
    const shim = ext === '.cmd' || ext === '.bat'
      ? candidate
      : (fs.existsSync(`${candidate.replace(/\.ps1$/i, '')}.cmd`) ? `${candidate.replace(/\.ps1$/i, '')}.cmd` : null);
    for (const target of [path.join(pkgDir, 'bin', 'claude.exe'), path.join(pkgDir, 'cli.js')]) {
      if (fs.existsSync(target)) return { exec: target, shell: shim ?? target };
    }
  }
  return null;
}

let _resolved: ResolvedClaude | null | undefined;

function getResolved(): ResolvedClaude | null {
  if (_resolved === undefined) _resolved = findClaudePath();
  return _resolved;
}

/** Absolute path for the SDK's `pathToClaudeCodeExecutable`. On Windows this
 *  is always a `.exe` or a `.js` file (never a `.cmd` shim). */
export function getClaudePath(): string | null {
  return getResolved()?.exec ?? null;
}

/** Quoted command prefix for running the CLI through a shell (`execSync`, a
 *  terminal window): the `.exe`, the npm `claude.cmd` shim, or
 *  `node "<...>\cli.js"` when only the JS entry point is known. Use this —
 *  not `"${getClaudePath()}"` — for shell invocations. */
export function getClaudeShellCommand(): string | null {
  const r = getResolved();
  if (!r) return null;
  if (r.shell.toLowerCase().endsWith('.js')) return `node "${r.shell}"`;
  return `"${r.shell}"`;
}

/** Run the CLI with args and no shell. A `.js` entry point runs under
 *  Electron's own Node (ELECTRON_RUN_AS_NODE) so it works without `node` on PATH. */
function runClaude(claudePath: string, args: string[], timeout: number): void {
  if (claudePath.toLowerCase().endsWith('.js')) {
    execFileSync(process.execPath, [claudePath, ...args], {
      stdio: 'pipe',
      timeout,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
  } else {
    execFileSync(claudePath, args, { stdio: 'pipe', timeout, windowsHide: true });
  }
}

/** Heuristically check if Claude Code is logged in.
 *
 * On Linux/Windows the CLI writes a credentials file under `~/.claude/`.
 * On macOS the CLI stores tokens in the system **Keychain** instead — there's
 * no file to detect, and querying Keychain directly would either prompt the
 * user with a permission dialog or require entitlements we don't have.
 *
 * Strategy: on macOS, optimistically assume credentials are present (the
 * agent-manager already handles `isAuthError` from the SDK on the first real
 * message and surfaces a friendly re-login prompt — far better than blocking
 * a fully-authenticated user at the setup screen). On other platforms we
 * keep the file-based heuristic. */
function hasClaudeCredentials(): boolean {
  if (process.platform === 'darwin') return true;

  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return false;
  const candidates = [
    path.join(home, '.claude', 'credentials.json'),
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', 'auth.json'),
    path.join(home, '.config', 'claude', 'credentials.json'),
  ];
  return candidates.some(p => {
    try {
      const stat = fs.statSync(p);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  });
}

export function checkClaudeCodeStatus(): ClaudeCodeStatus {
  // Re-scan the filesystem each time — the user may have just installed
  // Claude Code in a terminal and clicked "Перевірити знову". A cached
  // null from app startup would otherwise persist forever.
  _resolved = findClaudePath();
  const claudePath = _resolved?.exec;
  if (!claudePath) return 'not_installed';

  try {
    runClaude(claudePath, ['--version'], 10000);
  } catch {
    return 'not_installed';
  }

  // Binary works — but we still need credentials. `--version` doesn't test auth.
  return hasClaudeCredentials() ? 'ready' : 'not_authenticated';
}

/** True when the given runtime error from Claude SDK is an auth/expired-token
 *  failure, so the renderer can prompt re-login.
 *
 *  Matches only Claude Code's OWN auth/billing failure texts. A bare "403" or
 *  "credentials" is deliberately NOT enough: those show up in tool output
 *  (a Google Drive 403, an MCP server complaining about its credentials) and
 *  must not bounce the user to the Claude login screen. */
export function isAuthError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return CLAUDE_AUTH_ERROR_RE.test(message);
}

const CLAUDE_AUTH_ERROR_RE = new RegExp(
  [
    'invalid api key',                        // "Invalid API key · Please run /login"
    'please run /login',
    'not logged in',                          // "Not logged in · Please run /login"
    'oauth token (?:has )?(?:been )?(?:expired|revoked)',
    'oauth authentication is currently not allowed',
    'authentication_error',                   // Anthropic API error type
    'invalid x-api-key',
    'api error: 401\\b',                      // "API Error: 401 {...}" printed by the CLI
    'credit balance is too low',
    'does not have access to claude',
  ].join('|'),
  'i',
);
