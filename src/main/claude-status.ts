import { execSync } from 'child_process';
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
function findClaudePath(): string | null {
  // 1. Resolve absolute path via `where`/`which`
  const lookupCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  try {
    const out = execSync(lookupCmd, { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
    // `where` on Windows can return multiple paths separated by newlines —
    // take the first one that exists and looks like an executable, not a
    // shim/symlink we can't actually run from a different cwd.
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line && fs.existsSync(line)) return line;
    }
  } catch {}

  // 2. Common install locations (absolute paths)
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const userProfile = process.env.USERPROFILE || '';
    candidates.push(
      path.join(userProfile, '.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(userProfile, '.npm-global', 'claude.cmd'),
      'C:\\Program Files\\nodejs\\claude.cmd',
    );
    try {
      const prefix = execSync('npm prefix -g', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
      candidates.push(path.join(prefix, 'claude.cmd'));
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
    if (c && fs.existsSync(c)) return c;
  }

  return null;
}

let _claudePath: string | null | undefined;

export function getClaudePath(): string | null {
  if (_claudePath === undefined) {
    _claudePath = findClaudePath();
  }
  return _claudePath;
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
  _claudePath = findClaudePath();
  const claudePath = _claudePath;
  if (!claudePath) return 'not_installed';

  try {
    execSync(`"${claudePath}" --version`, { stdio: 'pipe', timeout: 10000 });
  } catch {
    return 'not_installed';
  }

  // Binary works — but we still need credentials. `--version` doesn't test auth.
  return hasClaudeCredentials() ? 'ready' : 'not_authenticated';
}

/** True when the given runtime error from Claude SDK is an auth/expired-token
 *  failure, so the renderer can prompt re-login. */
export function isAuthError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return /\b(401|403)\b|unauthorized|authenticate|invalid[_ ]?api[_ ]?key|credentials|expired|subscription/i.test(message);
}
