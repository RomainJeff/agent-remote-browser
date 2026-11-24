import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// Served by the gateway (src/admin/routes.ts): index.html on /, hashed files under /assets/.
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': root } },
  // One bundle on purpose: served from the local gateway, no route is worth a split.
  build: { outDir: fileURLToPath(new URL('../../../dist/admin', import.meta.url)), emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
