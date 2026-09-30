#!/usr/bin/env node
// Guard for the bug that shipped in 1.0.0: one tool schema the SDK could not
// convert to JSON Schema made `tools/list` fail for the whole Finmap MCP
// server, so Claude saw no Finmap tools at all — and neither tsc nor the
// build noticed.
//
// This bundles the real server exactly like the app does (electron stubbed),
// asks it for its tool list over the same local HTTP endpoint the CLI uses,
// and fails if the list errors or a tool Folio relies on is missing.
// Usage: node scripts/check-mcp-tools.mjs   (npm run check:tools)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-check-tools-'));
const stub = path.join(tmp, 'electron-stub.cjs');
const entry = path.join(root, 'src', 'main', '__check-mcp-tools.entry.ts');
const out = path.join(tmp, 'check.cjs');

fs.writeFileSync(stub, `
const os = require('os');
module.exports = {
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-check', isPackaged: false },
  shell: { showItemInFolder() {}, openExternal: async () => {} },
};`);

fs.writeFileSync(entry, `
import { McpHttpHost } from './mcp-http-host';
import { buildFinmapMcpServer, MUTATION_TOOLS } from './mcp-tools';
import { FinmapAPI } from './finmap-api';

const REQUIRED = ['get_accounts', 'get_operations', 'summarize_operations', 'create_operation', 'patch_operation', 'http_request', 'add_mcp_server', 'reconcile_match'];

(async () => {
  const host = new McpHttpHost();
  const route = await host.register(async () => (await buildFinmapMcpServer(new FinmapAPI('check'), undefined, 'check')).instance as any);
  const res = await fetch(route.config.url, {
    method: 'POST',
    headers: { ...route.config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body: any = await res.json();
  host.stop();
  if (body.error) {
    console.error('✗ tools/list failed: ' + body.error.message);
    console.error('  One tool has a schema the SDK cannot convert (z.record() is a known offender). Claude would see NO Finmap tools.');
    process.exit(1);
  }
  const names: string[] = body.result.tools.map((t: any) => t.name);
  const missing = REQUIRED.filter(n => !names.includes(n));
  const unknownMutations = [...MUTATION_TOOLS].map(t => t.replace('mcp__finmap__', '')).filter(n => !names.includes(n));
  if (missing.length) { console.error('✗ missing tools: ' + missing.join(', ')); process.exit(1); }
  if (unknownMutations.length) { console.error('✗ MUTATION_TOOLS lists tools that do not exist: ' + unknownMutations.join(', ')); process.exit(1); }
  for (const t of body.result.tools) {
    if (t.inputSchema?.type !== 'object') { console.error('✗ ' + t.name + ': input schema is not an object'); process.exit(1); }
  }
  console.log('OK — tools/list returns ' + names.length + ' tools, all schemas convert');
  process.exit(0);
})().catch((e) => { console.error('✗ check failed:', e); process.exit(1); });
`);

let code = 1;
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: out,
    alias: { electron: stub },
    banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': '__importMetaUrl' },
    logLevel: 'warning',
  });
  const { spawnSync } = await import('child_process');
  const run = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  code = run.status ?? 1;
} finally {
  fs.rmSync(entry, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
