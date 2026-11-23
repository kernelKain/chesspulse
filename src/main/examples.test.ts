import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { exampleOutcome } from '../shared/session-list.js';
import { exampleRoot, readExampleLibrary, sessionRootFor } from './examples.js';
import { listSessionSummaries, openStoredSession, summarizeSessions } from './session-library.js';
import { createSession } from './store.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-examples-'));
  roots.push(root);
  return root;
}

const PASSED_ID = '01M829E6SVWDNHB7XH84E4TAZB';
const REFUSED_ID = '01M82X8MPPR67CS08YQGKP5QR1';
// Tests run from the checkout root, where the shipped examples live.
const SHIPPED = path.join(process.cwd(), 'demo');

describe('example library', () => {
  it('lists only session-id folders that hold a meta.json', () => {
    const root = useRoot();
    mkdirSync(path.join(root, 'sessions', PASSED_ID), { recursive: true });
    writeFileSync(path.join(root, 'sessions', PASSED_ID, 'meta.json'), '{}');
    mkdirSync(path.join(root, 'sessions', REFUSED_ID), { recursive: true });
    mkdirSync(path.join(root, 'sessions', 'not-a-session'), { recursive: true });
    writeFileSync(path.join(root, 'sessions', 'not-a-session', 'meta.json'), '{}');
    assert.deepEqual([...readExampleLibrary(root).ids], [PASSED_ID]);
  });

  it('treats a missing example folder as no examples', () => {
    assert.equal(readExampleLibrary(path.join(useRoot(), 'absent')).ids.size, 0);
  });

  it('reads examples from the example root and every other id from the data folder', () => {
    const library = { root: '/examples', ids: new Set([PASSED_ID]) };
    const rootFor = sessionRootFor(library, () => '/data');
    assert.equal(rootFor(PASSED_ID), '/examples');
    assert.equal(rootFor(REFUSED_ID), '/data');
  });

  it('resolves the checkout in development and resources when packaged', () => {
    assert.equal(exampleRoot({ isPackaged: false, getAppPath: () => '/repo' }, '/res'), path.join('/repo', 'demo'));
    assert.equal(exampleRoot({ isPackaged: true, getAppPath: () => '/repo' }, '/res'), path.join('/res', 'demo'));
  });

  it('leaves an example out of the player list when the data folder also holds it', async () => {
    const root = useRoot();
    const own = await createSession(root, { startedAtEpochMs: 1_700_000_000_000, startAnchor: { monoUs: 0, epochMs: 1_700_000_000_000 } });
    const listed = await listSessionSummaries(root, new Set([own.id]));
    assert.deepEqual(listed.sessions, []);
  });
});

describe('shipped example sessions', () => {
  it('ship exactly the passed and the refused session', () => {
    assert.deepEqual([...readExampleLibrary(SHIPPED).ids].sort(), [PASSED_ID, REFUSED_ID]);
  });

  it('carry the outcomes and figures the cards show', async () => {
    const { sessions, unreadable } = await summarizeSessions(SHIPPED, [PASSED_ID, REFUSED_ID]);
    assert.equal(unreadable, 0);
    const passed = sessions.find((session) => session.id === PASSED_ID);
    const refused = sessions.find((session) => session.id === REFUSED_ID);
    assert.ok(passed && refused);
    assert.equal(exampleOutcome(passed), 'built');
    assert.equal(Math.floor(passed.coveragePct ?? -1), 88);
    assert.equal(exampleOutcome(refused), 'withheld');
    assert.equal(Math.floor(refused.coveragePct ?? -1), 9);
  });

  it('open from the read-only folder without writing to it', async () => {
    const before = readdirSync(path.join(SHIPPED, 'sessions'), { recursive: true }).sort();
    const opened = await openStoredSession(SHIPPED, PASSED_ID);
    assert.equal(opened.reportError, null);
    assert.ok(opened.report);
    assert.ok(opened.games.length > 0);
    const refused = await openStoredSession(SHIPPED, REFUSED_ID);
    assert.equal(refused.report, null);
    assert.deepEqual(readdirSync(path.join(SHIPPED, 'sessions'), { recursive: true }).sort(), before);
  });
});
