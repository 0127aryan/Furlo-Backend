-- Extra pack-directory fields. Safe to re-run.
ALTER TABLE public.communities
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'local'
    CHECK (category IN ('local', 'breed', 'nutrition', 'training')),
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS created_by_pet_id uuid REFERENCES public.pets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS logo_image_url text;

CREATE INDEX IF NOT EXISTS communities_category_idx ON public.communities (category);
CREATE INDEX IF NOT EXISTS communities_created_by_pet_id_idx ON public.communities (created_by_pet_id);
