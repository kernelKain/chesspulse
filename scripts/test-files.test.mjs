import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverTestFiles, testFileOfEvent } from './test-files.mjs';

const base = mkdtempSync(path.join(os.tmpdir(), 'chesspulse-test-files-'));
after(() => rmSync(base, { recursive: true, force: true }));

describe('discoverTestFiles', () => {

  it('finds nested tests under every root and ignores other files', () => {
    mkdirSync(path.join(base, 'dist-electron', 'main', 'analysis'), { recursive: true });
    mkdirSync(path.join(base, 'dist-renderer-test', 'renderer'), { recursive: true });
    mkdirSync(path.join(base, 'scripts', 'e2e'), { recursive: true });
    writeFileSync(path.join(base, 'dist-electron', 'main', 'analysis', 'pgn.test.js'), '');
    writeFileSync(path.join(base, 'dist-electron', 'main', 'helpers.js'), '');
    writeFileSync(path.join(base, 'dist-renderer-test', 'renderer', 'Review.test.js'), '');
    writeFileSync(path.join(base, 'scripts', 'copy-check.test.mjs'), '');
    writeFileSync(path.join(base, 'scripts', 'copy-check.mjs'), '');
    writeFileSync(path.join(base, 'scripts', 'e2e', 'electron.test.mjs'), '');

    assert.deepEqual(discoverTestFiles(base), [
      path.join(base, 'dist-electron', 'main', 'analysis', 'pgn.test.js'),
      path.join(base, 'dist-renderer-test', 'renderer', 'Review.test.js'),
      path.join(base, 'scripts', 'copy-check.test.mjs'),
    ]);
  });

  it('fails loudly when a compiled root is missing', () => {
    assert.throws(
      () => discoverTestFiles(base, [{ directory: 'dist-missing', extension: '.test.js' }]),
      /Test root dist-missing is missing/,
    );
  });
});

describe('testFileOfEvent', () => {
  it('ignores the synthetic file wrapper and counts a real test', () => {
    const file = path.join(base, 'dist-electron', 'main', 'example.test.js');
    assert.equal(
      testFileOfEvent({ type: 'test:pass', data: { file, name: 'example.test.js' } }),
      null,
    );
    assert.equal(
      testFileOfEvent({ type: 'test:pass', data: { file, name: file } }),
      null,
    );
    assert.equal(
      testFileOfEvent({ type: 'test:pass', data: { file, name: 'adds two numbers' } }),
      file,
    );
  });

  it('ignores events that are not a test result', () => {
    const file = path.join(base, 'dist-electron', 'main', 'example.test.js');
    assert.equal(testFileOfEvent({ type: 'test:start', data: { file, name: 'case' } }), null);
  });
});
