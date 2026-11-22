// What: starts the typecheck, the Vite page, then the Electron window.
// Why: the two processes are built by different tools and neither starts the other.
// Removed: `npm run dev` would not open the app.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { watchViteReady } from './vite-ready.mjs';

const children = [];

function track(child) {
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function run(command, args, env) {
  return track(spawn(command, args, { stdio: 'inherit', env }));
}

const compile = run('npx', ['tsc', '-p', 'tsconfig.electron.json']);
compile.on('exit', (code) => {
  if (code !== 0) shutdown(code ?? 1);
  // The sandboxed preload cannot require relative files, so its shared imports are bundled here.
  const preload = run('npx', ['vite', 'build', '--config', 'vite.preload.mts']);
  preload.on('exit', (preloadCode) => {
    if (preloadCode !== 0) shutdown(preloadCode ?? 1);
    startDevServer();
  });
});

function startDevServer() {
  portInUse(5173)
    .then((occupied) => {
      if (occupied) {
        console.error('Port 5173 is already in use. The renderer was not started.');
        shutdown(1);
        return;
      }
      const vite = track(spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
        stdio: ['inherit', 'pipe', 'pipe'],
      }));
      vite.stdout.on('data', (chunk) => process.stdout.write(chunk));
      vite.stderr.on('data', (chunk) => process.stderr.write(chunk));
      return watchViteReady(vite, 'http://127.0.0.1:5173/').then(() => {
        const env = { ...process.env, CHESSPULSE_RENDERER_URL: 'http://127.0.0.1:5173' };
        delete env.ELECTRON_RUN_AS_NODE;
        const electron = run('npx', ['electron', '.'], env);
        electron.on('exit', (electronCode) => shutdown(electronCode ?? 0));
      });
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      shutdown(1);
    });
}
