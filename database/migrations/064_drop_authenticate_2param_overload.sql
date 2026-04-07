-- Migration 064: Drop the 2-parameter overload of authenticate()
-- Fix: "Could not choose the best candidate function" error when calling
-- authenticate with p_email and p_password only.
-- The 3-parameter version (p_email, p_password, p_ip) is the current one.

DROP FUNCTION IF EXISTS public.authenticate(text, text);
