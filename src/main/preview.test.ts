import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPreviewController, type PreviewCapture, type PreviewStartInput, type PreviewStarter } from './preview.js';

class FakeCapture implements PreviewCapture {
  stopped = false;
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function fakeStarter(): { start: PreviewStarter; created: FakeCapture[]; inputs: PreviewStartInput[] } {
  const created: FakeCapture[] = [];
  const inputs: PreviewStartInput[] = [];
  return {
    created,
    inputs,
    start(input) {
      inputs.push(input);
      const capture = new FakeCapture();
      created.push(capture);
      return capture;
    },
  };
}

const input: PreviewStartInput = {
  apiKey: 'test-key',
  anchor: { monoUs: 1_000, epochMs: 1_000_000 },
  events: {
    onSamples: () => undefined,
    onValidation: () => undefined,
    onError: () => undefined,
    onPreview: () => undefined,
    onEnded: () => undefined,
  },
};

describe('preview controller', () => {
  it('starts one capture and is idempotent while it is open', async () => {
    const fake = fakeStarter();
    const controller = createPreviewController(fake.start);
    await controller.start(input);
    await controller.start(input);
    assert.equal(fake.created.length, 1);
    assert.equal(controller.active(), true);
    assert.equal(fake.inputs[0].apiKey, 'test-key');
  });

  it('stops the open capture and is safe to stop twice', async () => {
    const fake = fakeStarter();
    const controller = createPreviewController(fake.start);
    await controller.start(input);
    await controller.stop();
    await controller.stop();
    assert.equal(fake.created.length, 1);
    assert.equal(fake.created[0].stopped, true);
    assert.equal(controller.active(), false);
  });

  it('serializes start, stop, start so the final state is running', async () => {
    const fake = fakeStarter();
    const controller = createPreviewController(fake.start);
    const first = controller.start(input);
    const stop = controller.stop();
    const second = controller.start(input);
    await Promise.all([first, stop, second]);
    assert.equal(fake.created.length, 2);
    assert.equal(fake.created[0].stopped, true);
    assert.equal(fake.created[1].stopped, false);
    assert.equal(controller.active(), true);
  });

  it('keeps reporting active while a stop is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createPreviewController(() => ({ stop: () => gate }));
    await controller.start(input);
    const stopping = controller.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.active(), true);
    release();
    await stopping;
    assert.equal(controller.active(), false);
  });

  it('rejects a queued start when its guard no longer allows capture', async () => {
    const fake = fakeStarter();
    let allowed = false;
    const controller = createPreviewController(fake.start);
    await assert.rejects(
      () =>
        controller.start(input, () => {
          if (!allowed) throw new Error('consent withdrawn');
        }),
      /consent withdrawn/,
    );
    assert.equal(fake.created.length, 0);
    assert.equal(controller.active(), false);
    allowed = true;
    await controller.start(input, () => {
      if (!allowed) throw new Error('consent withdrawn');
    });
    assert.equal(fake.created.length, 1);
  });

  it('keeps the queue usable after a failed start', async () => {
    let fail = true;
    const created: FakeCapture[] = [];
    const start: PreviewStarter = () => {
      if (fail) throw new Error('no camera');
      const capture = new FakeCapture();
      created.push(capture);
      return capture;
    };
    const controller = createPreviewController(start);
    await assert.rejects(() => controller.start(input), /no camera/);
    assert.equal(controller.active(), false);
    fail = false;
    await controller.start(input);
    assert.equal(controller.active(), true);
    assert.equal(created.length, 1);
  });
});
