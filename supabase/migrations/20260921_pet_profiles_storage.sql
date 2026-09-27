-- Avatars, post images, community covers (backend uses bucket id: pet-profiles)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'pet-profiles',
  'pet-profiles',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public read pet-profiles" ON storage.objects;
CREATE POLICY "Public read pet-profiles"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'pet-profiles');

DROP POLICY IF EXISTS "Service role manages pet-profiles" ON storage.objects;
CREATE POLICY "Service role manages pet-profiles"
ON storage.objects FOR ALL
TO service_role
USING (bucket_id = 'pet-profiles')
WITH CHECK (bucket_id = 'pet-profiles');
