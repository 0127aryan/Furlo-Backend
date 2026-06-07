-- =========================================================
-- Furlo Core Schema Migration (V2.1)
-- Date: 2026-06-07
-- Database: dev_furlo & prod_furlo
-- =========================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. users Table (referenced to auth.users in Supabase)
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  auth_provider text NOT NULL DEFAULT 'email',
  is_email_verified boolean NOT NULL DEFAULT false,
  is_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. pets Table (Primary Actor)
CREATE TABLE IF NOT EXISTS public.pets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  username text UNIQUE NOT NULL CHECK (char_length(username) >= 3 AND char_length(username) <= 30 AND username ~* '^[a-zA-Z0-9_]+$'),
  name text NOT NULL CHECK (char_length(name) >= 1),
  profile_image_url text NOT NULL,
  cover_image_url text,
  breed text NOT NULL,
  city text NOT NULL DEFAULT 'Bangalore',
  gender text CHECK (gender IN ('male', 'female', 'unknown')),
  date_of_birth date,
  bio text CHECK (char_length(bio) <= 300),
  vaccination_status text NOT NULL DEFAULT 'unknown' CHECK (vaccination_status IN ('yes', 'no', 'unknown')),
  personality_tags text[] NOT NULL DEFAULT '{}',
  is_public boolean NOT NULL DEFAULT true,
  follower_count integer NOT NULL DEFAULT 0,
  following_count integer NOT NULL DEFAULT 0,
  post_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. communities Table
CREATE TABLE IF NOT EXISTS public.communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL CHECK (char_length(name) >= 2 AND char_length(name) <= 100),
  slug text UNIQUE NOT NULL CHECK (char_length(slug) >= 2 AND char_length(slug) <= 100 AND slug ~* '^[a-z0-9-]+$'),
  description text NOT NULL,
  cover_image_url text NOT NULL,
  member_count integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. community_members Table
CREATE TABLE IF NOT EXISTS public.community_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, pet_id)
);

-- 5. posts Table
CREATE TABLE IF NOT EXISTS public.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  community_id uuid REFERENCES public.communities(id) ON DELETE SET NULL,
  caption text CHECK (char_length(caption) <= 500),
  post_type text NOT NULL DEFAULT 'regular' CHECK (post_type IN ('regular', 'question', 'advice', 'meme')),
  location_city text,
  like_count integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed_by_admin', 'deleted_by_owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. post_media Table
CREATE TABLE IF NOT EXISTS public.post_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  media_url text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 7. hashtags Table
CREATE TABLE IF NOT EXISTS public.hashtags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL CHECK (name ~* '^#[a-zA-Z0-9_]+$'),
  usage_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 8. post_hashtags Table
CREATE TABLE IF NOT EXISTS public.post_hashtags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, hashtag_id)
);

-- 9. comments Table
CREATE TABLE IF NOT EXISTS public.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  parent_comment_id uuid REFERENCES public.comments(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) <= 500),
  like_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed_by_admin', 'deleted_by_owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 10. likes Table
CREATE TABLE IF NOT EXISTS public.likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pet_id, post_id)
);

-- 11. follows Table
CREATE TABLE IF NOT EXISTS public.follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  following_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (follower_pet_id, following_pet_id),
  CONSTRAINT no_self_follow CHECK (follower_pet_id <> following_pet_id)
);

-- 12. notifications Table
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  actor_pet_id uuid REFERENCES public.pets(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('like', 'comment', 'comment_reply', 'follow', 'community_announcement')),
  entity_type text NOT NULL CHECK (entity_type IN ('post', 'comment', 'community', 'pet')),
  entity_id uuid NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 13. reports Table
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('post', 'comment', 'pet')),
  entity_id uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 14. admin_actions Table
CREATE TABLE IF NOT EXISTS public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  target_entity_type text NOT NULL,
  target_entity_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 15. community_announcements Table
CREATE TABLE IF NOT EXISTS public.community_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  admin_pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  is_pinned boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- =========================================================
-- 16. Database Triggers Functions
-- =========================================================

