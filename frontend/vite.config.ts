import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const searchServiceFile = require.resolve('../src/place-search.js');
// This Node service is external to Vite's config bundle. Reload it when the
// config restarts instead of keeping the previous CommonJS middleware cached.
delete require.cache[searchServiceFile];
const placeSearch = require(searchServiceFile);

const backend = 'http://127.0.0.1:8787';
export default defineConfig({
  plugins: [react(), {
    name: 'local-place-search',
    enforce: 'pre',
    configureServer(server) {
      const dependency = normalizePath(searchServiceFile);
      if (!server.config.configFileDependencies.includes(dependency)) server.config.configFileDependencies.push(dependency);
      server.watcher.add(searchServiceFile);
      server.middlewares.use(placeSearch.createDevSearchMiddleware({ backend }));
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Keep the local search bridge out of the older backend's API proxy,
      // including links whose pathname has a trailing slash.
      '^/api(?!/map/search/?(?:\\?|$))': { target: backend, changeOrigin: true },
      '/assets': { target: backend, changeOrigin: true },
      '^/\\?(?:token|ticket)=': { target: backend, changeOrigin: true },
    },
  },
});
