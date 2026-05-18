#!/usr/bin/env node
/**
 * Download `uv` (and bundled `uvx`) from Astral's GitHub releases for every
 * platform/arch Folio ships on, extract them, and drop into
 * `resources/binaries/<plat-arch>/`.
 *
 * Folio's main process prepends that dir to PATH at startup so Python-based
 * MCP servers (`uvx mcp-atlassian`, `uvx mcp-memory`, etc.) work out of the
 * box — without forcing the user to `curl | sh` the Astral installer.
 *
 * Usage:
 *   npm run fetch-binaries        # default version below
 *   UV_VERSION=0.5.18 npm run fetch-binaries
 *
 * Idempotent — re-runs are no-ops if files already exist for that version.
 * Delete `resources/binaries/` to force re-download.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(REPO_ROOT, 'resources', 'binaries');

// Pinned uv version. Bump deliberately and test before changing.
// Latest tagged stable from https://github.com/astral-sh/uv/releases at the
// time of writing. Astral keeps a clean changelog — review before bumping.
const UV_VERSION = process.env.UV_VERSION || '0.5.18';

/**
 * One target = one (platform, arch) we want to ship for. Asset names follow
 * Astral's release convention. Each archive extracts into a subdir named
 * after the asset (e.g. `uv-x86_64-apple-darwin/uv`); we flatten that.
 */
const TARGETS = [
  { plat: 'win32',  arch: 'x64',   asset: 'uv-x86_64-pc-windows-msvc.zip',          files: ['uv.exe', 'uvx.exe'] },
  { plat: 'darwin', arch: 'x64',   asset: 'uv-x86_64-apple-darwin.tar.gz',          files: ['uv', 'uvx'] },
  { plat: 'darwin', arch: 'arm64', asset: 'uv-aarch64-apple-darwin.tar.gz',         files: ['uv', 'uvx'] },
  { plat: 'linux',  arch: 'x64',   asset: 'uv-x86_64-unknown-linux-gnu.tar.gz',     files: ['uv', 'uvx'] },
];

async function downloadFile(url, dest) {
  process.stdout.write(`  ↓ ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/** Extract an archive into destDir. Two formats we encounter:
 *   .zip      → PowerShell's `Expand-Archive` on Windows (built-in, reliable),
 *               `unzip` on Unix.
 *   .tar.gz   → `tar` everywhere (bundled on Win10+, all Macs, all Linux).
 *
 *  We `cd` into destDir and use basename — `bsdtar` on Windows treats absolute
 *  paths like `C:\...` as remote hosts and fails. */
function extractArchive(archivePath, destDir) {
  const archiveName = path.basename(archivePath);
  const isZip = /\.zip$/i.test(archiveName);

  if (isZip) {
    if (process.platform === 'win32') {
      // PowerShell is always there on Windows 7+. -Force overwrites existing.
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archiveName}' -DestinationPath . -Force"`,
        { stdio: 'inherit', cwd: destDir }
      );
    } else {
      execSync(`unzip -oq "${archiveName}"`, { stdio: 'inherit', cwd: destDir });
    }
    return;
  }

  // .tar.gz / .tgz
  execSync(`tar -xf "${archiveName}"`, { stdio: 'inherit', cwd: destDir });
}

async function fetchOne(t) {
  const dirName = `${t.plat}-${t.arch}`;
  const targetDir = path.join(BINARIES_DIR, dirName);
  fs.mkdirSync(targetDir, { recursive: true });

  // Skip if every expected binary is already there
  const allPresent = t.files.every(f => fs.existsSync(path.join(targetDir, f)));
  if (allPresent) {
    console.log(`✓ ${dirName} — already present, skip`);
    return;
  }

  console.log(`→ ${dirName} (uv ${UV_VERSION})`);
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${t.asset}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-uv-'));
  const archivePath = path.join(tmpDir, t.asset);

  try {
    await downloadFile(url, archivePath);
    extractArchive(archivePath, tmpDir);

    // Archive extracts into a subdir named like the asset (sans extension)
    const extractedSubdir = t.asset.replace(/\.(zip|tar\.gz|tgz)$/i, '');

    for (const f of t.files) {
      const candidates = [
        path.join(tmpDir, extractedSubdir, f),
        path.join(tmpDir, f),
      ];
      const src = candidates.find(p => fs.existsSync(p));
      if (!src) {
        throw new Error(`Couldn't find "${f}" after extracting ${t.asset}. Looked in: ${candidates.join(', ')}`);
      }
      const dst = path.join(targetDir, f);
      fs.copyFileSync(src, dst);
      if (t.plat !== 'win32') {
        try { fs.chmodSync(dst, 0o755); } catch {}
      }
    }
    console.log(`✓ ${dirName}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  console.log(`Fetching uv ${UV_VERSION} into ${BINARIES_DIR}\n`);
  for (const t of TARGETS) await fetchOne(t);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\n✗ Fetch failed:', err.message);
  process.exit(1);
});
