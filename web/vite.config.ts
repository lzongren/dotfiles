import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:7733', changeOrigin: true },
    },
  },
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/server/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['test/ui/**/*.test.tsx'],
          setupFiles: ['test/setup.ts'],
        },
      },
    ],
  },
})
