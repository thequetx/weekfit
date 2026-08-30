import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Undo only works because every vault write funnels through two helpers in
 * `writer.ts` that record what changed. A new write path that calls Obsidian
 * directly would be invisible to the journal — and an undo that silently
 * misses half a change is worse than no undo at all, because the user will
 * believe it worked.
 *
 * This is the same shape of guard as `anchor-trap.test.ts`: cheap, specific,
 * and it names the offending line.
 */

const WRITER = path.resolve(__dirname, '..', 'src', 'data', 'writer.ts');
/**
 * The one intentional exception. `undo.ts` restores a file to content it
 * captured earlier, and that restore must **not** be journalled — recording it
 * would make the undo itself an undoable step, which is a redo, which this
 * plugin does not have. It reads its own before/after and verifies the file
 * has not moved on, so it carries the same safety the writer does.
 */
const UNDO = path.resolve(__dirname, '..', 'src', 'data', 'undo.ts');
const SRC = path.resolve(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'lib') continue; // vendored, and reads only
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function codeLines(file: string): { n: number; text: string }[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    // Comments discussing these APIs are the point, not violations.
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

describe('every vault write is journalled', () => {
  it('only writer.ts calls Obsidian’s write APIs at all', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === WRITER || file === UNDO) continue;
      for (const { n, text } of codeLines(file)) {
        if (/\bvault\.(process|create|createFolder|modify|delete|trash)\s*\(/.test(text)) {
          offenders.push(`${path.relative(SRC, file)}:${n}  ${text.trim()}`);
        }
        if (/fileManager\.processFrontMatter\s*\(/.test(text)) {
          offenders.push(`${path.relative(SRC, file)}:${n}  ${text.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'Vault writes belong in src/data/writer.ts, which records them for undo.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('inside writer.ts, the raw APIs are only used by the journalled helpers', () => {
    // `processFile` and `createFile` are allowed one raw call each — they are
    // the wrappers. Anything beyond that is a path around the journal.
    const raw = codeLines(WRITER).filter(({ text }) =>
      /\bapp\.vault\.(process|create)\s*\(/.test(text),
    );
    expect(raw.map((r) => `${r.n}  ${r.text.trim()}`)).toHaveLength(2);
  });
});
