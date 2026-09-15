-- Phase 9: Notifications & Notification Settings Schema

-- Ensure notifications table exists and has all required columns
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  actor_pet_id uuid REFERENCES public.pets(id) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'system',
  title text NOT NULL DEFAULT 'Notification',
  body text NOT NULL DEFAULT '',
  entity_type text,
  entity_id uuid,
  is_read boolean NOT NULL DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Notification',
  ADD COLUMN IF NOT EXISTS body text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- User Notification Settings Table
CREATE TABLE IF NOT EXISTS public.user_notification_settings (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  master_push_enabled boolean NOT NULL DEFAULT true,
  qa_answers_enabled boolean NOT NULL DEFAULT true,
  qa_best_answer_enabled boolean NOT NULL DEFAULT true,
  treats_enabled boolean NOT NULL DEFAULT true,
  comments_enabled boolean NOT NULL DEFAULT true,
  followers_enabled boolean NOT NULL DEFAULT true,
  pack_announcements_enabled boolean NOT NULL DEFAULT true,
  email_digest_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);

-- RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notification_settings ENABLE ROW LEVEL SECURITY;
