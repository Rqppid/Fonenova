import type { MetadataRoute } from "next"

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://fonenova.com",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://fonenova.com/privacy",
      // Matches the "Last updated" date on the page; bump both together.
      lastModified: new Date("2026-11-14"),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ]
}
