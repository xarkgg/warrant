/**
 * Builds `static/ui/vendor/bridge.js` — the one generated asset in the UI.
 *
 * `@forge/bridge` is CommonJS and only exposes its package root, so the four
 * modules the surfaces use are bundled into a single IIFE that assigns
 * `window.forgeBridge`. That is what allows `app.js` to stay plain ES with no
 * build step of its own: `forge deploy` packages `static/` exactly as it is.
 *
 * Run with `npm run build:bridge` after changing the @forge/bridge version.
 * The output is committed, so a deploy never depends on this having run.
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outfile = join(repo, 'static/ui/vendor/bridge.js');

await build({
  entryPoints: [join(repo, 'ui/bridge-entry.js')],
  outfile,
  bundle: true,
  format: 'iife',
  globalName: 'forgeBridge',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const { size } = statSync(outfile);
console.log(`static/ui/vendor/bridge.js  ${(size / 1024).toFixed(1)} KB`);
