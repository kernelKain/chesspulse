import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// What: bundles the renderer only. Electron's main process is compiled by tsc.
// Why: the blueprint splits the UI from the Node process that will own the camera.
// Removed: the window would have no page to load.
export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  // Production is opened with loadFile, so asset URLs must be relative.
  // The dev server keeps the default root base.
  base: command === 'build' ? './' : '/',
  plugins: [react()],
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
