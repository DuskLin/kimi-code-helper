import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  build: {
    outDir: resolve('out/mobile'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/mobile.html') }
  }
})
