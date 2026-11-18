import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001

  return {
    plugins: [react(), tailwindcss()],
    base: process.env.VITE_BASE ?? '/',
    envDir: path.resolve(__dirname, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            minSize: 20_000,
            groups: [
              { name: 'vendor-icons', test: /node_modules[\\/]lucide-react/ },
              { name: 'vendor-ui', test: /node_modules[\\/](?:@base-ui|@tanstack|react(?:-dom|-router)?(?:[\\/]|$))/ },
            ],
          },
        },
      },
    },
    server: {
      proxy: {
        // Force IPv4 — on Windows + Node 17+, `localhost` resolves to ::1 first,
        // which can collide with wslrelay / Docker Desktop listeners on the same port.
        '/api': `http://127.0.0.1:${serverPort}`,
        '/v1': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
