import type { MetadataRoute } from "next";

import { appUrl } from "@/lib/appUrl";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl();
  const pages: [string, number][] = [
    ["/", 1],
    ["/pricing", 0.8],
    ["/terms", 0.3],
    ["/privacy", 0.3],
    ["/refund-policy", 0.3],
    ["/contact", 0.3],
  ];
  return pages.map(([path, priority]) => ({ url: `${base}${path}`, changeFrequency: "weekly", priority }));
}
