import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    // spec web-shell, rule 7: /api/approvals reaches the API's /approvals (default PORT 3000)
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
