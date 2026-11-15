import type { MetadataRoute } from 'next'

/**
 * Lets the dashboard be added to a phone's home screen and open full screen like an app.
 * No service worker on purpose: these pages show private financial data and must never be cached or shown stale.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'QuayPilot · Fone Nova',
    short_name: 'QuayPilot',
    description: 'Fone Nova Ltd: offers, invoices and profit.',
    start_url: '/offers',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#111b2b',
    theme_color: '#111b2b',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
