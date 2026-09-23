import { defineConfig } from 'vite';

// `base: './'` keeps every asset path relative, so the same build runs from
// GitHub Pages, a file server, or a sandboxed artifact host.
export default defineConfig(({ mode }) => ({
  base: './',
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    // The artifact build inlines every asset so the page is self-contained.
    assetsInlineLimit: mode === 'artifact' ? 64 * 1024 * 1024 : 4096,
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
}));
