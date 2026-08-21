import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 5250 belongs to the sibling ARI OS marketing site; the console sits on 5251.
const PORT = 5251;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    // Never steal desktop focus — the preview tooling opens the page itself.
    open: false,
  },
  preview: { host: '127.0.0.1', port: PORT, strictPort: true, open: false },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
