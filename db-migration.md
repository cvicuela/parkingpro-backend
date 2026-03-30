# /db-migration

Author a new Supabase migration for AdSpot.

## Steps
1. Read latest migration number from supabase/migrations/
2. Create `0XX_[description].sql` following naming convention
3. Include: CREATE TABLE, RLS ENABLE, policies, indexes
4. Run `npm run db:migrate` to apply
5. Update packages/types/src/index.ts with new types

## Usage
```
/db-migration [description of what needs to change in DB]
```

## Example
```
/db-migration Add ad_credit_transactions table to track credit balance history per advertiser
```
