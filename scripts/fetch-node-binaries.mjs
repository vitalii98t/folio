#!/usr/bin/env node
/**
 * Download Node.js distribution archives from nodejs.org for every
 * platform/arch Folio ships on, extract them, and place into
 * `resources/binaries/<plat-arch>/node/`.
 *
 * Folio's main process adds the platform-appropriate Node bin directory to
 * PATH at startup so MCP servers that need `npx` (Slack, GitHub, Notion,
 * Postgres, Brave Search — the ~70% Node-based MCP ecosystem) work without
 * the user installing Node.js separately.
 *
 * Layout after extraction:
 *   resources/binaries/win32-x64/node/{node.exe, npm.cmd, npx.cmd, node_modules/...}
 *   resources/binaries/darwin-x64/node/{bin/node, bin/npm, bin/npx, lib/node_modules/...}
 *   (same shape for linux-x64 and darwin-arm64)
 *
 * Usage:
 *   npm run fetch-node               # default Node version below
 *   NODE_BUNDLE_VERSION=22.12.0 npm run fetch-node
 *
 * Idempotent — skips targets where node binary already exists. Delete
 * `resources/binaries/<plat-arch>/node/` to force re-download.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(REPO_ROOT, 'resources', 'binaries');

// Pinned LTS. 22 went LTS in Oct 2024, supported through 2027.
// Bump deliberately — every bump must be smoke-tested across platforms.
const NODE_VERSION = process.env.NODE_BUNDLE_VERSION || '22.11.0';

/**
 * `binaryRelative` = path INSIDE the extracted Node tree where the actual
 * executable lives. We sanity-check it after extraction to make sure the
 * archive isn't broken or moved by upstream.
 */
const TARGETS = [
  { plat: 'win32',  arch: 'x64',   archive: ext => `node-v${NODE_VERSION}-win-x64.${ext}`,         ext: 'zip',    binaryRelative: 'node.exe' },
  { plat: 'darwin', arch: 'x64',   archive: ext => `node-v${NODE_VERSION}-darwin-x64.${ext}`,      ext: 'tar.gz', binaryRelative: 'bin/node' },
  { plat: 'darwin', arch: 'arm64', archive: ext => `node-v${NODE_VERSION}-darwin-arm64.${ext}`,    ext: 'tar.gz', binaryRelative: 'bin/node' },
  { plat: 'linux',  arch: 'x64',   archive: ext => `node-v${NODE_VERSION}-linux-x64.${ext}`,       ext: 'tar.xz', binaryRelative: 'bin/node' },
];

async function downloadFile(url, dest) {
  process.stdout.write(`  ↓ ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/** Same extraction rules as fetch-uv-binaries.mjs: PowerShell for zip on
 *  Windows (`tar` there doesn't always grok zip), `tar` for everything else
 *  (covers .tar.gz and .tar.xz on all platforms). We `cd` to destDir and pass
 *  a basename to dodge `bsdtar`'s "C: → remote host" bug on Windows. */
function extractArchive(archivePath, destDir) {
  const archiveName = path.basename(archivePath);
  const isZip = /\.zip$/i.test(archiveName);
  if (isZip) {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archiveName}' -DestinationPath . -Force"`,
        { stdio: 'inherit', cwd: destDir }
      );
    } else {
      execSync(`unzip -oq "${archiveName}"`, { stdio: 'inherit', cwd: destDir });
    }
    return;
  }
  execSync(`tar -xf "${archiveName}"`, { stdio: 'inherit', cwd: destDir });
}

/** Move all entries of `srcDir` into `dstDir`, replacing existing entries.
 *  Used after extraction: archive extracts to `node-vX.Y.Z-<plat>/...`, we
 *  flatten that one level into our `node/` target. */
function moveAll(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dst = path.join(dstDir, entry);
    // On Windows rename across drives can fail — fall back to copy.
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  }
}

async function fetchOne(t) {
  const dirName = `${t.plat}-${t.arch}`;
  const targetDir = path.join(BINARIES_DIR, dirName, 'node');
  const expectedBinary = path.join(targetDir, t.binaryRelative);

  if (fs.existsSync(expectedBinary)) {
    console.log(`✓ ${dirName}/node — already present, skip`);
    return;
  }

  console.log(`→ ${dirName}/node (Node.js ${NODE_VERSION})`);
  const archiveName = t.archive(t.ext);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-node-'));
  const archivePath = path.join(tmpDir, archiveName);

  try {
    await downloadFile(url, archivePath);
    extractArchive(archivePath, tmpDir);

    // Archive extracts to `node-v22.x.x-<plat>-<arch>/...`
    const extractedSubdir = archiveName.replace(/\.(zip|tar\.gz|tar\.xz|tgz)$/i, '');
    const extractedPath = path.join(tmpDir, extractedSubdir);
    if (!fs.existsSync(extractedPath)) {
      throw new Error(`Expected extracted dir not found: ${extractedPath}`);
    }

    // Wipe any previous incomplete attempt
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });
    moveAll(extractedPath, targetDir);

    // Sanity check
    if (!fs.existsSync(expectedBinary)) {
      throw new Error(`After extraction, expected ${expectedBinary} is missing.`);
    }

    // Restore executable bits on Unix — code signing or extraction can drop them.
    if (t.plat !== 'win32') {
      const binDir = path.join(targetDir, 'bin');
      if (fs.existsSync(binDir)) {
        for (const entry of fs.readdirSync(binDir)) {
          try { fs.chmodSync(path.join(binDir, entry), 0o755); } catch {}
        }
      }
    }

    console.log(`✓ ${dirName}/node`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  console.log(`Fetching Node.js ${NODE_VERSION} into ${BINARIES_DIR}\n`);
  for (const t of TARGETS) await fetchOne(t);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\n✗ Fetch failed:', err.message);
  process.exit(1);
});
