-- Live global announcement banners for web and mobile clients.
ALTER TABLE public.banners REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'banners'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.banners;
  END IF;
END $$;

DROP POLICY IF EXISTS "Anyone can read active banners" ON public.banners;
CREATE POLICY "Anyone can read active banners"
  ON public.banners
  FOR SELECT
  USING (is_active = true);
