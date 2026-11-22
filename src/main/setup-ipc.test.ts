import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DoctorReport } from './doctor.js';
import { setupChecks } from './setup-ipc.js';

const report: DoctorReport = {
  ok: false,
  checks: [
    { id: 'node', label: 'Node', status: 'pass', detail: 'v22.' },
    {
      id: 'sensing-key',
      label: 'SmartSpectra key',
      status: 'fail',
      detail: 'Missing. Set SMARTSPECTRA_API_KEY in .env or the environment.',
    },
  ],
  lines: [],
};

describe('setupChecks', () => {
  it('passes the doctor rows through unchanged so Setup and the CLI agree', () => {
    assert.deepEqual(setupChecks(report), report.checks);
  });
});
