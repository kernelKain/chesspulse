// What: finds every compiled test file instead of keeping a hand-written list.
// Why: a new test file used to be skipped silently until someone remembered to add it
//      to `package.json` (BUG-30). Discovery makes the file system the source of truth.
// Removed: `npm test` would go back to running only the files listed by hand.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const TEST_ROOTS = [
  { directory: 'dist-electron', extension: '.test.js', recursive: true },
  { directory: 'dist-renderer-test', extension: '.test.js', recursive: true },
  // The Electron suite lives in `scripts/e2e` and is run by `test:e2e`, not the fast suite.
  { directory: 'scripts', extension: '.test.mjs', recursive: false },
];

function walk(directory, extension, recursive, found) {
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    if (recursive && statSync(full).isDirectory()) {
      walk(full, extension, recursive, found);
    } else if (name.endsWith(extension)) {
      found.push(full);
    }
  }
}

export function discoverTestFiles(baseDirectory, roots = TEST_ROOTS) {
  const found = new Set();
  for (const { directory, extension, recursive } of roots) {
    const root = path.join(baseDirectory, directory);
    if (!existsSync(root)) {
      throw new Error(
        `Test root ${directory} is missing. Run the TypeScript build before the tests.`,
      );
    }
    const files = [];
    walk(root, extension, recursive, files);
    for (const file of files) found.add(path.resolve(file));
  }
  return [...found].sort();
}

/**
 * A file-level event is a wrapper around the file, not a registered test. Node emits one even for
 * an empty file, so counting it would let a compiled test with no tests pass.
 */
export function testFileOfEvent(event) {
  if (event?.type !== 'test:pass' && event?.type !== 'test:fail') return null;
  const file = event.data?.file;
  const name = event.data?.name;
  if (typeof file !== 'string' || typeof name !== 'string') return null;
  if (name === file || name === path.basename(file)) return null;
  return path.resolve(file);
}
