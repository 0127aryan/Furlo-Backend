-- Migration: Custom Breeds & Pet Types Catalog Approval
-- Date: 2026-07-25

-- 1. Add pet_type column to pets table if not exists
ALTER TABLE public.pets ADD COLUMN IF NOT EXISTS pet_type text NOT NULL DEFAULT 'dogs';

-- 2. Create pending_breed_approvals table for admin notifications
CREATE TABLE IF NOT EXISTS public.pending_breed_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid REFERENCES public.pets(id) ON DELETE SET NULL,
  submission_type text NOT NULL CHECK (submission_type IN ('breed', 'pet_type')),
  pet_type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS policies for pending_breed_approvals
ALTER TABLE public.pending_breed_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert pending breed approvals" 
  ON public.pending_breed_approvals FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Admins can view and manage pending breed approvals" 
  ON public.pending_breed_approvals FOR ALL TO authenticated 
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin = true));
