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
    // Sandboxes that force all traffic through an egress proxy can't reach
    // miniflare's inspector on 127.0.0.1; scripts/dev-setup.sh sets this there.
    cloudflare(
      process.env.DISABLE_WORKERD_INSPECTOR ? { inspectorPort: false } : {},
    ),
  ],
  server: {
    port: 5173,
  },
});
