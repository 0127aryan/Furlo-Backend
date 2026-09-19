-- Realtime pack approval / visibility updates for public packs and admin queues.
ALTER TABLE public.communities REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'communities'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.communities;
  END IF;
END $$;
