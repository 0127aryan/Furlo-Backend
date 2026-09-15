-- Phase 10: Super Admin Dashboard Schema & Badges Migration

-- 1. Users Table Additions
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- 2. Pets Table Additions (Badges)
ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_founding_pet boolean NOT NULL DEFAULT false;

-- 3. Communities Table Additions (Approvals)
ALTER TABLE public.communities
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- 4. Banners Table (Global Announcement Banners)
CREATE TABLE IF NOT EXISTS public.banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  link_url text,
  cta_text text,
  style_type text NOT NULL DEFAULT 'orange',
  is_active boolean NOT NULL DEFAULT true,
  start_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Reports Table (Content Moderation Queue)
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reported_pet_id uuid REFERENCES public.pets(id) ON DELETE SET NULL,
  target_type text NOT NULL DEFAULT 'post',
  target_id uuid NOT NULL,
  reason_category text NOT NULL DEFAULT 'other',
  description text,
  status text NOT NULL DEFAULT 'open',
  action_taken text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pets_is_verified ON public.pets(is_verified);
CREATE INDEX IF NOT EXISTS idx_pets_is_founding_pet ON public.pets(is_founding_pet);
CREATE INDEX IF NOT EXISTS idx_communities_status ON public.communities(status);
CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports(status);
CREATE INDEX IF NOT EXISTS idx_banners_is_active ON public.banners(is_active);

-- Enable RLS
ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
