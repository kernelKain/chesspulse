import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiConfigState } from './ai/config.js';
import {
  MIN_NODE_MAJOR,
  runDoctor,
  type DoctorCheck,
  type DoctorOptions,
} from './doctor.js';

const SENSING_SECRET = 'sk-live-doctor-123456789';
const AI_SECRET = 'ai-live-doctor-987654321';

const passEngine = async (): Promise<DoctorCheck> => ({
  id: 'engine',
  label: 'Stockfish',
  status: 'pass',
  detail: 'Answered the UCI handshake and scored the start position.',
});

const skipCamera = (): DoctorCheck => ({
  id: 'camera',
  label: 'Camera',
  status: 'skip',
  detail: 'Enumeration runs inside the app window.',
});

function base(overrides: DoctorOptions = {}): DoctorOptions {
  return {
    env: { SMARTSPECTRA_API_KEY: SENSING_SECRET, CP_AI_KEY: AI_SECRET },
    envFile: {
      found: true,
      path: '/tmp/.env',
      loadedKeys: ['SMARTSPECTRA_API_KEY', 'CP_AI_KEY'],
    },
    dataRoot: '/tmp/chesspulse-doctor',
    nodeVersion: '22.22.1',
    cameraCheck: skipCamera,
    engineProbe: passEngine,
    writableProbe: async () => true,
    aiConfig: { disabled: true, reason: 'No AI key configured. The report is complete without it.' },
    ...overrides,
  };
}

function checkStatus(report: Awaited<ReturnType<typeof runDoctor>>, id: DoctorCheck['id']): string {
  return report.checks.find((check) => check.id === id)?.status ?? 'missing';
}

describe('doctor checks', () => {
  it('reports every check and keeps key values out of every line', async () => {
    const report = await runDoctor(base());
    assert.equal(report.checks.length, 7);
    assert.deepEqual(
      report.checks.map((check) => check.id),
      ['node', 'env', 'sensing-key', 'camera', 'engine', 'data-dir', 'ai'],
    );
    assert.equal(checkStatus(report, 'node'), 'pass');
    assert.equal(checkStatus(report, 'env'), 'pass');
    assert.equal(checkStatus(report, 'sensing-key'), 'pass');
    assert.equal(checkStatus(report, 'camera'), 'skip');
    assert.equal(checkStatus(report, 'engine'), 'pass');
    assert.equal(checkStatus(report, 'data-dir'), 'pass');
    assert.equal(checkStatus(report, 'ai'), 'warn');
    assert.equal(report.ok, true);

    const text = report.lines.join('\n');
    assert.ok(!text.includes(SENSING_SECRET));
    assert.ok(!text.includes(AI_SECRET));
    assert.match(text, /SMARTSPECTRA_API_KEY, CP_AI_KEY|CP_AI_KEY, SMARTSPECTRA_API_KEY/);
    assert.match(text, /Present \(value not shown\)/);
  });

  it('fails when the SmartSpectra key is missing', async () => {
    const report = await runDoctor(base({ env: { CP_AI_KEY: AI_SECRET } }));
    assert.equal(checkStatus(report, 'sensing-key'), 'fail');
    assert.equal(report.ok, false);
  });

  it('fails when the engine cannot answer', async () => {
    const report = await runDoctor(
      base({
        engineProbe: async () => ({
          id: 'engine',
          label: 'Stockfish',
          status: 'fail',
          detail: 'No usable answer (timeout).',
        }),
      }),
    );
    assert.equal(checkStatus(report, 'engine'), 'fail');
    assert.equal(report.ok, false);
  });

  it('fails when the data directory is not writable', async () => {
    const report = await runDoctor(base({ writableProbe: async () => false }));
    assert.equal(checkStatus(report, 'data-dir'), 'fail');
    assert.match(report.lines.join('\n'), /Not writable at \/tmp\/chesspulse-doctor/);
    assert.equal(report.ok, false);
  });

  it('fails a runtime older than the product floor but names the version', async () => {
    const report = await runDoctor(base({ nodeVersion: '18.20.0' }));
    assert.equal(checkStatus(report, 'node'), 'fail');
    assert.match(report.lines.join('\n'), new RegExp(`v18\\.20\\.0 \\(needs ${MIN_NODE_MAJOR}`));
    assert.equal(report.ok, false);
  });

  it('warns without failing when .env is absent or AI is off', async () => {
    const report = await runDoctor(
      base({ envFile: { found: false, path: '/tmp/.env' }, env: { SMARTSPECTRA_API_KEY: SENSING_SECRET } }),
    );
    assert.equal(checkStatus(report, 'env'), 'warn');
    assert.equal(checkStatus(report, 'ai'), 'warn');
    assert.equal(report.ok, true);
    assert.match(report.lines.join('\n'), /Not found\. Values already in the shell environment/);
  });

  it('reports a configured AI provider and model without its key', async () => {
    const configured: AiConfigState = {
      disabled: false,
      config: {
        provider: 'openai',
        key: AI_SECRET,
        model: 'gpt-test',
        baseUrl: 'https://api.openai.com/v1',
      },
    };
    const report = await runDoctor(base({ aiConfig: configured }));
    assert.equal(checkStatus(report, 'ai'), 'pass');
    const text = report.lines.join('\n');
    assert.match(text, /Configured for openai, model gpt-test/);
    assert.ok(!text.includes(AI_SECRET));
  });

  it('skips camera enumeration when no in-app probe is supplied', async () => {
    const report = await runDoctor(base({ cameraCheck: undefined }));
    assert.equal(checkStatus(report, 'camera'), 'skip');
    assert.match(report.lines.join('\n'), /Setup shows the live result/);
  });
});