-- Trigger function for updated_at
CREATE OR REPLACE FUNCTION public.handle_update_timestamp()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for posts.like_count
CREATE OR REPLACE FUNCTION public.handle_like_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET like_count = like_count + 1 WHERE id = new.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET like_count = like_count - 1 WHERE id = old.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for posts.comment_count
CREATE OR REPLACE FUNCTION public.handle_comment_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET comment_count = comment_count + 1 WHERE id = new.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET comment_count = comment_count - 1 WHERE id = old.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for pets.follower_count and following_count
CREATE OR REPLACE FUNCTION public.handle_follow_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.pets SET follower_count = follower_count + 1 WHERE id = new.following_pet_id;
    UPDATE public.pets SET following_count = following_count + 1 WHERE id = new.follower_pet_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.pets SET follower_count = follower_count - 1 WHERE id = old.following_pet_id;
    UPDATE public.pets SET following_count = following_count - 1 WHERE id = old.follower_pet_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for communities.member_count
CREATE OR REPLACE FUNCTION public.handle_community_member_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.communities SET member_count = member_count + 1 WHERE id = new.community_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.communities SET member_count = member_count - 1 WHERE id = old.community_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for pets.post_count
CREATE OR REPLACE FUNCTION public.handle_pet_post_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.pets SET post_count = post_count + 1 WHERE id = new.pet_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.pets SET post_count = post_count - 1 WHERE id = old.pet_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger function to handle new auth user insert (mirrors auth.users to public.users)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, email, auth_provider, is_email_verified)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_app_meta_data->>'provider', 'email'),
    new.email_confirmed_at IS NOT NULL
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================
-- 17. Bind Triggers
-- =========================================================

-- Bind auth.users mirror trigger
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Bind other counts sync triggers
CREATE OR REPLACE TRIGGER sync_post_like_count AFTER INSERT OR DELETE ON public.likes
  FOR EACH ROW EXECUTE FUNCTION public.handle_like_count();

CREATE OR REPLACE TRIGGER sync_post_comment_count AFTER INSERT OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.handle_comment_count();

CREATE OR REPLACE TRIGGER sync_pet_follower_count AFTER INSERT OR DELETE ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.handle_follow_count();

CREATE OR REPLACE TRIGGER sync_community_member_count AFTER INSERT OR DELETE ON public.community_members
  FOR EACH ROW EXECUTE FUNCTION public.handle_community_member_count();

CREATE OR REPLACE TRIGGER sync_pet_post_count AFTER INSERT OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.handle_pet_post_count();

-- Bind timestamps updates
CREATE OR REPLACE TRIGGER update_users_timestamp BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_update_timestamp();

CREATE OR REPLACE TRIGGER update_pets_timestamp BEFORE UPDATE ON public.pets
  FOR EACH ROW EXECUTE FUNCTION public.handle_update_timestamp();

CREATE OR REPLACE TRIGGER update_communities_timestamp BEFORE UPDATE ON public.communities
  FOR EACH ROW EXECUTE FUNCTION public.handle_update_timestamp();

CREATE OR REPLACE TRIGGER update_posts_timestamp BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.handle_update_timestamp();

CREATE OR REPLACE TRIGGER update_comments_timestamp BEFORE UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.handle_update_timestamp();

CREATE OR REPLACE TRIGGER update_community_announcements_timestamp BEFORE UPDATE ON public.community_announcements
  FOR EACH ROW EXECUTE FUNCTION public.handle_update_timestamp();


-- =========================================================
-- 18. Indexes for Optimization
-- =========================================================

CREATE INDEX IF NOT EXISTS pets_owner_id_idx ON public.pets (owner_id);
CREATE INDEX IF NOT EXISTS pets_username_idx ON public.pets (username);
CREATE INDEX IF NOT EXISTS pets_breed_idx ON public.pets (breed);
CREATE INDEX IF NOT EXISTS pets_city_idx ON public.pets (city);
CREATE INDEX IF NOT EXISTS pets_status_idx ON public.pets (status);

CREATE INDEX IF NOT EXISTS posts_pet_id_idx ON public.posts (pet_id);
CREATE INDEX IF NOT EXISTS posts_community_id_idx ON public.posts (community_id);
CREATE INDEX IF NOT EXISTS posts_created_at_desc_idx ON public.posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_status_idx ON public.posts (status);

CREATE INDEX IF NOT EXISTS follows_follower_pet_id_idx ON public.follows (follower_pet_id);
CREATE INDEX IF NOT EXISTS follows_following_pet_id_idx ON public.follows (following_pet_id);

CREATE INDEX IF NOT EXISTS likes_post_id_pet_id_idx ON public.likes (post_id, pet_id);

CREATE INDEX IF NOT EXISTS comments_post_id_parent_comment_id_idx ON public.comments (post_id, parent_comment_id);

