import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Offer pages are private to one client each: never crawled, never listed.
      disallow: ["/offer/", "/api/offer/"],
    },
    sitemap: "https://fonenova.com/sitemap.xml",
  }
}
