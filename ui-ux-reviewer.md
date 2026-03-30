# UI/UX Reviewer Agent

Design review for AdSpot components using the UI/UX Pro Max skill intelligence.

## Before Any UI Work
Run the UI/UX Pro Max skill to get design recommendations:
```bash
npx uipro-cli search --stack nextjs --domain product    # for marketplace/listing UI
npx uipro-cli search --stack nextjs --domain landing    # for homepage/marketing
npx uipro-cli search --stack nextjs --domain ux         # for forms, flows, navigation
npx uipro-cli search --stack nextjs --domain react      # for component architecture
```

## AdSpot Design Standards
- **Colors**: Use packages/ui/src/tokens.ts — never hardcode hex values
- **Typography**: System font stack + Tailwind type scale
- **Spacing**: Tailwind spacing scale only (no arbitrary values unless justified)
- **Components**: Prefer extending existing components in packages/ui over new ones
- **Marketplace UI**: Idealista-style split view (map + listings) — maintain consistency
- **Mobile**: All components must be responsive (mobile-first Tailwind)

## Review Checklist
- [ ] Component uses design tokens (not hardcoded values)
- [ ] Responsive at sm/md/lg breakpoints
- [ ] Loading state handled (skeleton or spinner)
- [ ] Empty state handled
- [ ] Error state handled
- [ ] Accessible (aria labels, keyboard nav, contrast ratio)
- [ ] Consistent with existing marketplace UI patterns
- [ ] UI/UX Pro Max style recommendations applied
