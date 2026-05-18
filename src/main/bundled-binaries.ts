import * as fs from 'fs';
import * as path from 'path';

/**
 * Make Folio's bundled runtimes visible to every child process spawned by
 * the Claude Agent SDK. Two flavours of MCP server need this:
 *
 *   1. Python servers (`uvx mcp-atlassian`, `uvx mcp-memory`, …) need `uv`/`uvx`.
 *   2. Node servers (`npx -y @modelcontextprotocol/server-slack`, GitHub, Notion,
 *      Postgres, …) need `node`/`npm`/`npx`.
 *
 * We ship both per-platform. Layout under each `<plat-arch>/`:
 *   • `uv` / `uvx` (or .exe on Windows) at the root
 *   • `node/` subdir with the full Node.js distribution
 *
 * At startup we prepend BOTH the root dir AND `node/bin` (or `node/` on
 * Windows where Node lives flat) to PATH, so child processes find our
 * bundled tooling first regardless of what the user has installed.
 *
 * Must run BEFORE AgentManager spawns its first child.
 */
export function setupBundledBinariesPath(): { baseDir: string; addedPaths: string[] } | null {
  const platArch = `${process.platform}-${process.arch}`;

  // Packaged path is unprefixed because electron-builder's per-platform
  // `extraResources` maps `resources/binaries/<plat-arch>` → `binaries/`.
  const candidates = [
    path.join(process.resourcesPath ?? '', 'binaries'),
    path.join(__dirname, '..', '..', 'resources', 'binaries', platArch),
  ];

  const baseDir = candidates.find(p => {
    try { return p && fs.existsSync(p) && fs.statSync(p).isDirectory(); }
    catch { return false; }
  });

  if (!baseDir) {
    console.warn(`[BundledBinaries] No binaries dir for ${platArch} — bundled MCP runtimes unavailable.`);
    return null;
  }

  const addedPaths: string[] = [];

  // (1) Root dir — holds `uv`/`uvx` from Astral
  addedPaths.push(baseDir);
  ensureExecutable(baseDir);

  // (2) Node.js bin directory — different layout per platform.
  //     Unix archives: `node/bin/{node,npm,npx,...}`
  //     Windows archive: `node/{node.exe,npm.cmd,npx.cmd,...}`
  const nodeRoot = path.join(baseDir, 'node');
  if (fs.existsSync(nodeRoot)) {
    const nodeBin = process.platform === 'win32'
      ? nodeRoot
      : path.join(nodeRoot, 'bin');
    if (fs.existsSync(nodeBin)) {
      addedPaths.push(nodeBin);
      ensureExecutable(nodeBin);
    }
  } else {
    console.warn(`[BundledBinaries] No Node.js bundle at ${nodeRoot} — npx-based MCP servers will need user-side install.`);
  }

  // Prepend (not append): if the user already has `uv`/`node` on PATH,
  // ours still wins. Same trick we use for Claude Code resolution.
  const sep = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = `${addedPaths.join(sep)}${sep}${process.env.PATH ?? ''}`;
  console.log(`[BundledBinaries] PATH prepended with ${addedPaths.length} dir(s): ${addedPaths.join(', ')}`);

  return { baseDir, addedPaths };
}

/**
 * Re-apply the executable bit to every file directly under `dir`. Code
 * signing and some extraction methods can strip it on Unix; on Windows this
 * is a no-op since the OS uses extensions to decide what's runnable.
 */
function ensureExecutable(dir: string) {
  if (process.platform === 'win32') return;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) fs.chmodSync(p, 0o755);
      } catch {}
    }
  } catch {}
}