CREATE INDEX IF NOT EXISTS notifications_recipient_is_read_created_desc_idx ON public.notifications (recipient_pet_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS community_members_pet_id_community_id_idx ON public.community_members (pet_id, community_id);


-- =========================================================
-- 19. Enable Row-Level Security (RLS)
-- =========================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_announcements ENABLE ROW LEVEL SECURITY;


-- =========================================================
-- 20. Declare RLS Security Policies
-- =========================================================

-- users policies
CREATE POLICY "Users can read own row" ON public.users FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can update own row" ON public.users FOR UPDATE TO authenticated USING (auth.uid() = id);

-- pets policies
CREATE POLICY "Anyone can read active public pets" ON public.pets FOR SELECT USING (status = 'active' AND is_public = true);
CREATE POLICY "Owners can manage own pets" ON public.pets FOR ALL TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- communities policies
CREATE POLICY "Anyone can read active communities" ON public.communities FOR SELECT USING (is_active = true);
CREATE POLICY "Admins can manage communities" ON public.communities FOR ALL TO authenticated 
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin = true));

-- community_members policies
CREATE POLICY "Anyone can view community memberships" ON public.community_members FOR SELECT USING (true);
CREATE POLICY "Pet owners can manage own memberships" ON public.community_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()));

-- posts policies
CREATE POLICY "Anyone can view active posts" ON public.posts FOR SELECT USING (status = 'active');
CREATE POLICY "Pet owners can manage own posts" ON public.posts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()));

-- post_media policies
CREATE POLICY "Anyone can view post media" ON public.post_media FOR SELECT USING (true);
CREATE POLICY "Post owners can manage media" ON public.post_media FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.posts WHERE id = post_id AND EXISTS (SELECT 1 FROM public.pets WHERE id = posts.pet_id AND owner_id = auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.posts WHERE id = post_id AND EXISTS (SELECT 1 FROM public.pets WHERE id = posts.pet_id AND owner_id = auth.uid())));

-- hashtags policies
CREATE POLICY "Anyone can read hashtags" ON public.hashtags FOR SELECT USING (true);
CREATE POLICY "Authenticated users can insert hashtags" ON public.hashtags FOR INSERT TO authenticated WITH CHECK (true);

-- post_hashtags policies
CREATE POLICY "Anyone can read post hashtags" ON public.post_hashtags FOR SELECT USING (true);
CREATE POLICY "Post owners can manage post hashtags" ON public.post_hashtags FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.posts WHERE id = post_id AND EXISTS (SELECT 1 FROM public.pets WHERE id = posts.pet_id AND owner_id = auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.posts WHERE id = post_id AND EXISTS (SELECT 1 FROM public.pets WHERE id = posts.pet_id AND owner_id = auth.uid())));

-- comments policies
CREATE POLICY "Anyone can read active comments" ON public.comments FOR SELECT USING (status = 'active');
CREATE POLICY "Pet owners can manage own comments" ON public.comments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()));

-- likes policies
CREATE POLICY "Anyone can read likes" ON public.likes FOR SELECT USING (true);
CREATE POLICY "Pet owners can manage own likes" ON public.likes FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = pet_id AND owner_id = auth.uid()));

-- follows policies
CREATE POLICY "Anyone can read follows" ON public.follows FOR SELECT USING (true);
CREATE POLICY "Pet owners can manage own follows" ON public.follows FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = follower_pet_id AND owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = follower_pet_id AND owner_id = auth.uid()));

-- notifications policies
CREATE POLICY "Recipients can read own notifications" ON public.notifications FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = recipient_pet_id AND owner_id = auth.uid()));
CREATE POLICY "Anyone authenticated can insert notifications" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);

-- reports policies
CREATE POLICY "Pet owners can create reports" ON public.reports FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = reporter_pet_id AND owner_id = auth.uid()));
CREATE POLICY "Admins can view and manage reports" ON public.reports FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin = true));

-- admin_actions policies
CREATE POLICY "Admins can manage actions log" ON public.admin_actions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin = true));

-- community_announcements policies
CREATE POLICY "Anyone can view community announcements" ON public.community_announcements FOR SELECT USING (true);
CREATE POLICY "Community admins can manage announcements" ON public.community_announcements FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pets WHERE id = admin_pet_id AND owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pets WHERE id = admin_pet_id AND owner_id = auth.uid()));
