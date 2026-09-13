-- Migration for Phase 8: Pet Q&A Hub fields
-- Date: 2026-09-13

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS topic_category text,
  ADD COLUMN IF NOT EXISTS is_solved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accepted_answer_id uuid REFERENCES public.comments(id) ON DELETE SET NULL;

ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS is_accepted_answer boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS posts_qa_fields_idx ON public.posts (post_type, topic_category, is_solved);
