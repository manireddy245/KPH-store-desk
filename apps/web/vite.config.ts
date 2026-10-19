import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the screens run on Vite (port 5173) and talk to the server on 4000.
// In the shop, the server serves the built screens itself.
const api = `http://localhost:${process.env.KPH_PORT ?? 4000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
