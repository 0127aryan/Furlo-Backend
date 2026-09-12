-- Migration to add approval & verification fields to public.communities
-- Safe to re-run multiple times

ALTER TABLE public.communities
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS is_approved boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requested_category text;

CREATE INDEX IF NOT EXISTS communities_status_idx ON public.communities (status);
CREATE INDEX IF NOT EXISTS communities_is_approved_idx ON public.communities (is_approved);
