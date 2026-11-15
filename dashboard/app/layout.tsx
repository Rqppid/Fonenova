import type { Metadata, Viewport } from 'next'
import '@fontsource-variable/inter'
import './globals.css'

export const metadata: Metadata = {
  title: 'QuayPilot · Fone Nova',
  description: 'Internal gross profit dashboard for Fone Nova Ltd.',
  robots: { index: false, follow: false },
  // Added to an iPhone's home screen it opens full screen, with this name under the icon.
  appleWebApp: { capable: true, title: 'QuayPilot', statusBarStyle: 'black-translucent' },
}

export const viewport: Viewport = { themeColor: '#111b2b', width: 'device-width', initialScale: 1, viewportFit: 'cover' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  )
}
