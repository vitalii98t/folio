import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeCodeStatus } from '../shared/types';

/**
 * Find the claude CLI executable.
 * Electron inherits a limited PATH, so we check common locations.
 */
function findClaudePath(): string | null {
  // 1. Try PATH directly
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    return 'claude';
  } catch {}

  // 2. Common npm global install locations
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
    // Try npm prefix -g
    try {
      const prefix = execSync('npm prefix -g', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
      candidates.push(path.join(prefix, 'claude.cmd'));
    } catch {}
  } else {
    const home = process.env.HOME || '';
    candidates.push(
      path.join(home, '.local', 'bin', 'claude'),           // new claude.ai/install.sh default
      '/usr/local/bin/claude',                               // Homebrew / traditional
      '/opt/homebrew/bin/claude',                            // Homebrew on Apple Silicon
      '/usr/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.bun', 'bin', 'claude'),              // bun install
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

/** Heuristically check if Claude Code is logged in by inspecting `~/.claude/`.
 *  Looks for any of the credential files Claude CLI is known to write. */
function hasClaudeCredentials(): boolean {
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
