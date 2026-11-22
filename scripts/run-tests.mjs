// What: the single test entry point. It discovers every compiled test, runs it, and reports how
//      many files actually executed.
// Why: BUG-30 was a hand-written file list that silently skipped new tests. The count check also
//      catches a compiled file that registers no tests, which would otherwise look like success.
// Removed: `npm test` would run only named files and could pass while skipping suites.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { discoverTestFiles, testFileOfEvent } from './test-files.mjs';

const files = discoverTestFiles(process.cwd());
console.log(`Discovered ${files.length} test files.`);
if (files.length === 0) {
  console.error('No test files were found. The TypeScript build did not produce any.');
  process.exit(1);
}

const seenFiles = new Set();
let failures = 0;

const stream = run({ files });
stream.on('data', (event) => {
  const file = testFileOfEvent(event);
  if (file) seenFiles.add(file);
  if (event.type === 'test:fail') failures += 1;
});
stream.on('end', () => {
  const missing = files.filter((file) => !seenFiles.has(file));
  console.log(`Ran ${seenFiles.size} of ${files.length} test files.`);
  if (missing.length > 0) {
    console.error('Test files that registered no tests:');
    for (const file of missing) console.error(`  ${file}`);
    process.exitCode = 1;
  }
  if (failures > 0) process.exitCode = 1;
});
stream.compose(new spec()).pipe(process.stdout);
