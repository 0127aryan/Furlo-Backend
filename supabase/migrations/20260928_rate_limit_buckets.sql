-- Rate limit token buckets (Postgres-backed, serverless-safe via ON CONFLICT row lock)

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS rate_limit_tier text NOT NULL DEFAULT 'free'
  CHECK (rate_limit_tier IN ('free', 'paid'));

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  tokens numeric NOT NULL,
  last_refill timestamptz NOT NULL DEFAULT now(),
  strike_count integer NOT NULL DEFAULT 0,
  last_allowed boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx
  ON public.rate_limit_buckets (updated_at);

CREATE OR REPLACE FUNCTION public.reset_rate_limit_strikes(p_key text)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.rate_limit_buckets
  SET strike_count = 0, updated_at = now()
  WHERE bucket_key = p_key;
$$;

CREATE OR REPLACE FUNCTION public.consume_rate_limit_bucket(
  p_key text,
  p_capacity numeric,
  p_window_ms bigint,
  p_cost numeric,
  p_capacity_free numeric,
  p_capacity_paid numeric,
  p_capacity_admin numeric,
  p_backoff_max_ms bigint,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  allowed boolean,
  tokens_remaining numeric,
  retry_after_ms bigint,
  is_admin boolean,
  rate_limit_tier text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_effective_capacity numeric;
  v_is_admin boolean := NULL;
  v_tier text := NULL;
  v_now timestamptz := clock_timestamp();
  v_tokens numeric;
  v_last_allowed boolean;
  v_strike_count integer;
  v_retry_ms bigint;
  v_refilled numeric;
  v_is_auth_email boolean := p_key LIKE 'auth:email:%';
  v_old_tokens numeric;
  v_old_refill timestamptz;
  v_new_tokens numeric;
  v_allowed boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_key));
  IF p_window_ms IS NULL OR p_window_ms <= 0 OR p_cost IS NULL OR p_cost <= 0 THEN
    RAISE EXCEPTION 'invalid rate limit window or cost';
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT u.is_admin, u.rate_limit_tier
    INTO v_is_admin, v_tier
    FROM public.users u
    WHERE u.id = p_user_id;

    IF NOT FOUND THEN
      v_is_admin := false;
      v_tier := 'free';
    END IF;

    IF v_is_admin THEN
      v_effective_capacity := p_capacity_admin;
    ELSIF v_tier = 'paid' THEN
      v_effective_capacity := p_capacity_paid;
    ELSE
      v_effective_capacity := p_capacity_free;
    END IF;
  ELSE
    v_effective_capacity := p_capacity;
  END IF;

  IF v_effective_capacity IS NULL OR v_effective_capacity <= 0 THEN
    v_effective_capacity := p_capacity;
  END IF;

  INSERT INTO public.rate_limit_buckets (
    bucket_key,
    tokens,
    last_refill,
    strike_count,
    last_allowed,
    updated_at
  )
  VALUES (
    p_key,
    v_effective_capacity,
    v_now,
    0,
    NULL,
    v_now
  )
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT b.tokens, b.last_refill, b.strike_count
  INTO v_old_tokens, v_old_refill, v_strike_count
  FROM public.rate_limit_buckets b
  WHERE b.bucket_key = p_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rate limit bucket missing after upsert for key %', p_key;
  END IF;

  v_refilled := LEAST(
    v_effective_capacity,
    v_old_tokens
      + (
        EXTRACT(EPOCH FROM (v_now - v_old_refill)) * 1000.0
        * v_effective_capacity / p_window_ms::numeric
      )
  );

  v_allowed := v_refilled >= p_cost;

  IF v_allowed THEN
    v_new_tokens := v_refilled - p_cost;
  ELSE
    v_new_tokens := v_refilled;
    IF v_is_auth_email THEN
      v_strike_count := v_strike_count + 1;
    END IF;
  END IF;

  UPDATE public.rate_limit_buckets b
  SET
    tokens = v_new_tokens,
    last_refill = v_now,
    last_allowed = v_allowed,
    strike_count = v_strike_count,
    updated_at = v_now
  WHERE b.bucket_key = p_key
  RETURNING b.tokens, b.last_allowed, b.strike_count
  INTO v_tokens, v_last_allowed, v_strike_count;

  v_retry_ms := 0;
  IF NOT v_last_allowed THEN
    v_refilled := LEAST(
      v_effective_capacity,
      v_tokens
    );
    IF v_refilled < p_cost AND v_effective_capacity > 0 THEN
      v_retry_ms := GREATEST(
        0,
        CEIL((p_cost - v_refilled) * p_window_ms::numeric / v_effective_capacity)
      )::bigint;
    END IF;

    IF v_is_auth_email THEN
      v_retry_ms := GREATEST(
        v_retry_ms,
        LEAST(
          p_backoff_max_ms,
          (POWER(2, GREATEST(v_strike_count, 1)) * 1000)::bigint
        )
      );
    END IF;
  END IF;

  allowed := COALESCE(v_last_allowed, false);
  tokens_remaining := COALESCE(v_tokens, 0);
  retry_after_ms := COALESCE(v_retry_ms, 0);
  is_admin := v_is_admin;
  rate_limit_tier := v_tier;
  RETURN NEXT;
END;
$$;
