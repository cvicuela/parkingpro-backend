# /feature-development

Scaffold and implement a new AdSpot feature end-to-end.

## Steps

1. **Assess** — read relevant existing code, identify affected layers
2. **Plan** — invoke gsd-planner agent, create wave-based task list
3. **DB** (if needed) — write migration with db-migrator agent
4. **Types** — update packages/types/src/index.ts
5. **API** — implement route(s) with auth guard
6. **UI** — query UI/UX Pro Max skill first, then implement component
7. **Verify** — test with demo users, run `npm run build`
8. **Commit** — atomic commits per layer (feat(db):, feat(api):, feat(ui):)

## Usage
```
/feature-development [feature description]
```

## Example
```
/feature-development Add review system for media listings — advertisers can rate after booking completes
```
