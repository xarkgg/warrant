/**
 * The pre-flight gate.
 *
 * `node --check` only looks at one file and misses duplicate top-level
 * declarations across a module's imports; a plain test run on a broken file
 * reports a parse error with no context. This walks every source file we ship,
 * parses it with esbuild (the same parser Forge's bundler uses) and prints the
 * file and line for anything it cannot read.
 *
 * It exists because a duplicate `const` once reached CI in a test file that the
 * typechecker did not cover.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = ['src', 'tests', 'scripts', 'static/ui', 'video'];
const SKIP = new Set(['vendor', 'node_modules', 'out', 'stills']);

// `video/` holds TSX compositions, which the same parser reads with the tsx
// loader. They are the only files here that are not JavaScript.
const LOADERS = { '.ts': 'ts', '.tsx': 'tsx' };

function walk(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) walk(path, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs') || entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(join(repo, root)));
const failures = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const extension = file.slice(file.lastIndexOf('.'));
  try {
    await transform(source, {
      loader: LOADERS[extension] || 'js',
      format: 'esm',
      sourcefile: file,
    });
  } catch (error) {
    const where = relative(repo, file);
    const first = error.errors && error.errors[0];
    failures.push(
      first
        ? `${where}:${first.location?.line ?? '?'}  ${first.text}`
        : `${where}  ${error.message}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} file(s) do not parse:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`parsed ${files.length} files`);
