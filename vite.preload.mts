import { defineConfig } from 'vite';

// What: bundles the sandboxed preload into one CommonJS file.
// Why: a sandboxed preload may only require `electron`; relative requires fail at runtime, so the
//      shared channel and error modules must be inlined instead of emitted beside it.
// Removed: the preload imports shared modules and would crash before exposing the bridge.
export default defineConfig({
  build: {
    outDir: 'dist-electron/preload',
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/preload/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
