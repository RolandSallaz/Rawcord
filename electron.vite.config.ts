import { builtinModules } from 'module'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const nodeBuiltins = builtinModules.filter(m => !m.startsWith('_'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    optimizeDeps: {
      exclude: ['electron', 'simple-peer', 'readable-stream', ...nodeBuiltins]
    },
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  }
})
