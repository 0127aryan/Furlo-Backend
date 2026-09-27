function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const rateLimitConfig = {
  authEmailCapacity: envInt("RATE_LIMIT_AUTH_EMAIL_CAPACITY", 10),
  authEmailWindowMs: envInt("RATE_LIMIT_AUTH_EMAIL_WINDOW_MS", 15 * 60 * 1000),
  authIpCapacity: envInt("RATE_LIMIT_AUTH_IP_CAPACITY", 50),
  authIpWindowMs: envInt("RATE_LIMIT_AUTH_IP_WINDOW_MS", 60 * 60 * 1000),
  publicIpPerMin: envInt("RATE_LIMIT_PUBLIC_IP_PER_MIN", 80),
  userFreePerMin: envInt("RATE_LIMIT_USER_FREE_PER_MIN", 100),
  userPaidPerMin: envInt("RATE_LIMIT_USER_PAID_PER_MIN", 1000),
  userAdminPerMin: envInt("RATE_LIMIT_USER_ADMIN_PER_MIN", 500),
  authBackoffMaxSec: envInt("RATE_LIMIT_AUTH_BACKOFF_MAX_SEC", 32),
  postRateLimitPerHour: envInt("POST_RATE_LIMIT_PER_HOUR", 10),
};

export function publicIpWindowMs(): number {
  return 60 * 1000;
}

export function userWindowMs(): number {
  return 60 * 1000;
}

export function authBackoffMaxMs(): number {
  return rateLimitConfig.authBackoffMaxSec * 1000;
}
