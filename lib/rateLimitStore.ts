import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  authBackoffMaxMs,
  publicIpWindowMs,
  rateLimitConfig,
  userWindowMs,
} from "./rateLimitConfig.js";

export type ConsumeRateLimitResult = {
  allowed: boolean;
  tokensRemaining: number;
  retryAfterMs: number;
  isAdmin: boolean | null;
  rateLimitTier: string | null;
};

let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(url, key);
  }
  return supabaseAdmin;
}

type RpcRow = {
  allowed: boolean;
  tokens_remaining: number;
  retry_after_ms: number;
  is_admin: boolean | null;
  rate_limit_tier: string | null;
};

function mapRow(row: RpcRow): ConsumeRateLimitResult {
  return {
    allowed: Boolean(row.allowed),
    tokensRemaining: Number(row.tokens_remaining),
    retryAfterMs: Number(row.retry_after_ms),
    isAdmin: row.is_admin,
    rateLimitTier: row.rate_limit_tier,
  };
}

export async function consumeRateLimitBucket(params: {
  key: string;
  capacity: number;
  windowMs: number;
  cost?: number;
  userId?: string | null;
}): Promise<ConsumeRateLimitResult | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("[rate-limit] Supabase env missing — skipping limit check");
    return { allowed: true, tokensRemaining: 0, retryAfterMs: 0, isAdmin: null, rateLimitTier: null };
  }

  const { data, error } = await supabase.rpc("consume_rate_limit_bucket", {
    p_key: params.key,
    p_capacity: params.capacity,
    p_window_ms: params.windowMs,
    p_cost: params.cost ?? 1,
    p_capacity_free: rateLimitConfig.userFreePerMin,
    p_capacity_paid: rateLimitConfig.userPaidPerMin,
    p_capacity_admin: rateLimitConfig.userAdminPerMin,
    p_backoff_max_ms: authBackoffMaxMs(),
    p_user_id: params.userId ?? null,
  });

  if (error) {
    console.error("[rate-limit] consume_rate_limit_bucket RPC error:", error.message);
    return null;
  }

  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | undefined;
  if (!row) {
    return null;
  }
  return mapRow(row);
}

export async function consumePublicIpLimit(clientIp: string): Promise<ConsumeRateLimitResult | null> {
  return consumeRateLimitBucket({
    key: `public:ip:${clientIp}`,
    capacity: rateLimitConfig.publicIpPerMin,
    windowMs: publicIpWindowMs(),
  });
}

export async function consumeUserLimit(userId: string): Promise<ConsumeRateLimitResult | null> {
  return consumeRateLimitBucket({
    key: `user:${userId}`,
    capacity: rateLimitConfig.userFreePerMin,
    windowMs: userWindowMs(),
    userId,
  });
}

export async function consumeAuthEmailLimit(email: string): Promise<ConsumeRateLimitResult | null> {
  return consumeRateLimitBucket({
    key: `auth:email:${email}`,
    capacity: rateLimitConfig.authEmailCapacity,
    windowMs: rateLimitConfig.authEmailWindowMs,
  });
}

export async function consumeAuthIpLimit(clientIp: string): Promise<ConsumeRateLimitResult | null> {
  return consumeRateLimitBucket({
    key: `auth:ip:${clientIp}`,
    capacity: rateLimitConfig.authIpCapacity,
    windowMs: rateLimitConfig.authIpWindowMs,
  });
}

export async function resetAuthEmailStrikes(email: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return;
  }
  const normalized = email.trim().toLowerCase();
  const { error } = await supabase.rpc("reset_rate_limit_strikes", {
    p_key: `auth:email:${normalized}`,
  });
  if (error) {
    console.warn("[rate-limit] reset_rate_limit_strikes failed:", error.message);
  }
}
