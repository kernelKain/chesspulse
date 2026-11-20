import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { contentSecurityPolicy } from './src/shared/security.mjs';

function chesspulseCsp(development: boolean): Plugin {
  const policy = contentSecurityPolicy(development);
  return {
    name: 'chesspulse-csp',
    transformIndexHtml(html) {
      return html.replaceAll('__CHESSPULSE_CSP__', policy);
    },
  };
}

// What: bundles the renderer only. Electron's main process is compiled by tsc.
// Why: the blueprint splits the UI from the Node process that will own the camera.
// Removed: the window would have no page to load.
export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  // Production is opened with loadFile, so asset URLs must be relative.
  // The dev server keeps the default root base.
  base: command === 'build' ? './' : '/',
  plugins: [react(), chesspulseCsp(command === 'serve')],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
}));
