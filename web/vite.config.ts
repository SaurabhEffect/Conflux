import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const serverPort = Number(process.env.PORT) || 1234
const server = `http://127.0.0.1:${serverPort}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/collab': { target: server, ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
})
