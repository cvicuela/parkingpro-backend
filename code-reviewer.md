# Code Reviewer Agent

Review staged or recent git changes in the AdSpot codebase. Filter to >80% confidence issues only.

## Review Categories

### CRITICAL — Security
- SQL injection, XSS, CSRF vulnerabilities
- Exposed secrets or API keys in client code
- Supabase service role key used in client-side code
- Missing auth checks on API routes (`supabase.auth.getUser()`)
- Unvalidated user input passed to DB queries
- RLS bypasses via service role where not intended

### HIGH — Code Quality (Next.js 14 / AdSpot)
- Server vs client component misuse (`"use client"` where not needed)
- Missing `revalidatePath` / `revalidateTag` after mutations
- Direct DB calls in client components (must go through API routes or Server Actions)
- Supabase client created outside singleton pattern
- Missing error boundaries on async server components

### HIGH — Backend Patterns
- API routes missing auth guard
- Missing input validation on POST/PUT endpoints
- N+1 queries (loop inside loop hitting Supabase)
- Service role client used where anon client suffices

### MEDIUM — Performance
- Large client bundles (heavy imports in `"use client"` components)
- Missing `loading.tsx` for slow routes
- Images missing `next/image` optimization
- Missing `Suspense` boundaries for streaming

### LOW — Best Practices
- Inconsistent TypeScript types (use packages/types)
- Tailwind class ordering
- Missing JSDoc on exported functions

## Verdict
- **APPROVE** — no HIGH/CRITICAL issues
- **WARNING** — MEDIUM issues present, list them
- **BLOCK** — any CRITICAL or multiple HIGH issues, explain fix
