import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIAGNOSTICS_LOG_LINES, buildDiagnostics } from './diagnostics.js';

describe('diagnostics bundle', () => {
  it('carries metadata, the doctor result, and at most the last 100 log lines', () => {
    const logLines = Array.from({ length: 130 }, (_value, index) => `log line ${index}`);
    const text = buildDiagnostics({
      appVersion: '0.1.2',
      electron: '45.4.1',
      node: '26.6.6',
      platform: 'linux',
      arch: 'x64',
      doctor: ['SmartSpectra key: present', 'Stockfish: ok'],
      logLines,
      now: new Date('2026-11-22T10:00:00.000Z'),
    });

    assert.match(text, /^ChessPulse diagnostics\n/);
    assert.match(text, /Generated: 2026-11-22T10:00:00\.000Z/);
    assert.match(text, /App version: 0\.1\.2/);
    assert.match(text, /Electron: 45\.4\.1/);
    assert.match(text, /Node: 26\.6\.6/);
    assert.match(text, /Platform: linux x64/);
    assert.match(text, /SmartSpectra key: present/);
    assert.match(text, /Stockfish: ok/);

    const included = text.split('\n').filter((line) => line.startsWith('  log line '));
    assert.equal(included.length, DIAGNOSTICS_LOG_LINES);
    assert.match(included[0] ?? '', /log line 30$/);
    assert.match(included.at(-1) ?? '', /log line 129$/);
  });

  it('says the doctor has not run rather than inventing a result', () => {
    const text = buildDiagnostics({
      appVersion: '0.1.2',
      electron: '45.4.1',
      node: '26.6.6',
      platform: 'linux',
      arch: 'x64',
      doctor: [],
      logLines: [],
      now: new Date('2026-11-22T10:00:00.000Z'),
    });
    assert.match(text, /Doctor\n {2}Not run\./);
    assert.match(text, /No log lines yet\./);
  });

  it('keeps one line per field even if a source value contains newlines', () => {
    const text = buildDiagnostics({
      appVersion: '0.1.2\ninjected',
      electron: '45.4.1',
      node: '26.6.6',
      platform: 'linux',
      arch: 'x64',
      doctor: ['first\nsecond'],
      logLines: ['log\r\nline'],
      now: new Date('2026-11-22T10:00:00.000Z'),
    });
    assert.match(text, /App version: 0\.1\.2 injected/);
    assert.match(text, /first second/);
    assert.match(text, / {2}log line/);
    assert.ok(!text.includes('\r'));
  });

  it('removes PGN headers and pulse-sample lines before delivery', () => {
    const text = buildDiagnostics({
      appVersion: '0.1.2',
      electron: '45.4.1',
      node: '26.6.6',
      platform: 'linux',
      arch: 'x64',
      doctor: ['[Event "Club game"]'],
      logLines: [
        'ordinary line stays',
        '[White "Ada"] [Black "Nim"]',
        '{"tUs":100,"bpm":72,"confidence":80,"stable":true}',
      ],
      now: new Date('2026-11-22T10:00:00.000Z'),
    });
    assert.match(text, /ordinary line stays/);
    assert.ok(!text.includes('[White "Ada"]'));
    assert.ok(!text.includes('"bpm":72'));
    assert.match(text, /\[redacted line\]/);
  });
});
