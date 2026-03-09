-- Fix SECURITY_DEFINER views flagged by Supabase security advisor
-- Views owned by postgres (superuser) bypass RLS policies.
-- Setting security_invoker = on ensures RLS is enforced for the querying user.

ALTER VIEW public.active_parking_sessions SET (security_invoker = on);
ALTER VIEW public.cash_register_summary SET (security_invoker = on);
ALTER VIEW public.overdue_subscriptions SET (security_invoker = on);
