-- Human profile (1:1 with auth.users): parent name + legal consent
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK (char_length(trim(full_name)) >= 2),
  terms_accepted_at timestamptz NOT NULL,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
