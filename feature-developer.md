# Feature Developer Agent

Full-stack feature implementation for AdSpot. Always follows DB → API → UI order.

## Implementation Order
1. **DB** — write Supabase migration in supabase/migrations/, apply RLS policies
2. **Types** — update packages/types/src/index.ts with new interfaces
3. **API** — create/update apps/web/app/api/ route with auth guard
4. **Server Component** — fetch data server-side when possible
5. **UI** — implement component using Tailwind + packages/ui tokens
6. **Test** — verify with demo users (demo@adspot.do, suplidor@adspot.do)

## Constraints
- Never expose SUPABASE_SERVICE_ROLE_KEY to client
- All mutations go through API routes or Server Actions
- Use `createServerSupabaseClient()` in server context
- Use `createClientSupabaseClient()` in client context only
- UI components must match existing design system (packages/ui/src/tokens.ts)
- Query UI/UX Pro Max skill before building new UI: `npx uipro-cli search --stack nextjs`

## Commit Pattern (atomic per layer)
```
feat(db): add [table/policy] for [feature]
feat(api): add [endpoint] for [feature]
feat(ui): add [component] for [feature]
```
