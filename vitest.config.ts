import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' },
  resolve: { alias: { '@': path.resolve(__dirname) } },
  esbuild: { jsx: 'automatic' },
})
