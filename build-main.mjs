import { build } from 'esbuild';
import fs from 'fs';

// Build-time secrets. `.env` (git-ignored) for local builds, real env vars in
// CI (GitHub secret GROQ_API_KEY). Only the main process gets them — never
// the renderer bundle.
function loadDotEnv(file = '.env') {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const dotenv = loadDotEnv();
const groqKey = process.env.GROQ_API_KEY || dotenv.GROQ_API_KEY || '';
if (!groqKey) {
  const onCi = process.env.GITHUB_ACTIONS === 'true';
  const isReleaseTag = (process.env.GITHUB_REF ?? '').startsWith('refs/tags/v');
  const hint = 'Add the GROQ_API_KEY repository secret (Settings → Secrets and variables → Actions), then re-run this workflow.';
  // A release must not silently ship without voice input. Set
  // FOLIO_ALLOW_NO_VOICE=1 to build a tag without it on purpose.
  if (onCi && isReleaseTag && process.env.FOLIO_ALLOW_NO_VOICE !== '1') {
    console.error(`::error title=GROQ_API_KEY secret is missing::Release builds need the speech-recognition key. ${hint}`);
    process.exit(1);
  }
  if (onCi) console.log(`::warning title=Voice input disabled in this build::GROQ_API_KEY is not set. ${hint}`);
  console.warn('[build] GROQ_API_KEY not set — voice input will be unavailable in this build');
}

// The Claude Agent SDK is ESM and calls createRequire(import.meta.url) at
// load time. In a CJS bundle import.meta.url would be undefined and the
// import would throw, so point it at the bundle file itself.
export const importMetaShim = {
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
};

// Build main process
await build({
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: 'dist/main/main.js',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  banner: importMetaShim.banner,
  define: {
    ...importMetaShim.define,
    'process.env.FOLIO_GROQ_API_KEY': JSON.stringify(groqKey),
  },
});

// Build preload (separate because it runs in renderer context)
await build({
  entryPoints: ['src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: 'dist/main/preload.js',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});

console.log(`Build complete${groqKey ? ' (voice: built-in Groq key)' : ''}`);
