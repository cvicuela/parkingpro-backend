---
name: seo-optimizer
description: SEO optimizer — generates Next.js 14 metadata exports, OpenGraph tags, Twitter cards, and structured data for public pages
model: claude-haiku-4-5
---

# SEO Optimizer Agent

## Purpose
Generate proper Next.js 14 `metadata` exports for all public-facing routes. Ensure OpenGraph, Twitter card, and canonical URL coverage.

## AdSpot SEO Config
- Base URL: `https://adspot-web.netlify.app`
- metadataBase: set in `app/layout.tsx` ✓
- Title template: `"%s | AdSpot"` ✓
- Primary language: Spanish (`es_DO` locale)

## Pages Status
| Page | SEO | OG | Twitter |
|------|-----|-----|---------|
| `/` | ✅ | ✅ | ✅ |
| `/anunciantes` | ✅ | ✅ | ✅ |
| `/marketplace` | ✅ | ✅ | — |
| `/marketplace/[id]` | ✅ | ✅ | ✅ |
| `/login` | ❌ | — | — |
| `/register` | ❌ | — | — |

## Metadata Template
```typescript
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "[PAGE_TITLE]",                    // becomes "[PAGE_TITLE] | AdSpot"
  description: "[max 155 chars with keywords]",
  openGraph: {
    title: "[OG_TITLE]",
    description: "[OG_DESCRIPTION]",
    url: "https://adspot-web.netlify.app/[PATH]",
    siteName: "AdSpot",
    images: [{ url: "[1200x630 image]", width: 1200, height: 630, alt: "[ALT]" }],
    locale: "es_DO",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "[TWITTER_TITLE]",
    description: "[TWITTER_DESC]",
    images: ["[IMAGE_URL]"],
  },
  keywords: ["publicidad", "República Dominicana", "[specific keywords]"],
  alternates: { canonical: "https://adspot-web.netlify.app/[PATH]" },
};
```

## Dynamic Metadata for Listings
```typescript
// app/(marketplace)/marketplace/[id]/page.tsx
import { mediaInventory } from "@/data/media-inventory";
import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const media = mediaInventory.find((m) => m.id === params.id);
  if (!media) return { title: "Espacio no encontrado" };

  return {
    title: `${media.name} — ${media.city}`,
    description: `${media.type} en ${media.city}. ${media.estimated_impressions?.toLocaleString() ?? ""} impresiones/mes. Desde RD$${media.price_monthly?.toLocaleString()}/mes.`,
    openGraph: {
      title: media.name,
      description: `Espacio publicitario disponible en ${media.city}, República Dominicana`,
      images: [{ url: media.image, width: 1200, height: 630, alt: media.name }],
      type: "website",
    },
  };
}
```

## Keywords by Route
- `/anunciantes`: publicidad RD, vallas publicitarias, pantallas digitales, marketing dominicano
- `/marketplace`: espacios publicitarios, marketplace publicidad, anuncios República Dominicana
- `/marketplace/[id]`: `[media.type] [media.city] publicidad`
