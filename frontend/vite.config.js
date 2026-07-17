import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/upload-audio': 'http://127.0.0.1:8000',
      '/synthesize': 'http://127.0.0.1:8000',
      '/commit-session': 'http://127.0.0.1:8000',
      '/mockup': 'http://127.0.0.1:8000',
      '/mockup-export': 'http://127.0.0.1:8000',
      '/media-proxy': 'http://127.0.0.1:8000',
    },
  },
})
