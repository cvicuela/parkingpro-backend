-- Migration 054: Fix notifications_user_id_fkey constraint
-- Problem: notifications.user_id REFERENCES users(id) ON DELETE CASCADE
-- caused FK violations when customer doesn't have a users record.
-- Fix: Allow NULL and use ON DELETE SET NULL.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.notifications
  ALTER COLUMN user_id DROP NOT NULL;
