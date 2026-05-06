import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Folio bundles its skills under resources/skills/. On every launch we copy
 * them into a stable workspace directory and use that as the cwd we hand to
 * the Claude Agent SDK — Claude Code auto-discovers skills from
 * `<cwd>/.claude/skills/`.
 *
 * Why copy on every launch (vs once on install):
 *   bundled skills are the source of truth and may change with each Folio
 *   release. Overwriting on each launch keeps users on the shipped version
 *   without surprise stale skills if they previously had an old build.
 *
 * Why a workspace dir instead of `~/.claude/skills/`:
 *   if we put them user-global, they'd appear in every other Claude Code
 *   session the user runs (e.g., when coding in a terminal). Project-scoped
 *   keeps them isolated to Folio.
 */

const SKILL_PREFIX = 'folio-'; // namespacing for any future global install fallback

export interface SkillsWorkspace {
  /** cwd we pass to Claude Agent SDK so skills get auto-discovered */
  cwd: string;
  /** Number of skills successfully installed */
  installed: number;
}

export function installBundledSkills(): SkillsWorkspace {
  const userDataPath = app.getPath('userData');
  const workspacePath = path.join(userDataPath, 'folio-workspace');
  const targetSkillsDir = path.join(workspacePath, '.claude', 'skills');

  fs.mkdirSync(targetSkillsDir, { recursive: true });

  const bundledSkillsDir = resolveBundledSkillsDir();
  if (!bundledSkillsDir) {
    console.warn('[SkillsInstaller] No bundled skills found — running without skills');
    return { cwd: workspacePath, installed: 0 };
  }

  let installed = 0;
  for (const entry of fs.readdirSync(bundledSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledSkillsDir, entry.name);
    const dst = path.join(targetSkillsDir, entry.name);
    try {
      // Wipe and re-copy — the bundled version always wins so users get
      // the latest skill content with each Folio update without leftover
      // files from a previous version.
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      copyDirRecursive(src, dst);
      installed++;
    } catch (err) {
      console.error(`[SkillsInstaller] Failed to install skill "${entry.name}":`, err);
    }
  }

  console.log(`[SkillsInstaller] Installed ${installed} skill(s) to ${targetSkillsDir}`);
  return { cwd: workspacePath, installed };
}

function resolveBundledSkillsDir(): string | null {
  // In packaged builds resources live under process.resourcesPath; in dev
  // they live two levels above the compiled main.js (dist/main → repo root).
  const candidates = [
    path.join(process.resourcesPath ?? '', 'skills'),
    path.join(__dirname, '..', '..', 'resources', 'skills'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {}
  }
  return null;
}

function copyDirRecursive(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// Silence the unused warning in case we re-enable user-global skills later.
void SKILL_PREFIX;
