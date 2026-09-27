# Rate limiting (Furlo backend)

Postgres-backed token buckets via Supabase RPC. One `.rpc('consume_rate_limit_bucket')` per limit decision from Node.

## Environment

```env
SUPABASE_JWT_SECRET=...          # Required for per-user limits (Supabase → Settings → API → JWT Secret)
RATE_LIMIT_AUTH_EMAIL_CAPACITY=10
RATE_LIMIT_AUTH_EMAIL_WINDOW_MS=900000
RATE_LIMIT_AUTH_IP_CAPACITY=50
RATE_LIMIT_AUTH_IP_WINDOW_MS=3600000
RATE_LIMIT_PUBLIC_IP_PER_MIN=80
RATE_LIMIT_USER_FREE_PER_MIN=100
RATE_LIMIT_USER_PAID_PER_MIN=1000
RATE_LIMIT_USER_ADMIN_PER_MIN=500
RATE_LIMIT_AUTH_BACKOFF_MAX_SEC=32
POST_RATE_LIMIT_PER_HOUR=10
```

Apply migration `20260928_rate_limit_buckets.sql` with `npm run migrate`.

## Behavior

| Traffic | Key | Limit |
|---------|-----|--------|
| Auth POST (signup, login, OTP resend, verify OTP, OAuth exchange) | `auth:email:*` + `auth:ip:*` | Dual-axis; email skipped if body has no email |
| Unauthenticated API | `public:ip:*` | Token bucket per IP |
| Valid JWT (signature verified with `SUPABASE_JWT_SECRET`) | `user:<sub>` | Tier from `users.is_admin` / `users.rate_limit_tier` inside RPC |
| Invalid / forged JWT | `public:ip:*` | Never a per-user bucket |

429 response:

```json
{ "error": "Too many requests...", "retryAfterSeconds": 4 }
```

Header: `Retry-After`.

Auth email backoff on deny: exponential seconds capped by `RATE_LIMIT_AUTH_BACKOFF_MAX_SEC`. Strikes reset on successful login / verify OTP / OAuth exchange.

Post creation: max `POST_RATE_LIMIT_PER_HOUR` active posts per pet per rolling hour (separate from transport buckets).

## JWT verification

Per-user limits require HS256 verification of the access token before trusting `sub`. Unsigned or wrong-signature tokens use the **public IP** bucket only.

## Client IP (web)

Next.js proxy [`Furlo-Frontend/app/api/backend/[...path]/route.ts`](../../Furlo-Frontend/app/api/backend/[...path]/route.ts) **replaces** `x-forwarded-for` and sets `x-furlo-client-ip` from the edge client IP. Browser-supplied `x-forwarded-for` is not forwarded.

Backend: `trust proxy` + read `x-furlo-client-ip`, then first `x-forwarded-for` hop.

### Manual IP check

1. Call an endpoint via `/api/backend/health` from the browser.
2. Repeat with a dev-only debug header or curl through the proxy while sending a fake `x-forwarded-for: 1.2.3.4` from the browser — backend rate-limit keys must not use `1.2.3.4` unless that is your real address.

## Scaling ceiling

Every limited request performs a synchronous Postgres write/read for bucket consume before route handlers. At current scale the Supabase pooler is sufficient; this adds baseline latency and write load on all limited traffic.

**Revisit bucket storage when:** p95 API latency grows with traffic while rate-limit RPC time dominates; Postgres write/IOPS pressure; sustained high req/s after profiling.

**Migration path:** move bucket state to Redis/Upstash behind the same middleware interface — not required for launch.

## Manual verification checklist

- Burst `POST /auth/login` same email → 429 + increasing `Retry-After`.
- Same IP, many emails → auth IP bucket at 50/hour.
- Forged JWT → public IP limit only; rotating fake `sub` does not bypass IP limit.
- Valid JWT → throttled by real user id.
- IP spoof via browser fake `x-forwarded-for` → not trusted after proxy replace.
- 11th post/hour/pet → 429.
- ~20 parallel requests same bucket key, capacity 10 → at most 10 allowed.

## SQL concurrency

Bucket updates use `pg_advisory_xact_lock(hashtext(p_key))`, ensure row via `INSERT ... ON CONFLICT DO NOTHING`, then `SELECT ... FOR UPDATE` and a single `UPDATE` with refill/consume computed in PL/pgSQL (row lock — safe under concurrent serverless). User tier/admin is a separate `SELECT` in the same function — still one RPC from Node.

Strikes reset: `reset_rate_limit_strikes(p_key)` after successful auth.
