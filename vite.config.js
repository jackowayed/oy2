import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import solid from 'vite-plugin-solid';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: null,
      devOptions: {
        enabled: true,
        type: 'module',
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,wav}'],
        sourcemap: true,
      },
      manifestFilename: 'manifest.json',
      manifest: {
        name: 'Oy',
        short_name: 'Oy',
        description: 'Send Oys to your friends',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#4b50f0',
        orientation: 'portrait',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
    // Wrangler installs a global undici ProxyAgent whenever HTTPS_PROXY is set,
    // and that dispatcher ignores NO_PROXY. Miniflare's inspector proxy reaches
    // workerd with `fetch('http://127.0.0.1:<port>/json')`, so in a proxied
    // sandbox that loopback call is tunnelled to the egress proxy, which
    // rejects it, and the dev server dies parsing the error body as JSON.
    // The inspector is only devtools sugar, so drop it when a proxy is present.
    cloudflare({ inspectorPort: process.env.HTTPS_PROXY ? false : undefined }),
  ],
  server: {
    port: 5173,
  },
});
