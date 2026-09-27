import { createSecretKey } from "crypto";

let secretKey: ReturnType<typeof createSecretKey> | null = null;
let cachedSecretRaw: string | null = null;
let warnedMissingJwtSecret = false;

function resolveJwtSecretRaw(): string | undefined {
  const raw =
    process.env.SUPABASE_JWT_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim();
  return raw || undefined;
}

/** Call once at server startup (after dotenv). */
export function warnIfJwtSecretMissing(): void {
  if (resolveJwtSecretRaw()) {
    return;
  }
  if (warnedMissingJwtSecret) {
    return;
  }
  warnedMissingJwtSecret = true;
  console.warn(
    "[rate-limit] SUPABASE_JWT_SECRET is not set — authenticated requests use public IP limits only. " +
      "Add the JWT secret from Supabase Dashboard → Project Settings → API → JWT Settings → JWT Secret to Furlo-Backend/.env",
  );
}
type JwtVerifyFn = (
  jwt: string,
  key: ReturnType<typeof createSecretKey>,
  options: { algorithms: string[] },
) => Promise<{ payload: Record<string, unknown> }>;

let jwtVerifyFn: JwtVerifyFn | null = null;

async function getJwtVerify(): Promise<JwtVerifyFn> {
  if (!jwtVerifyFn) {
    const jose = await import("jose");
    jwtVerifyFn = jose.jwtVerify as JwtVerifyFn;
  }
  return jwtVerifyFn;
}

function getSecretKey() {
  const jwtSecret = resolveJwtSecretRaw();
  if (!jwtSecret) {
    return null;
  }
  if (!secretKey || cachedSecretRaw !== jwtSecret) {
    cachedSecretRaw = jwtSecret;
    secretKey = createSecretKey(Buffer.from(jwtSecret, "utf8"));
  }
  return secretKey;
}

export type VerifiedAccessToken = {
  sub: string;
};

/**
 * Cryptographically verify a Supabase access token (HS256).
 * Returns null if missing, invalid, or expired.
 */
export async function verifySupabaseAccessToken(
  token: string | null | undefined,
): Promise<VerifiedAccessToken | null> {
  if (!token?.trim()) {
    return null;
  }

  const key = getSecretKey();
  if (!key) {
    warnIfJwtSecretMissing();
    return null;
  }

  try {
    const jwtVerify = await getJwtVerify();
    const { payload } = await jwtVerify(token.trim(), key, {
      algorithms: ["HS256"],
    });

    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) {
      return null;
    }

    return { sub };
  } catch {
    return null;
  }
}

export function extractAccessTokenFromRequest(
  cookieHeader: string | undefined,
  authorizationHeader: string | undefined,
): string | null {
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split("; ").map((c) => {
        const [key, ...v] = c.split("=");
        return [key, v.join("=")];
      }),
    );
    if (cookies.furlo_session) {
      return decodeURIComponent(cookies.furlo_session);
    }
  }

  if (authorizationHeader?.startsWith("Bearer ")) {
    return authorizationHeader.substring(7).trim();
  }

  return null;
}
