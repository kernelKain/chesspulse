import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { watchViteReady } from './vite-ready.mjs';

function fakeVite() {
  const vite = new EventEmitter();
  vite.stdout = new EventEmitter();
  return vite;
}

describe('watchViteReady', () => {
  it('resolves when the owned server prints its bound URL', async () => {
    const vite = fakeVite();
    const ready = watchViteReady(vite, 'http://127.0.0.1:5173/', 200);
    vite.stdout.emit('data', '  ➜  Local:   http://127.0.0.1:5173/\n');
    await ready;
  });

  it('rejects when the server exits before binding', async () => {
    const vite = fakeVite();
    const ready = watchViteReady(vite, 'http://127.0.0.1:5173/', 200);
    vite.emit('exit', 1);
    await assert.rejects(ready, /exited before it was ready/);
  });

  it('does not accept a different port or a silent running process', async () => {
    const vite = fakeVite();
    const ready = watchViteReady(vite, 'http://127.0.0.1:5173/', 30);
    vite.stdout.emit('data', '  ➜  Local:   http://127.0.0.1:51730/\n');
    await assert.rejects(ready, /did not report that it bound/);
  });
});
