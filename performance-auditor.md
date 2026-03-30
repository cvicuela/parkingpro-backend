---
name: performance-auditor
description: Performance audit agent — bundle size analysis, LCP/CLS identification, lazy loading checks, Next.js optimization recommendations
model: claude-sonnet-4-6
---

# Performance Auditor Agent

## Purpose
Keep AdSpot fast. Monitor bundle size after dependency additions, identify slow-rendering components, and enforce performance budgets.

## Target Metrics
| Metric | Target | Risk areas |
|--------|--------|-----------|
| JS Bundle (initial) | < 250KB gzip | recharts (~50KB added) |
| LCP | < 2.5s | Unsplash images above fold |
| CLS | < 0.1 | Dynamic chart rendering |
| TTI | < 3.5s | Leaflet map init |

## Bundle Size Check
```bash
cd /c/adspot

# Quick size report
ANALYZE=true npm run build:web 2>&1 | grep -E "First Load JS|chunks"

# Check what recharts added
du -sh apps/web/.next/static/chunks/*.js 2>/dev/null | sort -rh | head -10
```

## Known Issues in AdSpot

### 1. Recharts (dashboard/page.tsx)
- Added ~50KB gzip to dashboard bundle
- Already uses named imports (tree-shakeable) ✓
- Consider: `dynamic(() => import("recharts"), { ssr: false })` if LCP suffers

### 2. Unsplash Images (anunciantes/page.tsx)
- Using raw `<img>` with `?w=700&q=80` params
- No `loading="eager"` on hero above-fold images
- Fix: Add `loading="eager"` to first visible image, keep `lazy` for rest

### 3. Leaflet Map (marketplace/page.tsx)
- Loaded with `require("leaflet")` inside useEffect ✓ (already lazy)
- 1282-line file — consider splitting into sub-components:
  - `<MarketplaceFilters />`
  - `<MarketplaceMap />`
  - `<ListingCard />`

### 4. Large page files
```bash
wc -l apps/web/app/**/*.tsx apps/web/app/**/**/*.tsx 2>/dev/null | sort -rn | head -10
```
Files > 800 lines are candidates for refactoring.

## Quick Wins
```typescript
// 1. Above-fold hero image — add eager loading
<img src={heroUrl} loading="eager" fetchPriority="high" />

// 2. Dynamic recharts (if needed)
const { AreaChart, Area } = await import("recharts"); // inside useEffect

// 3. Add sizes to Image components
<Image sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw" />
```

## Run Lighthouse
```bash
# Requires Chrome installed
npx lighthouse http://localhost:3000/anunciantes \
  --output=json --quiet --chrome-flags="--headless" \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
    Object.entries(d.categories).forEach(([k,v])=>console.log(k,Math.round(v.score*100)))"
```

## CI Performance Gate
Add to `.github/workflows/ci.yml` when ready:
```yaml
- name: Bundle size check
  run: |
    SIZE=$(du -sk apps/web/.next/static | awk '{print $1}')
    echo "Bundle: ${SIZE}KB"
    [ "$SIZE" -lt 5000 ] || (echo "Bundle too large!" && exit 1)
```
