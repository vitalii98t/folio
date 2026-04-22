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

export function checkClaudeCodeStatus(): ClaudeCodeStatus {
  const claudePath = getClaudePath();
  if (!claudePath) return 'not_installed';

  try {
    execSync(`"${claudePath}" --version`, { stdio: 'pipe', timeout: 10000 });
    return 'ready';
  } catch {
    return 'not_authenticated';
  }
}
