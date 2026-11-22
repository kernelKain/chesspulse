import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Report } from '../shared/contracts.js';
import { createSession, saveGames, saveMeta, saveReport } from './store.js';
import { listSessionSummaries, openStoredSession } from './session-library.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-library-'));
  roots.push(root);
  return root;
}

async function makeSession(
  root: string,
  epochMs: number,
  durationMs: number,
  coveragePct: number | null,
): Promise<string> {
  const anchor = { monoUs: 0, epochMs };
  const meta = await createSession(root, { startedAtEpochMs: epochMs, startAnchor: anchor });
  await saveMeta(root, {
    ...meta,
    stopAnchor: { monoUs: durationMs * 1_000, epochMs: epochMs + durationMs },
    stopReason: 'user',
    ...(coveragePct === null
      ? {}
      : {
          coverage: {
            usableUs: durationMs * 1_000 * (coveragePct / 100),
            totalUs: durationMs * 1_000,
            pct: coveragePct,
            confidenceFloor: 50,
          },
        }),
  });
  return meta.id;
}

describe('session library', () => {
  it('lists newest first with duration, coverage, and report presence', async () => {
    const root = useRoot();
    const older = await makeSession(root, 1_700_000_000_000, 60_000, 75);
    const newer = await makeSession(root, 1_700_003_600_000, 120_000, null);
    await saveReport(root, older, '{}');

    const result = await listSessionSummaries(root);
    assert.equal(result.unreadable, 0);
    assert.deepEqual(
      result.sessions.map((session) => session.id),
      [newer, older],
    );
    assert.deepEqual(result.sessions[1], {
      id: older,
      startedAtEpochMs: 1_700_000_000_000,
      durationMs: 60_000,
      coveragePct: 75,
      hasReport: true,
    });
    assert.equal(result.sessions[0].hasReport, false);
    assert.equal(result.sessions[0].coveragePct, null);
  });

  it('counts an unreadable session without hiding the others', async () => {
    const root = useRoot();
    const good = await makeSession(root, 1_700_000_000_000, 10_000, 50);
    const broken = await makeSession(root, 1_700_000_001_000, 10_000, 50);
    await writeFile(path.join(root, 'sessions', broken, 'meta.json'), '{', 'utf8');

    const result = await listSessionSummaries(root);
    assert.equal(result.unreadable, 1);
    assert.deepEqual(result.sessions.map((session) => session.id), [good]);
  });

  it('opens games when there is no report', async () => {
    const root = useRoot();
    const id = await makeSession(root, 1_700_000_000_000, 10_000, 50);
    await saveGames(root, id, ['[Event "first"]']);

    const opened = await openStoredSession(root, id);
    assert.equal(opened.report, null);
    assert.equal(opened.reportError, null);
    assert.deepEqual(opened.games, ['[Event "first"]']);
  });

  it('keeps games reachable when a stored report is invalid, and names the reason', async () => {
    const root = useRoot();
    const id = await makeSession(root, 1_700_000_000_000, 10_000, 50);
    await saveGames(root, id, ['[Event "first"]']);
    await saveReport(root, id, '{}');

    const opened = await openStoredSession(root, id);
    assert.equal(opened.report, null);
    assert.equal(opened.reportError, 'invalid');
    assert.deepEqual(opened.games, ['[Event "first"]']);
  });

  it('opens a valid stored report at Review', async () => {
    const root = useRoot();
    const id = await makeSession(root, 1_700_000_000_000, 10_000, 50);
    const report: Report = {
      ok: true,
      schemaVersion: 1,
      sessionId: id,
      gamesDigest: 'a'.repeat(64),
      coveragePct: 50,
      baselineBpm: 70,
      verdict: 'One steady game.',
      settled: { band: 'settled', moves: 0, status: 'insufficient' },
      elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
      engine: {
        depth: 8,
        positions: 0,
        scored: 0,
        failed: 0,
        reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
      },
      alignmentMode: 'endtime',
      toleranceSec: 5,
      games: [],
      timeline: {
        startUs: 0,
        stopUs: 10_000_000,
        baselineBpm: 70,
        elevatedThresholdBpm: 80,
        samples: [],
        games: [],
        moves: [],
      },
    };
    await saveReport(root, id, JSON.stringify(report));

    const opened = await openStoredSession(root, id);
    assert.equal(opened.reportError, null);
    assert.equal(opened.report?.verdict, 'One steady game.');
    assert.deepEqual(opened.games, []);
  });
});
