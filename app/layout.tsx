import type { Metadata, Viewport } from 'next'
import { Inter, Space_Grotesk } from 'next/font/google'
import { SiteAnalytics } from '@/components/site-analytics'
import { buildJsonLd } from '@/lib/seo'
import { WhatsAppButton } from '@/components/whatsapp-button'
import './globals.css'

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });

// Leads with the brand for brand/name searches, then the two things a buyer
// actually types: what we sell and where we are. Kept under ~60 chars so Google
// does not truncate it in the results.
const title = 'FoneNova — Wholesale Phones & Electronics Supplier, Belfast'
// ~160 chars: the money terms (wholesale, phones/tablets/laptops), the trade-only
// qualifier that filters out consumer clicks, the location, and the reach.
const description =
  'Belfast-based B2B wholesaler of used and graded phones, tablets, laptops and accessories. Trade only — bulk pricing and delivery across the UK, Ireland and Europe.'

export const metadata: Metadata = {
  metadataBase: new URL('https://fonenova.com'),
  title: {
    default: title,
    // Any future page (e.g. /smartphones) sets its own short title and this
    // appends the brand automatically.
    template: '%s | FoneNova',
  },
  description,
  applicationName: 'FoneNova',
  keywords: [
    'wholesale phones Belfast',
    'phone wholesaler Northern Ireland',
    'wholesale mobile phones UK',
    'used phone wholesaler',
    'refurbished phones wholesale',
    'bulk phones trade',
    'wholesale tablets laptops Belfast',
    'B2B electronics wholesaler',
    'VAT margin scheme phones',
    'FoneNova',
  ],
  category: 'Wholesale Electronics',
  alternates: { canonical: '/' },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    title,
    description,
    url: 'https://fonenova.com',
    siteName: 'FoneNova',
    images: [{ url: '/images/og-cover.jpg', width: 1200, height: 630, alt: 'FoneNova — wholesale phones, tablets, laptops and accessories, Belfast' }],
    locale: 'en_GB',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: ['/images/og-cover.jpg'],
  },
  icons: {
    icon: [
      // Broadest support and the path browsers request unprompted, so it is also
      // what a stale cached favicon gets overwritten by.
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      // One icon for both themes. The mark sits on a solid brand-blue tile, which
      // reads on a light and a dark tab bar alike, so the light/dark pair this
      // used to carry is gone. The PNG is 512px and downscaled by the browser:
      // the spark's curves lose far more to rasterisation than straight edges did.
      //
      // Sizes are declared because they are what Google reads. Its favicon
      // guidelines want a square raster at a multiple of 48px, and the 512px file
      // below is not one (512 / 48 is not whole), so icon-192.png (4 x 48) exists
      // for that. The name icon-128.png is historical: the file is 512px.
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-128.png', type: 'image/png', sizes: '512x512' },
      { url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  // Matches --background in light mode. The toggle rewrites this at runtime, so the
  // browser chrome tracks the chosen theme rather than the operating system's.
  themeColor: '#fcfcfc',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        {/* schema.org business data. Static, no user input, so it is safe to inline
            and it is what search engines read to place FoneNova as a Belfast business. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(buildJsonLd()) }}
        />
        {/* Applies the stored theme before paint so a returning dark-mode visitor never
            flashes white. No stored choice means light: the OS preference is deliberately
            not consulted, so every first-time visitor lands on the light design. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${inter.variable} ${spaceGrotesk.variable} font-sans antialiased`}>
        {children}
        <WhatsAppButton />
        <SiteAnalytics />
      </body>
    </html>
  )
}
