#!/usr/bin/env node
// Static i18n check for the renderer:
//   1. every literal t('key') used in src/renderer resolves in BOTH uk and en;
//   2. every key defined in a strings file is used somewhere (dead keys);
//   3. no Cyrillic text remains in renderer source outside i18n/strings —
//      i.e. nothing slipped past the translation layer.
// Exit code 1 on any hard failure (missing keys, stray Cyrillic).
// Usage: node scripts/check-i18n.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

// fileURLToPath, not URL.pathname — the project folder has a non-ASCII name
// and pathname would leave it percent-encoded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'src', 'renderer');
const stringsDir = path.join(rendererDir, 'i18n', 'strings');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── 1. Load every strings bundle (TS → evaluate via esbuild) ─────────────
const bundles = {};
const stringFiles = fs.existsSync(stringsDir) ? fs.readdirSync(stringsDir).filter(f => f.endsWith('.ts')) : [];
for (const f of stringFiles) {
  const full = path.join(stringsDir, f);
  const result = await build({ entryPoints: [full], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  const code = result.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const bundle = mod.default;
  if (!bundle || typeof bundle !== 'object' || !bundle.uk || !bundle.en) {
    console.error(`✗ ${f}: default export must be { uk: {...}, en: {...} }`);
    process.exitCode = 1;
    continue;
  }
  bundles[f] = bundle;
}

const uk = {}, en = {}, owner = {};
for (const [f, b] of Object.entries(bundles)) {
  for (const k of Object.keys(b.uk)) {
    if (k in owner) { console.error(`✗ duplicate key "${k}" in ${f} and ${owner[k]}`); process.exitCode = 1; }
    owner[k] = f;
  }
  Object.assign(uk, b.uk);
  Object.assign(en, b.en);
}
for (const k of Object.keys(uk)) if (!(k in en)) { console.error(`✗ key "${k}" (${owner[k]}) missing in en`); process.exitCode = 1; }
for (const k of Object.keys(en)) if (!(k in uk)) { console.error(`✗ key "${k}" defined in en but not in uk`); process.exitCode = 1; }

// ── 2. Scan usages ───────────────────────────────────────────────────────
const sources = walk(rendererDir).filter(p => !p.startsWith(path.join(rendererDir, 'i18n')));
const used = new Set();
const missing = [];
const cyrillic = [];
const keyRe = /\bt\(\s*(['"])([^'"`]+)\1/g;
const prefixRe = /\bt\(\s*`([^`$]+)\$\{/g; // dynamic keys: t(`confirm.tool.${name}`) — check the prefix has members

for (const file of sources) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(keyRe)) {
    used.add(m[2]);
    if (!(m[2] in uk)) missing.push(`${rel}: t('${m[2]}')`);
  }
  for (const m of text.matchAll(prefixRe)) {
    const prefix = m[1];
    const members = Object.keys(uk).filter(k => k.startsWith(prefix));
    if (members.length === 0) missing.push(`${rel}: dynamic t(\`${prefix}\${…}\`) — no keys start with "${prefix}"`);
    for (const k of members) used.add(k);
  }
  text.split('\n').forEach((line, i) => {
    // `// i18n-ok` marks a deliberate literal (e.g. an endonym in a language picker).
    if (/[Ѐ-ӿ]/.test(line) && !line.includes('i18n-ok')) cyrillic.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}

if (missing.length) {
  console.error(`✗ ${missing.length} t() key(s) not defined:`);
  for (const m of missing) console.error('   ' + m);
  process.exitCode = 1;
}
const dead = Object.keys(uk).filter(k => !used.has(k));
if (dead.length) {
  console.warn(`! ${dead.length} unused key(s):`);
  for (const k of dead) console.warn(`   ${k} (${owner[k]})`);
}
if (cyrillic.length) {
  console.error(`✗ Cyrillic text outside i18n/strings (${cyrillic.length} line(s)):`);
  for (const c of cyrillic) console.error('   ' + c);
  process.exitCode = 1;
}

console.log(`${process.exitCode ? 'FAILED' : 'OK'} — ${Object.keys(uk).length} keys in ${stringFiles.length} bundle(s), ${used.size} used, ${sources.length} source files scanned`);
