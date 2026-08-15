-- Migration: Create species_verbs table and seed default species verb mappings
CREATE TABLE IF NOT EXISTS public.species_verbs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  species text UNIQUE NOT NULL,
  label text NOT NULL,
  verb text NOT NULL,
  icon text DEFAULT 'pets',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed initial species verb mappings
INSERT INTO public.species_verbs (species, label, verb, icon)
VALUES 
  ('dog', 'Dog', 'Bark', 'pets'),
  ('cat', 'Cat', 'Meow', 'cat'),
  ('rabbit', 'Rabbit', 'Thump', 'cruelty_free'),
  ('bird', 'Bird', 'Chirp', 'feather'),
  ('hamster', 'Hamster', 'Squeak', 'pest_control'),
  ('parrot', 'Parrot', 'Squawk', 'feather'),
  ('turtle', 'Turtle', 'Nudge', 'category'),
  ('guinea_pig', 'Guinea Pig', 'Wheek', 'pest_control'),
  ('fish', 'Fish', 'Bubble', 'phishing'),
  ('other', 'Other', 'Woof', 'category')
ON CONFLICT (species) DO UPDATE SET verb = EXCLUDED.verb, label = EXCLUDED.label;

-- Enable RLS
ALTER TABLE public.species_verbs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Anyone can read species verbs" ON public.species_verbs FOR SELECT USING (true);
CREATE POLICY "Admins can manage species verbs" ON public.species_verbs FOR ALL TO authenticated 
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin = true));
