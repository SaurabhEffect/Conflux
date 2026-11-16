import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The sync server lives on its own port (1234). The browser connects to it
// directly, see src/config.ts.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The editor (Tiptap + ProseMirror) makes the bundle a bit big. That is fine for now.
  build: { chunkSizeWarningLimit: 1200 },
})
