-- Phase 9 fix: align legacy notifications table with user_id-based model

-- Legacy columns were NOT NULL with old type checks; relax for new notification types.
ALTER TABLE public.notifications
  ALTER COLUMN recipient_pet_id DROP NOT NULL,
  ALTER COLUMN entity_type DROP NOT NULL,
  ALTER COLUMN entity_id DROP NOT NULL;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Notification',
  ADD COLUMN IF NOT EXISTS body text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Drop legacy check constraints so new types (treat, best_answer, etc.) can be inserted.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_entity_type_check;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);

-- RLS: allow owners to read notifications addressed by user_id (realtime + client reads).
DROP POLICY IF EXISTS "Users can read own user notifications" ON public.notifications;
CREATE POLICY "Users can read own user notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Filtered postgres_changes subscriptions need full row payload.
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

-- Realtime delivery for in-app notification stream.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
