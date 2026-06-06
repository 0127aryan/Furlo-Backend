-- =========================================================
-- Furlo Waitlist Table
-- Migration: 20260605_create_waitlist
-- =========================================================

CREATE TABLE IF NOT EXISTS public.waitlist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (char_length(name) >= 2 AND char_length(name) <= 100),
  city          text NOT NULL CHECK (char_length(city) >= 2 AND char_length(city) <= 100),
  email         text NOT NULL CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  is_pet_parent boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Unique email constraint
ALTER TABLE public.waitlist
  ADD CONSTRAINT waitlist_email_unique UNIQUE (email);

-- Enable Row Level Security
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to INSERT only (for waitlist signups)
CREATE POLICY "Allow anon inserts" ON public.waitlist
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Allow authenticated admins (service_role) to SELECT all rows
-- No SELECT policy for anon/authenticated — data visible only via Supabase dashboard or service_role

-- Index for fast email lookup (duplicate check)
CREATE INDEX IF NOT EXISTS waitlist_email_idx ON public.waitlist (email);

-- Index for analytics queries by city / date
CREATE INDEX IF NOT EXISTS waitlist_city_idx ON public.waitlist (city);
CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON public.waitlist (created_at DESC);
