import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: [{ find: /^buffer$/, replacement: 'buffer/' }] },
  define: { global: 'globalThis' },
  build: { rollupOptions: { output: { manualChunks: { solana: ['@holdfast/chain'], react: ['react', 'react-dom/client'] } } } },
});
