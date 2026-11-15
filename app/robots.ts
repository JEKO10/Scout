import type { MetadataRoute } from "next";

import { appUrl } from "@/lib/appUrl";

// Public marketing and legal pages are indexed; the app, auth and APIs aren't
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/pricing", "/terms", "/privacy", "/refund-policy", "/contact"],
      disallow: ["/api/", "/auth/", "/dashboard", "/onboarding", "/watchlist", "/opportunities", "/activity", "/memory", "/account", "/dev", "/eval", "/checkout"],
    },
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
