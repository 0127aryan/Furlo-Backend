-- Tail wags sent from one pet profile to another
CREATE TABLE IF NOT EXISTS public.wags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  target_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_self_wag CHECK (sender_pet_id <> target_pet_id)
);

CREATE INDEX IF NOT EXISTS wags_target_created_idx
  ON public.wags (target_pet_id, created_at DESC);

ALTER TABLE public.wags ENABLE ROW LEVEL SECURITY;
