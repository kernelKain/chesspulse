import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withReportExclusion } from './report-lock.js';

describe('withReportExclusion', () => {
  it('keeps paired artifact reads outside an in-progress rebuild', async () => {
    let releaseBuild: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const events: string[] = [];
    const build = withReportExclusion(async () => {
      events.push('build:start');
      await gate;
      events.push('build:end');
    });
    await Promise.resolve();
    const read = withReportExclusion(async () => {
      events.push('read:both');
    });
    await Promise.resolve();
    assert.deepEqual(events, ['build:start']);
    releaseBuild();
    await Promise.all([build, read]);
    assert.deepEqual(events, ['build:start', 'build:end', 'read:both']);
  });

  it('releases the exclusion after a failed build', async () => {
    await assert.rejects(withReportExclusion(async () => {
      throw new Error('build failed');
    }), /build failed/);
    assert.equal(await withReportExclusion(async () => 'read completed'), 'read completed');
  });
});
