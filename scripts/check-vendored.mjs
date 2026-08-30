// `src/lib/` is a port of week-dashboard's scheduling engine, and the rule has
// always been that it is not edited here — a bug fixed in one place has to be
// fixed in the other, and silent drift is how two copies of an engine stop
// being the same engine.
//
// That rule used to be enforced by running `diff -rq` by hand on every commit.
// Three files have since been *removed*: `ics.ts`, `skeleton.ts` and
// `shell.ts` were unreachable from plugin code and appeared zero times in the
// bundle, but their `fetch` calls and Electron bridge types were flagged in
// the directory's review — dead weight a reviewer still has to read.
//
// So the invariant is no longer "identical trees". It is: **every file we
// kept is byte-for-byte what it was, and nothing new has appeared.** Deleting
// is allowed and recorded below; editing is not. That is a weaker rule than
// before, which is exactly why it now runs automatically instead of being
// remembered.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const here = path.resolve(__dirname, '..', 'src', 'lib');
const SOURCE = process.env.WEEKFIT_LIB_SOURCE ?? 'C:/Users/tyler/week-dashboard/src/lib';

/**
 * Ported files deliberately not kept, with the reason. A file may only be on
 * this list because it is unreachable from plugin code — never because it was
 * inconvenient.
 */
const DROPPED = {
  'ics.ts': 'calendar fetch over the network; unreachable here, and Obsidian wants requestUrl',
  'skeleton.ts': 'YAML config the desktop app kept on disk; superseded by plugin settings',
  'shell.ts': 'Electron preload bridge; nothing in an Obsidian plugin can call it',
};

function filesIn(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = entry.name;
    if (entry.isDirectory()) {
      for (const nested of filesIn(path.join(dir, rel))) out.push(path.join(rel, nested));
    } else {
      out.push(rel);
    }
  }
  return out;
}

let sourceFiles;
try {
  statSync(SOURCE);
  sourceFiles = filesIn(SOURCE);
} catch {
  console.log(`Vendored check skipped: no source tree at ${SOURCE}`);
  process.exit(0);
}

const ours = new Set(filesIn(here));
const problems = [];

for (const file of sourceFiles) {
  if (!ours.has(file)) {
    if (!(file in DROPPED)) {
      problems.push(`missing (and not on the dropped list): ${file}`);
    }
    continue;
  }
  const a = readFileSync(path.join(SOURCE, file));
  const b = readFileSync(path.join(here, file));
  if (!a.equals(b)) problems.push(`EDITED: ${file}`);
}

for (const file of ours) {
  if (!sourceFiles.includes(file)) problems.push(`added, not from the port: ${file}`);
}

for (const [file, why] of Object.entries(DROPPED)) {
  if (ours.has(file)) problems.push(`on the dropped list but still present: ${file} (${why})`);
}

if (problems.length) {
  console.error('src/lib has drifted from its source:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const kept = sourceFiles.length - Object.keys(DROPPED).length;
console.log(`src/lib: ${kept}/${sourceFiles.length} ported files, all byte-identical.`);
console.log(`dropped ${Object.keys(DROPPED).length}: ${Object.keys(DROPPED).join(', ')}`);
