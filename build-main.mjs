import { build } from 'esbuild';

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

console.log('Build complete');
