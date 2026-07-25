-- Migration: Allow personality_tag in pending_breed_approvals submission_type check
-- Date: 2026-07-26

ALTER TABLE public.pending_breed_approvals DROP CONSTRAINT IF EXISTS pending_breed_approvals_submission_type_check;

ALTER TABLE public.pending_breed_approvals ADD CONSTRAINT pending_breed_approvals_submission_type_check 
  CHECK (submission_type IN ('breed', 'pet_type', 'personality_tag'));
