import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { privateFileBoundary, privateFileDeny } from './dev-security';

const webRoot = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const allowed = [webRoot, ...['../../packages/chain/', '../../node_modules/'].map((path) => realpathSync(fileURLToPath(new URL(path, import.meta.url))))];
// Keep only browser sources and their dependencies in the dev file-serving boundary.

export default defineConfig({
  plugins: [privateFileBoundary(webRoot, allowed)],
  server: { fs: { strict: true, allow: allowed, deny: privateFileDeny } },
  resolve: { alias: [{ find: /^buffer$/, replacement: 'buffer/' }] },
  define: { global: 'globalThis' },
  build: { rollupOptions: { output: { manualChunks: { solana: ['@holdfast/chain'], react: ['react', 'react-dom/client'] } } } },
});
