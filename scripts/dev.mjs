// What: starts the typecheck, the Vite page, then the Electron window.
// Why: the two processes are built by different tools and neither starts the other.
// Removed: `npm run dev` would not open the app.
import { spawn } from 'node:child_process';
import net from 'node:net';

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

function waitForVite(vite, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    vite.once('exit', (code) => {
      finish(new Error(`The renderer server exited before it was ready (code ${code ?? 'none'}).`));
    });
    const started = Date.now();
    const attempt = () => {
      if (settled) return;
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        if (vite.exitCode != null) {
          finish(new Error('The renderer server exited before it was ready.'));
          return;
        }
        finish();
      });
      socket.once('error', () => {
        socket.destroy();
        if (settled) return;
        if (Date.now() - started > 20000) {
          finish(new Error('The renderer server did not open on port 5173.'));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function run(command, args, env) {
  return track(spawn(command, args, { stdio: 'inherit', env }));
}

const compile = run('npx', ['tsc', '-p', 'tsconfig.electron.json']);
compile.on('exit', (code) => {
  if (code !== 0) shutdown(code ?? 1);
  portInUse(5173)
    .then((occupied) => {
      if (occupied) {
        console.error('Port 5173 is already in use. The renderer was not started.');
        shutdown(1);
        return;
      }
      const vite = run('npx', ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
      return waitForVite(vite, 5173).then(() => {
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
});
