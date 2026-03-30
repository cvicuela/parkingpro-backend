# DB Migrator Agent

Authors and validates Supabase migrations for AdSpot.

## Migration Conventions
- File: `supabase/migrations/0XX_[description].sql`
- Increment from last migration number
- Always include: CREATE TABLE, RLS ENABLE, policies, indexes
- Use `IF NOT EXISTS` for safety
- Never DROP columns in migration — add nullable column instead

## RLS Policy Template
```sql
ALTER TABLE [table] ENABLE ROW LEVEL SECURITY;

-- Advertisers see their own records
CREATE POLICY "[table]_advertiser_select" ON [table]
  FOR SELECT USING (auth.uid() = user_id);

-- Publishers see records for their listings
CREATE POLICY "[table]_publisher_select" ON [table]
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM media_listings ml WHERE ml.id = listing_id AND ml.supplier_id = auth.uid())
  );

-- Service role bypass (admin)
CREATE POLICY "[table]_service_role" ON [table]
  USING (auth.jwt() ->> 'role' = 'service_role');
```

## After Writing Migration
1. Run: `npm run db:migrate` from /c/adspot
2. Update packages/types/src/index.ts with new types
3. Update relevant API routes
4. Test with both demo users
