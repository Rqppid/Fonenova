/** @type {import('next').NextConfig} */

/**
 * Security headers applied to every response.
 *
 * Scope is deliberate. This is a static, no-backend marketing site: there is no
 * auth, no API and no server-rendered user input, so the headers that matter
 * here are the ones that harden the browser's handling of the page, not ones
 * that guard a session or an endpoint that does not exist.
 *
 * No full Content-Security-Policy. Next's App Router emits inline hydration
 * scripts with per-response content, so a strict script-src needs a per-request
 * nonce via middleware, which turns every response dynamic and drops the static
 * CDN cache. That is a real cost to defend an injection vector this site does
 * not have (nothing renders user-controlled HTML). Instead the CSP below sets
 * only the directives that cost nothing and break nothing: frame-ancestors
 * (clickjacking, and the modern replacement for X-Frame-Options), base-uri and
 * object-src. It intentionally omits default-src/script-src/style-src so
 * hydration, Tailwind and motion's inline styles keep working.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
]

const nextConfig = {
  // Left on: `npx tsc --noEmit` is clean, so the build's type-check is a safety
  // net that catches real bugs before deploy rather than a blocker to work
  // around. Turn it back to true only if a future generated change reintroduces
  // type errors you cannot immediately fix.
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Client offer pages and their API: private to one client, so never cached, never indexed,
      // and the token in the address is not passed on to other sites (listed after the global
      // rule so its Referrer-Policy wins).
      {
        source: '/offer/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        source: '/api/offer/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]
  },
}

export default nextConfig
