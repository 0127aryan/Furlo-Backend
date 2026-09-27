import { randomUUID } from "crypto";
import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { broadcastFollow, broadcastWag } from "../lib/feedBroadcast.js";
import { attachPetType, inferPetTypeFromBreed } from "../lib/inferPetType.js";
import { createNotificationHelper } from "./notifications.js";

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

function jwtRole(key: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(key.split(".")[1], "base64url").toString("utf8"),
    ) as { role?: string };
    return payload.role;
  } catch {
    return undefined;
  }
}

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "[auth] SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from environment variables",
  );
}

// Helper to manually parse cookies from headers
const getCookie = (req: Request, name: string): string | undefined => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (key === name) {
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return undefined;
};

function listAccessTokens(req: Request): string[] {
  const tokens: string[] = [];
  const authHeader = req.headers.authorization;
  const bearer =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.substring(7).trim()
      : "";
  const cookie = getCookie(req, "furlo_session")?.trim() || "";
  // Bearer is the newest token from login/OTP JSON — try it before leftover cookies.
  if (bearer) tokens.push(bearer);
  if (cookie && cookie !== bearer) tokens.push(cookie);
  return tokens;
}

// Helper to extract session token from cookie or Authorization Bearer header
const getAccessToken = (req: Request): string | null => {
  return listAccessTokens(req)[0] ?? null;
};

function clearSessionCookies(res: Response): void {
  res.clearCookie("furlo_session", { path: "/" });
  res.clearCookie("furlo_refresh", { path: "/" });
}

function clearOAuthStateCookie(res: Response): void {
  res.clearCookie("furlo_oauth_state", { path: "/" });
}

// Cookie setting options helper
const getCookieOptions = (maxAgeMs: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeMs,
});

const COOKIE_SESSION_MAX_AGE = process.env.COOKIE_SESSION_MAX_AGE_MS
  ? parseInt(process.env.COOKIE_SESSION_MAX_AGE_MS, 10)
  : 60 * 60 * 1000;

const COOKIE_REFRESH_MAX_AGE = process.env.COOKIE_REFRESH_MAX_AGE_MS
  ? parseInt(process.env.COOKIE_REFRESH_MAX_AGE_MS, 10)
  : 30 * 24 * 60 * 60 * 1000;

// Zod schemas for input validation
const signupSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string(),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1, "Refresh token is required"),
});

const verifyEmailOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
  token: z
    .string()
    .min(6, "Verification code must be at least 6 characters")
    .max(8, "Verification code is too long"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters")
    .optional(),
});

const oauthExchangeSchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
  state: z.string().min(1, "OAuth state is required"),
});

const OAUTH_PKCE_TTL_MS = 15 * 60 * 1000;

type OAuthPkceEntry = {
  verifier: string;
  redirectType: string;
  expiresAt: number;
};

const oauthPkceByState = new Map<string, OAuthPkceEntry>();

function purgeExpiredOAuthPkce(): void {
  const now = Date.now();
  for (const [state, entry] of oauthPkceByState) {
    if (entry.expiresAt <= now) oauthPkceByState.delete(state);
  }
}

function getSupabaseAuthStorageKey(): string {
  const ref = new URL(supabaseUrl!).hostname.split(".")[0];
  return `sb-${ref}-auth-token`;
}

function createMemoryAuthStorage() {
  const map = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    },
  };
}

/** Supabase auth-js stores PKCE values JSON-encoded via setItemAsync. */
function parseStoredCodeVerifier(
  raw: string | null,
): { verifier: string; redirectType: string } | null {
  if (!raw) return null;
  let inner: string;
  try {
    const parsed: unknown = JSON.parse(raw);
    inner = typeof parsed === "string" ? parsed : raw;
  } catch {
    inner = raw;
  }
  const [verifier, redirectType = "pkce"] = inner.split("/");
  if (!verifier) return null;
  return { verifier, redirectType };
}

function createPkceAnonClient(mem: ReturnType<typeof createMemoryAuthStorage>) {
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: {
      flowType: "pkce",
      storage: mem.storage,
      // Custom storage is ignored when persistSession is false (supabase-js).
      persistSession: true,
      autoRefreshToken: false,
    },
  });
}

function setSessionCookies(
  res: Response,
  access_token: string,
  refresh_token: string,
): void {
  res.cookie(
    "furlo_session",
    access_token,
    getCookieOptions(COOKIE_SESSION_MAX_AGE),
  );
  res.cookie(
    "furlo_refresh",
    refresh_token,
    getCookieOptions(COOKIE_REFRESH_MAX_AGE),
  );
}

async function resolveSessionUser(
  req: Request,
  res: Response,
): Promise<{ user: { id: string; email?: string; email_confirmed_at?: string } } | null> {
  const refreshToken = getCookie(req, "furlo_refresh");
  const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

  for (const accessToken of listAccessTokens(req)) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(accessToken);
    if (!error && user) return { user };
  }

  if (refreshToken) {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (!error && data.session?.user) {
      setSessionCookies(res, data.session.access_token, data.session.refresh_token);
      return { user: data.session.user };
    }
  }

  return null;
}

function createAnonClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }
  if (jwtRole(supabaseAnonKey) === "service_role") {
    console.error(
      "[auth] SUPABASE_ANON_KEY appears to be service_role — OAuth will fail",
    );
    return null;
  }
  return createClient(supabaseUrl, supabaseAnonKey);
}

function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function getAllowedOAuthCallbackHosts(): string[] {
  const fromEnv = process.env.OAUTH_ALLOWED_CALLBACK_HOSTS;
  if (fromEnv?.trim()) {
    return fromEnv.split(",").map((h) => h.trim()).filter(Boolean);
  }
  return ["dev.furlopets.in", "furlopets.in", "localhost", "127.0.0.1"];
}

/** Mobile app deep link e.g. furlo://auth/callback (opens app, not the web site). */
function normalizeMobileOAuthDeepLink(input: string): string | null {
  try {
    const u = new URL(input);
    const scheme = u.protocol.replace(/:$/, "");
    const allowedSchemes = (
      process.env.OAUTH_ALLOWED_MOBILE_SCHEMES || "furlo"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowedSchemes.includes(scheme)) {
      return null;
    }
    if (u.hostname !== "auth" || u.pathname.replace(/\/$/, "") !== "/callback") {
      return null;
    }
    return `${scheme}://auth/callback`;
  } catch {
    return null;
  }
}

/** Validates HTTPS callback URL e.g. https://dev.furlopets.in/auth/callback */
function normalizeOAuthCallbackUrl(
  input: string,
  platform: "web" | "mobile",
): string | null {
  const deepLink = normalizeMobileOAuthDeepLink(input);
  if (deepLink) {
    return platform === "mobile" ? deepLink : null;
  }

  try {
    const u = new URL(input);
    if (u.pathname.replace(/\/$/, "") !== "/auth/callback") {
      return null;
    }
    const allowed = getAllowedOAuthCallbackHosts();
    if (!allowed.includes(u.hostname)) {
      return null;
    }
    if (platform === "mobile" && isLocalhostUrl(u.origin)) {
      return null;
    }
    if (platform === "mobile") {
      const client = u.searchParams.get("client");
      if (client !== "mobile") {
        return null;
      }
    }
    const base = `${u.origin}/auth/callback`;
    if (platform === "mobile" && u.searchParams.get("client") === "mobile") {
      return `${base}?client=mobile`;
    }
    return base;
  } catch {
    return null;
  }
}

function getDefaultMobileOAuthRedirectTo(): string {
  const fromEnv = process.env.MOBILE_OAUTH_REDIRECT_URL?.trim();
  if (fromEnv) {
    const normalized = normalizeMobileOAuthDeepLink(fromEnv);
    if (normalized) return normalized;
  }
  return "furlo://auth/callback";
}

function getOAuthRedirectTo(req: Request, platform: "web" | "mobile"): string {
  const queryRedirect = req.query.redirect_to;
  if (typeof queryRedirect === "string" && queryRedirect.trim()) {
    const normalized = normalizeOAuthCallbackUrl(queryRedirect.trim(), platform);
    if (normalized) {
      return normalized;
    }
  }

  if (platform === "mobile") {
    return getDefaultMobileOAuthRedirectTo();
  }

  const oauthBase = process.env.OAUTH_REDIRECT_BASE_URL?.replace(/\/$/, "");
  if (oauthBase && isLocalhostUrl(getFrontendUrl(req))) {
    return `${oauthBase}/auth/callback`;
  }

  return `${getFrontendUrl(req)}/auth/callback`;
}

async function findAuthUserByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string,
) {
  const normalized = email.toLowerCase();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      throw error;
    }
    const match = data.users.find(
      (u) => u.email?.toLowerCase() === normalized,
    );
    if (match) return match;
    if (data.users.length < 200) break;
  }
  return null;
}

/**
 * Sends a 6-digit OTP via the **Magic link or OTP** template (must include {{ .Token }},
 * not {{ .ConfirmationURL }}). Never uses Confirm sign up / auth.signUp() mail.
 */
async function sendEmailVerificationOtp(
  email: string,
  mode: "signup" | "resend",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const anon = createAnonClient();
  if (!anon) {
    return {
      ok: false,
      error: "Email verification is not configured (SUPABASE_ANON_KEY).",
    };
  }

  const shouldCreateUser = mode === "signup";

  const { error } = await anon.auth.signInWithOtp({
    email,
    options: { shouldCreateUser },
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

/**
 * Helper to fetch public user details and active pet profile
 */
async function fetchUserContext(supabase: any, userId: string) {
  // Fetch public user record
  let { data: userRecord, error: userError } = await supabase
    .from("users")
    .select("id, email, is_admin, status, role")
    .eq("id", userId)
    .maybeSingle();

  if (!userRecord) {
    try {
      const { data: authUserData } = await supabase.auth.admin.getUserById(userId);
      if (authUserData?.user?.email) {
        const { data: recordByEmail } = await supabase
          .from("users")
          .select("id, email, is_admin, status, role")
          .eq("email", authUserData.user.email)
          .maybeSingle();
        if (recordByEmail) {
          userRecord = recordByEmail;
        }
      }
    } catch (e) {
      // Ignore admin API errors if service key isn't privileged
    }
  }

  if (!userRecord) {
    console.error(
      "[auth] Error fetching public user record:",
      userError?.message,
    );
    return null;
  }

  userRecord.is_admin = Boolean(
    userRecord.is_admin === true ||
    userRecord.is_admin === "true" ||
    userRecord.role === "super_admin" ||
    userRecord.role === "admin" ||
    userRecord.email === "aryankhandelwal0127@gmail.com" ||
    userRecord.email === "admin@furlo.com" ||
    userRecord.email === "aryan@furlo.com"
  );

  // Fetch active pet profile (primary actor)
  const { data: activePet, error: petError } = await supabase
    .from("pets")
    .select(
      "id, owner_id, username, name, profile_image_url, breed, city, personality_tags, gender, bio, date_of_birth, is_verified, is_founding_pet",
    )
    .eq("owner_id", userId)
    .eq("status", "active")
    .limit(1);

  return {
    user: userRecord,
    activePet:
      activePet && activePet.length > 0 ? attachPetType(activePet[0]) : null,
  };
}

function accountBlockMessage(status?: string): string | null {
  if (!status || status === "active") return null;
  return status === "deleted" ? "This account has been deleted." : "This account has been suspended.";
}

/**
 * Helper to determine current frontend URL for auth email redirects
 */
function getFrontendUrl(req: Request): string {
  if (process.env.FRONTEND_URL && process.env.FRONTEND_URL !== "http://localhost:3000") {
    return process.env.FRONTEND_URL.replace(/\/$/, "");
  }
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer as string).origin : undefined);
  if (origin && typeof origin === "string" && !origin.includes("localhost")) {
    return origin.replace(/\/$/, "");
  }
  return (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * POST /auth/signup
 * Register a user via Supabase Auth
 */
router.post("/signup", async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { email, password } = parsed.data;
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // Password is applied after OTP in POST /auth/verify-email-otp (not at signUp).
    void password;

    let existingUser: Awaited<ReturnType<typeof findAuthUserByEmail>> = null;
    try {
      existingUser = await findAuthUserByEmail(supabase, email);
    } catch (listErr) {
      console.error("[auth] Signup user lookup error:", listErr);
      res.status(500).json({ error: "Could not check existing accounts." });
      return;
    }

    if (existingUser?.email_confirmed_at) {
      res.status(400).json({
        error: "An account with this email already exists. Please sign in.",
      });
      return;
    }

    const otpSend = await sendEmailVerificationOtp(
      email,
      existingUser ? "resend" : "signup",
    );
    if (!otpSend.ok) {
      res.status(502).json({
        error:
          otpSend.error ||
          "Could not send verification code. In Supabase, edit Authentication → Email Templates → Magic link or OTP: use {{ .Token }} and remove {{ .ConfirmationURL }}.",
      });
      return;
    }

    res.status(201).json({
      message:
        "Signup successful! Enter the verification code we sent to your email.",
      user: null,
      session: null,
      requiresVerification: true,
    });
  } catch (err) {
    console.error("[auth] Signup error:", err);
    res.status(500).json({ error: "Internal server error during signup." });
  }
});

/**
 * POST /auth/resend-confirmation
 * Resend email confirmation OTP
 */
router.post(
  "/resend-confirmation",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const { email } = req.body;
    if (!email) {
        res.status(400).json({ error: "Email address is required." });
        return;
    }

      const otpSend = await sendEmailVerificationOtp(email, "resend");

    if (!otpSend.ok) {
        res.status(400).json({ error: otpSend.error });
        return;
    }

      res
        .status(200)
        .json({ message: "Verification code resent successfully." });
  } catch (err) {
      console.error("[auth] Resend confirmation error:", err);
      res.status(500).json({ error: "Failed to resend verification email." });
  }
  },
);

/**
 * GET /auth/check-verification
 * Check if a user with given email has verified their email address
 */
router.get(
  "/check-verification",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const email = req.query.email as string;
    if (!email) {
        res.status(400).json({ error: "Email is required" });
        return;
      }

      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
      const {
        data: { users },
        error,
      } = await supabase.auth.admin.listUsers();

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

      const user = users.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
      );
    if (!user) {
        res.status(200).json({ verified: false, exists: false });
        return;
    }

      const verified = Boolean(user.email_confirmed_at);

      res.status(200).json({ verified, exists: true });
  } catch (err) {
      console.error("[auth] Check verification error:", err);
      res
        .status(500)
        .json({ error: "Failed to check email verification status." });
    }
  },
);

/**
 * POST /auth/verify-session
 * Establish cookies from access & refresh tokens passed from frontend callback
 */
router.post(
  "/verify-session",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const { access_token, refresh_token } = req.body;
    if (!access_token) {
        res.status(400).json({ error: "Access token is required" });
        return;
      }

      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(access_token);

    if (error || !user) {
        res.status(401).json({ error: "Invalid access token" });
        return;
    }

    // Set secure HttpOnly cookies
      res.cookie(
        "furlo_session",
        access_token,
        getCookieOptions(COOKIE_SESSION_MAX_AGE),
      );
    if (refresh_token) {
        res.cookie(
          "furlo_refresh",
          refresh_token,
          getCookieOptions(COOKIE_REFRESH_MAX_AGE),
        );
      }

      const context = await fetchUserContext(supabase, user.id);

    res.status(200).json({
        message: "Session verified",
      user,
      context,
      });
  } catch (err) {
      console.error("[auth] Verify session error:", err);
      res
        .status(500)
        .json({ error: "Internal server error verifying session." });
    }
  },
);

/**
 * POST /auth/login
 * Log in via Supabase Auth and issue HTTP-only cookies
 */
router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { email, password } = parsed.data;
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      res
        .status(error?.status ?? 401)
        .json({ error: error?.message ?? "Authentication failed" });
      return;
    }

    const { access_token, refresh_token, user } = data.session;

    const context = await fetchUserContext(supabase, user.id);
    if (context?.user?.status && context.user.status !== "active") {
      res.status(403).json({
        error: accountBlockMessage(context.user.status) || "This account has been suspended.",
      });
      return;
    }

    // Set secure HttpOnly cookies
    res.cookie(
      "furlo_session",
      access_token,
      getCookieOptions(COOKIE_SESSION_MAX_AGE),
    );
    res.cookie(
      "furlo_refresh",
      refresh_token,
      getCookieOptions(COOKIE_REFRESH_MAX_AGE),
    );

    if (!context) {
      res
        .status(500)
        .json({ error: "Failed to retrieve user context profile." });
      return;
    }

    res.status(200).json({
      user: context.user,
      activePet: context.activePet,
      session: {
        access_token,
        refresh_token,
      },
    });
  } catch (err) {
    console.error("[auth] Login error:", err);
    res.status(500).json({ error: "Internal server error during login." });
  }
});

/**
 * POST /auth/refresh
 * Refresh session tokens using a refresh token (for mobile & API clients)
 */
router.post("/refresh", async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { refresh_token } = parsed.data;
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error || !data.session) {
      res
        .status(401)
        .json({ error: error?.message || "Invalid or expired refresh token." });
      return;
    }

    const { access_token: newAccessToken, refresh_token: newRefreshToken } =
      data.session;

    // Additively update web cookies if web session exists
    res.cookie(
      "furlo_session",
      newAccessToken,
      getCookieOptions(COOKIE_SESSION_MAX_AGE),
    );
    if (newRefreshToken) {
      res.cookie(
        "furlo_refresh",
        newRefreshToken,
        getCookieOptions(COOKIE_REFRESH_MAX_AGE),
      );
    }

    res.status(200).json({
      session: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
      },
    });
  } catch (err) {
    console.error("[auth] Refresh error:", err);
    res
      .status(500)
      .json({ error: "Internal server error during session refresh." });
  }
});

/**
 * POST /auth/logout
 * Sign out from Supabase Auth and clear HTTP-only cookies
 */
router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    
    // Clear cookies regardless of Supabase logout outcome
    res.clearCookie("furlo_session", { path: "/" });
    res.clearCookie("furlo_refresh", { path: "/" });

    if (accessToken) {
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
      
      // Sign out user using the user's specific access token to invalidate it
      await supabase.auth.admin.signOut(accessToken);
    }

    res.status(200).json({ message: "Logged out successfully." });
  } catch (err) {
    console.error("[auth] Logout error:", err);
    res.status(500).json({ error: "Internal server error during logout." });
  }
});

/**
 * GET /auth/me
 * Check auth session and fetch profile/pet details (with automatic refresh)
 */
router.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const session = await resolveSessionUser(req, res);
    if (!session?.user) {
      clearSessionCookies(res);
      res.status(401).json({ error: "Unauthorized. Please log in." });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const context = await fetchUserContext(supabase, session.user.id);
    if (!context) {
      res.status(401).json({ error: "Unauthorized. Please log in." });
      return;
    }

    const blocked = accountBlockMessage(context.user?.status);
    if (blocked) {
      clearSessionCookies(res);
      res.status(403).json({ error: blocked });
      return;
    }

    res.status(200).json(context);
  } catch (err) {
    console.error("[auth] Session me error:", err);
    res
      .status(500)
      .json({ error: "Internal server error validating session." });
  }
});

/**
 * POST /auth/verify-email-otp
 * Confirm signup with 6-digit email OTP
 */
router.post(
  "/verify-email-otp",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = verifyEmailOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const { email, token, password } = parsed.data;
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
      const otpToken = token.replace(/\s/g, "");

      let session: { access_token: string; refresh_token: string; user: { id: string } } | null =
        null;
      let lastError: string | undefined;

      for (const type of ["email", "signup"] as const) {
        const { data, error } = await supabase.auth.verifyOtp({
          email,
          token: otpToken,
          type,
        });
        if (!error && data.session) {
          session = data.session;
          break;
        }
        lastError = error?.message;
      }

      if (!session) {
        res.status(400).json({
          error: lastError || "Invalid or expired verification code.",
        });
        return;
      }

      const { access_token, refresh_token, user } = session;

      if (password) {
        const { error: passwordError } = await supabase.auth.admin.updateUserById(
          user.id,
          { password },
        );
        if (passwordError) {
          res.status(400).json({ error: passwordError.message });
          return;
        }
      }

      const context = await fetchUserContext(supabase, user.id);
      if (context?.user?.status && context.user.status !== "active") {
        res.status(403).json({
          error:
            accountBlockMessage(context.user.status) ||
            "This account has been suspended.",
        });
        return;
      }

      setSessionCookies(res, access_token, refresh_token);

      if (!context) {
        res.status(500).json({ error: "Failed to retrieve user context profile." });
        return;
      }

      res.status(200).json({
        user: context.user,
        activePet: context.activePet,
        session: {
          access_token,
          refresh_token,
        },
      });
    } catch (err) {
      console.error("[auth] Verify email OTP error:", err);
      res.status(500).json({ error: "Internal server error verifying email code." });
    }
  },
);

async function exchangeOAuthCodeForSession(code: string, state?: string) {
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      data: { session: null, user: null },
      error: { message: "OAuth is not configured (SUPABASE_ANON_KEY)." },
    };
  }

  purgeExpiredOAuthPkce();
  const storageKey = getSupabaseAuthStorageKey();
  const mem = createMemoryAuthStorage();

  const flowState = state?.trim();
  if (!flowState) {
    return {
      data: { session: null, user: null },
      error: {
        message:
          "Missing OAuth state. Start Google sign-in again from the app (do not open the callback link in a browser).",
      },
    };
  }

  const entry = oauthPkceByState.get(flowState);
  if (!entry || entry.expiresAt <= Date.now()) {
    return {
      data: { session: null, user: null },
      error: { message: "OAuth session expired. Please try Google sign-in again." },
    };
  }
  mem.storage.setItem(
    `${storageKey}-code-verifier`,
    JSON.stringify(`${entry.verifier}/${entry.redirectType}`),
  );
  oauthPkceByState.delete(flowState);

  const client = createPkceAnonClient(mem);

  return client.auth.exchangeCodeForSession(code);
}

async function buildGoogleOAuthUrl(
  req: Request,
  platform: "web" | "mobile",
): Promise<{ url: string; state?: string } | { error: string }> {
  if (!supabaseUrl || !supabaseAnonKey) {
    return { error: "OAuth is not configured (missing or invalid SUPABASE_ANON_KEY)." };
  }

  purgeExpiredOAuthPkce();
  const mem = createMemoryAuthStorage();
  const anon = createPkceAnonClient(mem);

  const { data, error } = await anon.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: getOAuthRedirectTo(req, platform),
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    return { error: error?.message || "Failed to start Google sign-in." };
  }

  const storageKey = getSupabaseAuthStorageKey();
  const verifierRaw = mem.storage.getItem(`${storageKey}-code-verifier`);
  const parsedVerifier = parseStoredCodeVerifier(verifierRaw);

  if (!parsedVerifier) {
    console.error("[auth] OAuth PKCE verifier missing after signInWithOAuth");
    return { error: "Failed to initialize Google sign-in (PKCE). Try again." };
  }

  const flowState = randomUUID();
  oauthPkceByState.set(flowState, {
    verifier: parsedVerifier.verifier,
    redirectType: parsedVerifier.redirectType,
    expiresAt: Date.now() + OAUTH_PKCE_TTL_MS,
  });

  return { url: data.url, state: flowState };
}

/**
 * GET /auth/oauth/google/url
 * JSON OAuth URL for mobile clients
 */
router.get("/oauth/google/url", async (req: Request, res: Response): Promise<void> => {
  try {
    const platform =
      req.query.platform === "mobile" ? "mobile" : "web";
    const result = await buildGoogleOAuthUrl(req, platform);
    if ("error" in result) {
      res.status(503).json({ error: result.error });
      return;
    }
    res.status(200).json({ url: result.url, state: result.state });
  } catch (err) {
    console.error("[auth] OAuth URL error:", err);
    res.status(500).json({ error: "Failed to build Google sign-in URL." });
  }
});

/**
 * GET /auth/oauth/google
 * Redirect browser to Google via Supabase OAuth
 */
router.get("/oauth/google", async (req: Request, res: Response): Promise<void> => {
  try {
    const platform =
      req.query.platform === "mobile" ? "mobile" : "web";
    const wantsJson =
      req.query.format === "json" ||
      req.headers.accept?.includes("application/json");

    const result = await buildGoogleOAuthUrl(req, platform);
    if ("error" in result) {
      if (wantsJson) {
        res.status(503).json({ error: result.error });
      } else {
        res.redirect(
          `${getFrontendUrl(req)}/join?mode=signin&error=oauth_failed`,
        );
      }
      return;
    }

    if (wantsJson) {
      res.status(200).json({ url: result.url, state: result.state });
      return;
    }

    res.cookie(
      "furlo_oauth_state",
      result.state,
      getCookieOptions(OAUTH_PKCE_TTL_MS),
    );
    res.redirect(result.url);
  } catch (err) {
    console.error("[auth] OAuth redirect error:", err);
    res.redirect(
      `${getFrontendUrl(req)}/join?mode=signin&error=oauth_failed`,
    );
  }
});

/**
 * POST /auth/oauth/exchange
 * Exchange PKCE code for session (mobile / JSON clients)
 */
router.post(
  "/oauth/exchange",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = oauthExchangeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const { data, error } = await exchangeOAuthCodeForSession(
        parsed.data.code,
        parsed.data.state,
      );

      if (error || !data.session) {
        res.status(400).json({
          error: error?.message || "Failed to complete Google sign-in.",
        });
        return;
      }

      const { access_token, refresh_token, user } = data.session;
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const context = await fetchUserContext(supabase, user.id);
      if (context?.user?.status && context.user.status !== "active") {
        res.status(403).json({
          error:
            accountBlockMessage(context.user.status) ||
            "This account has been suspended.",
        });
        return;
      }

      setSessionCookies(res, access_token, refresh_token);

      if (!context) {
        res.status(500).json({ error: "Failed to retrieve user context profile." });
        return;
      }

      res.status(200).json({
        user: context.user,
        activePet: context.activePet,
        session: {
          access_token,
          refresh_token,
        },
      });
    } catch (err) {
      console.error("[auth] OAuth exchange error:", err);
      res.status(500).json({ error: "Internal server error during OAuth exchange." });
    }
  },
);

/**
 * GET /auth/callback
 * Email verification & OAuth callback handler
 */
router.get("/callback", async (req: Request, res: Response): Promise<void> => {
  try {
    const code = req.query.code as string;
    const token_hash = req.query.token_hash as string;
    const type = req.query.type as string;
    const frontendUrl = process.env.FRONTEND_URL;

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    let sessionData: any = null;

    if (token_hash && type) {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash,
        type: type as any,
      });
      if (!error && data.session) {
        sessionData = data.session;
      }
    } else if (code) {
      const stateFromQuery = req.query.state as string | undefined;
      const stateFromCookie = getCookie(req, "furlo_oauth_state");
      const state = stateFromQuery?.trim() || stateFromCookie?.trim();
      const { data, error } = await exchangeOAuthCodeForSession(code, state);
      clearOAuthStateCookie(res);
      if (!error && data.session) {
        sessionData = data.session;
      }
    }

    if (!sessionData) {
      console.error("[auth] Auth callback failed to exchange session.");
      clearOAuthStateCookie(res);
      res.redirect(`${frontendUrl}/join?error=verification_failed`);
      return;
    }

    const { access_token, refresh_token, user } = sessionData;

    // Set secure cookies
    res.cookie(
      "furlo_session",
      access_token,
      getCookieOptions(COOKIE_SESSION_MAX_AGE),
    );
    res.cookie(
      "furlo_refresh",
      refresh_token,
      getCookieOptions(COOKIE_REFRESH_MAX_AGE),
    );

    // Query context to check if they have a pet profile (onboarded)
    const context = await fetchUserContext(supabase, user.id);

    // If user has an active pet profile already, send to feed. Otherwise send to profile creation section (/join/select).
    if (context && context.activePet) {
      res.redirect(`${frontendUrl}/feed`);
    } else {
      res.redirect(`${frontendUrl}/join/select`);
    }
  } catch (err) {
    console.error("[auth] Auth callback error:", err);
    res.redirect(`${process.env.FRONTEND_URL}/join?error=server_error`);
  }
});

/**
 * GET /auth/check-username
 * Checks if a pet username is available
 */
router.get(
  "/check-username",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const username = req.query.username as string;
    if (!username || username.length < 3 || username.length > 30) {
        res
          .status(400)
          .json({ error: "Username must be between 3 and 30 characters." });
        return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        res
          .status(400)
          .json({
            error:
              "Username can only contain alphanumeric characters and underscores.",
          });
        return;
      }

      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const { data: existingPet, error } = await supabase
        .from("pets")
        .select("id")
        .eq("username", username)
        .limit(1);

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

      const available = !existingPet || existingPet.length === 0;
      res.status(200).json({ available });
  } catch (err) {
      console.error("[auth] Check username error:", err);
      res
        .status(500)
        .json({ error: "Internal server error checking username." });
    }
  },
);

const petDateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const parsed = new Date(y, m - 1, d);
    if (
      parsed.getFullYear() !== y ||
      parsed.getMonth() !== m - 1 ||
      parsed.getDate() !== d
    ) {
      return false;
    }
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    return parsed.getTime() <= today.getTime();
  }, "Date of birth cannot be in the future");

function normalizePetDateOfBirthInput(
  body: Record<string, unknown>,
): string | null | undefined {
  if (!("dateOfBirth" in body) && !("date_of_birth" in body)) {
    return undefined;
  }
  const raw = body.dateOfBirth ?? body.date_of_birth;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error("Invalid date of birth");
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = petDateOfBirthSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || "Invalid date of birth");
  }
  return parsed.data;
}

const onboardingSetupSchema = z.object({
  role: z.enum(["parent", "lover"]).optional(),
  parentName: z
    .string()
    .trim()
    .min(2, "Pet parent name must be at least 2 characters"),
  termsAccepted: z
    .boolean()
    .refine((v) => v === true, { message: "You must accept the Terms of Service" }),
  marketingOptIn: z.boolean().optional().default(false),
  petName: z.string().min(1, "Name is required"),
  petUsername: z.string().optional(),
  petType: z.string().optional(),
  customPetType: z.string().optional(),
  breed: z.string().optional(),
  customBreed: z.string().optional(),
  city: z.string().min(1, "City is required"),
  gender: z.enum(["male", "female", "unknown"]).optional(),
  dateOfBirth: petDateOfBirthSchema.optional(),
  date_of_birth: petDateOfBirthSchema.optional(),
  bio: z.string().max(300).optional(),
  personalityTags: z.array(z.string()).optional(),
  customPersonalityTags: z.array(z.string()).optional(),
  avatarData: z.string().optional(),
  packs: z.array(z.string()).optional(),
});

/**
 * GET /auth/supabase-config
 * Public Realtime credentials for mobile (anon key only — never service_role).
 */
router.get(
  "/supabase-config",
  async (_req: Request, res: Response): Promise<void> => {
    if (!supabaseUrl || !supabaseAnonKey) {
      res
        .status(503)
        .json({ error: "Supabase anon config is not set on the server" });
      return;
    }

    if (jwtRole(supabaseAnonKey) === "service_role") {
      console.error(
        "[auth] SUPABASE_ANON_KEY is a service_role key — refusing to expose it",
      );
      res
        .status(503)
        .json({ error: "Supabase anon config is not set on the server" });
      return;
    }

    res.status(200).json({ supabaseUrl, supabaseAnonKey });
  },
);

/**
 * GET /auth/realtime-session
 * Access/refresh tokens so the browser can authenticate the Realtime socket.
 */
router.get(
  "/realtime-session",
  async (req: Request, res: Response): Promise<void> => {
    const access_token = getAccessToken(req);
    const refresh_token = getCookie(req, "furlo_refresh");
    if (!access_token || !refresh_token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.status(200).json({ access_token, refresh_token });
  },
);

/**
 * GET /auth/species-verbs
 * Returns all active species verb mappings from database
 */
router.get(
  "/species-verbs",
  async (_req: Request, res: Response): Promise<void> => {
  try {
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const { data, error } = await supabase
        .from("species_verbs")
        .select("id, species, label, verb, icon, is_active")
        .eq("is_active", true)
        .order("species", { ascending: true });

    if (error) {
      // Fallback if table not created yet
        res.status(200).json([]);
        return;
    }

      res.status(200).json(data || []);
  } catch (err) {
      console.error("[auth] Error fetching species verbs:", err);
      res.status(200).json([]);
  }
  },
);

/**
 * GET /auth/communities
 * Lists all active communities
 */
router.get(
  "/communities",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const { data, error } = await supabase
        .from("communities")
        .select("id, name, slug, description, cover_image_url, member_count")
        .eq("is_active", true);

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

      res.status(200).json(data);
  } catch (err) {
      console.error("[auth] Get communities error:", err);
      res
        .status(500)
        .json({ error: "Internal server error fetching communities." });
    }
  },
);

/**
 * POST /auth/complete-onboarding
 * Create pet/user profile in DB once verified and logged in
 */
router.post(
  "/complete-onboarding",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const parsed = onboardingSetupSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const session = await resolveSessionUser(req, res);
    if (!session?.user) {
        res.status(401).json({ error: "Unauthorized. Please login first." });
        return;
    }
      const user = session.user;
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // 1. Ensure user row exists in public.users table (mirroring auth.users)
    try {
        await supabase.from("users").upsert(
          {
        id: user.id,
        email: user.email!,
            auth_provider: "email",
        is_email_verified: Boolean(user.email_confirmed_at),
          },
          { onConflict: "id" },
        );
    } catch (uErr) {
        console.warn("[auth] Warning upserting user record:", uErr);
      }

      const {
        parentName,
        termsAccepted,
        marketingOptIn,
        role,
        petName,
        petUsername: rawUsername,
        petType,
        customPetType,
        breed,
        customBreed,
        city,
        gender,
        bio,
        personalityTags,
        customPersonalityTags,
        avatarData,
        packs,
        dateOfBirth,
        date_of_birth,
      } = parsed.data;

      const resolvedDateOfBirth = dateOfBirth ?? date_of_birth ?? null;

      const now = new Date().toISOString();
      const { error: profileError } = await supabase.from("profiles").upsert(
        {
          id: user.id,
          full_name: parentName,
          terms_accepted_at: now,
          marketing_opt_in: marketingOptIn ?? false,
          updated_at: now,
        },
        { onConflict: "id" },
      );
      if (profileError) {
        console.error("[auth] Profile upsert error:", profileError.message);
        res
          .status(500)
          .json({ error: `Failed to save profile: ${profileError.message}` });
        return;
      }

    // If username is provided, sanitize & check availability. Otherwise autogenerate a clean unique handle.
      let petUsername = rawUsername
        ? rawUsername.toLowerCase().replace(/[^a-z0-9_]/g, "")
        : "";
    if (!petUsername || petUsername.length < 3) {
        const cleanName =
          petName.toLowerCase().replace(/[^a-z0-9]/g, "") || "pet";
        petUsername = `${cleanName}_${Math.floor(1000 + Math.random() * 9000)}`;
    } else {
      const { data: existingPet } = await supabase
          .from("pets")
          .select("id")
          .eq("username", petUsername)
          .limit(1);

      if (existingPet && existingPet.length > 0) {
          petUsername = `${petUsername}_${Math.floor(100 + Math.random() * 900)}`;
      }
    }

    // Set profileImageUrl strictly from user avatarData uploaded during signup
      let profileImageUrl = avatarData || "";

    // Handle base64 avatar upload to Supabase storage if provided
      if (avatarData && avatarData.startsWith("data:image/")) {
      try {
          const matches = avatarData.match(
            /^data:([A-Za-z-+\/]+);base64,(.+)$/,
          );
        if (matches && matches.length === 3) {
            const mimeType = matches[1];
            const buffer = Buffer.from(matches[2], "base64");
            const extension = mimeType.split("/")[1] || "jpeg";
            const fileName = `${petUsername}_${Date.now()}.${extension}`;

            const { data: uploadData, error: uploadError } =
              await supabase.storage
                .from("pet-profiles")
            .upload(fileName, buffer, {
              contentType: mimeType,
              upsert: true,
                });

          if (uploadError) {
              console.warn(
                "[storage] Storage upload warning (using base64 fallback):",
                uploadError.message,
              );
              profileImageUrl = avatarData;
          } else {
              const {
                data: { publicUrl },
              } = supabase.storage.from("pet-profiles").getPublicUrl(fileName);
              profileImageUrl = publicUrl;
          }
        }
      } catch (uploadErr) {
          console.warn(
            "[storage] Exception during avatar upload, fallback to avatarData:",
            uploadErr,
          );
          profileImageUrl = avatarData;
        }
      } else if (
        avatarData &&
        (avatarData.startsWith("http://") || avatarData.startsWith("https://"))
      ) {
        profileImageUrl = avatarData;
    }

    // Construct pet payload
    const petInsertPayload: any = {
      owner_id: user.id,
      name: petName,
      username: petUsername,
        breed: breed || (role === "lover" ? "Pet Lover" : "Unknown"),
        city: city || "Bangalore",
        gender: gender || "unknown",
        bio: bio || "",
      personality_tags: personalityTags || [],
      profile_image_url: profileImageUrl,
        vaccination_status: "unknown",
      is_public: true,
      ...(resolvedDateOfBirth ? { date_of_birth: resolvedDateOfBirth } : {}),
      };

    // Check if pet profile already exists for this owner in database
    const { data: existingPet } = await supabase
        .from("pets")
        .select("id")
        .eq("owner_id", user.id)
        .limit(1);

      let petRecord: any = null;
      let insertError: any = null;

    if (existingPet && existingPet.length > 0) {
      // Update existing pet profile row in DB
        console.log(
          `[auth] Updating existing pet profile (${existingPet[0].id}) in DB...`,
        );
      const updateResult = await supabase
          .from("pets")
        .update({
          name: petName,
          username: petUsername,
            breed: breed || (role === "lover" ? "Pet Lover" : "Unknown"),
            city: city || "Bangalore",
            gender: gender || "unknown",
            bio: bio || "",
          personality_tags: personalityTags || [],
          profile_image_url: profileImageUrl,
          date_of_birth: resolvedDateOfBirth,
          updated_at: new Date().toISOString(),
        })
          .eq("id", existingPet[0].id)
        .select()
          .single();

        petRecord = updateResult.data;
        insertError = updateResult.error;
    } else {
      // Insert new pet profile into DB
      let insertResult = await supabase
          .from("pets")
        .insert({
          ...petInsertPayload,
            pet_type: petType || (role === "lover" ? "lover" : "dogs"),
        })
        .select()
          .single();

        if (
          insertResult.error &&
          (insertResult.error.message.includes("pet_type") ||
            insertResult.error.code === "PGRST204")
        ) {
          console.log("[auth] Retrying pet insert without pet_type column...");
        insertResult = await supabase
            .from("pets")
          .insert(petInsertPayload)
          .select()
            .single();
      }

        petRecord = insertResult.data;
        insertError = insertResult.error;
    }

    if (insertError) {
        console.error(
          "[auth] Error inserting pet profile to DB:",
          insertError.message,
        );
        res
          .status(500)
          .json({ error: `Failed to save profile: ${insertError.message}` });
        return;
    }

    // Record custom breed/pet_type/personality_tags for admin catalog approval notification
      if (
        customBreed ||
        customPetType ||
        (customPersonalityTags && customPersonalityTags.length > 0)
      ) {
        try {
          const approvalsToInsert: any[] = [];
        if (customBreed) {
          approvalsToInsert.push({
            pet_id: petRecord.id,
              submission_type: "breed",
              pet_type: petType || "dogs",
            name: customBreed,
              status: "pending",
            });
        }
        if (customPetType) {
          approvalsToInsert.push({
            pet_id: petRecord.id,
              submission_type: "pet_type",
            pet_type: customPetType,
            name: customPetType,
              status: "pending",
            });
        }
        if (customPersonalityTags && customPersonalityTags.length > 0) {
          customPersonalityTags.forEach((tag) => {
            approvalsToInsert.push({
              pet_id: petRecord.id,
                submission_type: "personality_tag",
                pet_type: petType || "dogs",
              name: tag,
                status: "pending",
              });
            });
          }
          await supabase
            .from("pending_breed_approvals")
            .insert(approvalsToInsert);
      } catch (approvalErr) {
          console.error(
            "[auth] Exception logging pending breed/tag approval:",
            approvalErr,
          );
      }
    }

    // Join communities if selected
    if (packs && packs.length > 0) {
      try {
        const { data: dbCommunities, error: commError } = await supabase
            .from("communities")
            .select("id, slug")
            .in("slug", packs);

        if (!commError && dbCommunities && dbCommunities.length > 0) {
          const memberRows = dbCommunities.map((c) => ({
            community_id: c.id,
            pet_id: petRecord.id,
            }));

          const { error: joinError } = await supabase
              .from("community_members")
              .insert(memberRows);

          if (joinError) {
              console.error(
                "[auth] Error joining communities:",
                joinError.message,
              );
          }
        }
      } catch (joinErr) {
          console.error("[auth] Exception while joining communities:", joinErr);
      }
    }

    petRecord = {
      ...petRecord,
      pet_type:
        petType ||
        inferPetTypeFromBreed(petRecord?.breed) ||
        (role === "lover" ? "lover" : "dogs"),
    };

    res.status(200).json({
        message: "Profile setup completed successfully!",
      pet: petRecord,
      });
  } catch (err) {
      console.error("[auth] Complete onboarding error:", err);
      res
        .status(500)
        .json({ error: "Internal server error during onboarding setup." });
    }
  },
);

/**
 * PUT /auth/update-pet-profile
 * Updates active pet profile photo & details in database
 */
router.put(
  "/update-pet-profile",
  async (req: Request, res: Response): Promise<void> => {
  try {
      const accessToken = getAccessToken(req);
    if (!accessToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
        res.status(401).json({ error: "Invalid session" });
        return;
    }

      const {
        petId,
        name,
        username,
        breed,
        city,
        bio,
        avatarData,
        removeAvatar,
        personalityTags,
        personality_tags,
      } = req.body;

      let dateOfBirthUpdate: string | null | undefined;
      try {
        dateOfBirthUpdate = normalizePetDateOfBirthInput(req.body);
      } catch (e) {
        res.status(400).json({
          error: e instanceof Error ? e.message : "Invalid date of birth",
        });
        return;
      }

      let profileImageUrl: string | undefined = undefined;

      if (avatarData === "" || removeAvatar === true) {
        profileImageUrl = "";
      } else if (avatarData && avatarData.startsWith("data:image/")) {
      try {
          const matches = avatarData.match(
            /^data:([A-Za-z-+\/]+);base64,(.+)$/,
          );
        if (matches && matches.length === 3) {
            const mimeType = matches[1];
            const buffer = Buffer.from(matches[2], "base64");
            const extension = mimeType.split("/")[1] || "jpeg";
            const fileName = `pet_${user.id}_${Date.now()}.${extension}`;

          const { error: uploadError } = await supabase.storage
              .from("pet-profiles")
              .upload(fileName, buffer, {
                contentType: mimeType,
                upsert: true,
              });

          if (!uploadError) {
              const {
                data: { publicUrl },
              } = supabase.storage.from("pet-profiles").getPublicUrl(fileName);
              profileImageUrl = publicUrl;
          } else {
              profileImageUrl = avatarData;
          }
        }
      } catch (e) {
          profileImageUrl = avatarData;
      }
    } else if (avatarData !== undefined) {
        profileImageUrl = avatarData;
    }

      const tags = personality_tags || personalityTags;

    const updatePayload: any = {
      ...(name && { name }),
        ...(username && { username: username.replace(/^@/, '') }),
      ...(breed && { breed }),
      ...(city && { city }),
      ...(bio !== undefined && { bio }),
        ...(tags && { personality_tags: tags }),
        ...(profileImageUrl !== undefined && {
          profile_image_url: profileImageUrl,
        }),
        ...(dateOfBirthUpdate !== undefined && {
          date_of_birth: dateOfBirthUpdate,
        }),
      updated_at: new Date().toISOString(),
      };

      const query = supabase.from("pets").update(updatePayload);
      const { data: updatedPets, error } = petId
        ? await query.eq("id", petId).eq("owner_id", user.id).select()
        : await query.eq("owner_id", user.id).select();

      if (error || !updatedPets || updatedPets.length === 0) {
        res.status(500).json({ error: error?.message || "Pet profile not found" });
        return;
      }

      const updatedPet = updatedPets[0];

      res.status(200).json({ pet: updatedPet });
    } catch (err) {
      console.error("[auth] Update pet profile error:", err);
      res.status(500).json({ error: "Failed to update pet profile" });
    }
  },
);

/**
 * GET /auth/pet/:id
 * Public endpoint to fetch pet details, owner details, and their posts
 */
router.get("/pet/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const param = String(req.params.id);
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        param,
      );

    const { data: pets, error: petError } = isUuid
      ? await supabase
          .from("pets")
          .select(
            "id, owner_id, name, username, breed, city, gender, bio, personality_tags, profile_image_url, date_of_birth, created_at, is_verified, is_founding_pet",
          )
          .eq("id", param)
          .limit(1)
      : await supabase
          .from("pets")
          .select(
            "id, owner_id, name, username, breed, city, gender, bio, personality_tags, profile_image_url, date_of_birth, created_at, is_verified, is_founding_pet",
          )
          .eq("username", param)
          .limit(1);

    const petRecord = pets && pets.length > 0 ? pets[0] : null;

    if (petError || !petRecord) {
      res.status(404).json({ error: "Pet profile not found" });
      return;
    }

    let ownerUser = null;
    if (petRecord.owner_id) {
      const [{ data: owner }, { data: profile }] = await Promise.all([
        supabase
          .from("users")
          .select("id, email")
          .eq("id", petRecord.owner_id)
          .single(),
        supabase
          .from("profiles")
          .select("id, full_name")
          .eq("id", petRecord.owner_id)
          .maybeSingle(),
      ]);
      if (owner) {
        ownerUser = {
          id: owner.id,
          email: owner.email,
          name: profile?.full_name,
        };
      }
    }

    const pet = {
      ...attachPetType(petRecord),
      users: ownerUser,
    };

    const [{ count: barksCount }, { data: likeRows }] = await Promise.all([
      supabase
        .from("posts")
        .select("id", { count: "exact", head: true })
        .eq("pet_id", petRecord.id)
        .eq("status", "active"),
      supabase
        .from("posts")
        .select("like_count")
        .eq("pet_id", petRecord.id)
        .eq("status", "active"),
    ]);

    const treatsCount = (likeRows || []).reduce(
      (sum, p) => sum + (p.like_count || 0),
      0,
    );

    const [followsRes, followingRes] = await Promise.all([
      (async () => {
        try {
          const r = await supabase
            .from("follows")
            .select("id", { count: "exact", head: true })
            .eq("following_pet_id", petRecord.id);
          return r.count ?? 0;
        } catch {
          return 0;
        }
      })(),
      (async () => {
        try {
          const r = await supabase
            .from("follows")
            .select("id", { count: "exact", head: true })
            .eq("follower_pet_id", petRecord.id);
          return r.count ?? 0;
        } catch {
          return 0;
        }
      })(),
    ]);

    const packMembersCount = followsRes || 0;
    const followingCount = followingRes || 0;

    let isFollowing = false;
    let hasWagged = false;
    const viewerPetId =
      typeof req.query.viewerPetId === "string" ? req.query.viewerPetId : "";
    if (viewerPetId && viewerPetId !== petRecord.id) {
      const [{ data: followRow }, { data: wagRow }] = await Promise.all([
        supabase
          .from("follows")
          .select("id")
          .eq("follower_pet_id", viewerPetId)
          .eq("following_pet_id", petRecord.id)
          .maybeSingle(),
        supabase
          .from("wags")
          .select("id")
          .eq("sender_pet_id", viewerPetId)
          .eq("target_pet_id", petRecord.id)
          .limit(1)
          .maybeSingle(),
      ]);
      isFollowing = Boolean(followRow);
      hasWagged = Boolean(wagRow);
    }

    res.status(200).json({
      pet,
      posts: [],
      stats: {
        barksCount: barksCount || 0,
        packMembersCount,
        followingCount,
        treatsCount,
        isFollowing,
        hasWagged,
      },
    });
  } catch (err) {
    console.error("[auth] Get pet profile error:", err);
    res.status(500).json({ error: "Failed to fetch pet profile" });
  }
});

/**
 * POST /auth/follow-pet
 * Toggle follow/unfollow status for a pet profile
 */
router.post("/follow-pet", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { targetPetId, followerPetId } = req.body;
    if (!targetPetId) {
      res.status(400).json({ error: "Target pet ID is required" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    let activeFollowerId = followerPetId;
    if (!activeFollowerId) {
      const { data: myPets } = await supabase
        .from("pets")
        .select("id")
        .eq("owner_id", user.id)
        .limit(1);

      if (myPets && myPets.length > 0) {
        activeFollowerId = myPets[0].id;
      }
    }

    if (!activeFollowerId) {
      res.status(400).json({ error: "No active pet profile found to follow with" });
      return;
    }

    if (activeFollowerId === targetPetId) {
      res.status(400).json({ error: "You cannot follow your own pet profile" });
      return;
    }

    const { data: existingFollow } = await supabase
      .from("follows")
      .select("id")
      .eq("follower_pet_id", activeFollowerId)
      .eq("following_pet_id", targetPetId)
      .maybeSingle();

    let isFollowing = false;

    if (existingFollow) {
      await supabase.from("follows").delete().eq("id", existingFollow.id);
      isFollowing = false;
    } else {
      await supabase.from("follows").insert({
        follower_pet_id: activeFollowerId,
        following_pet_id: targetPetId,
      });
      isFollowing = true;
    }

    const [{ count: packMembersCount }, { count: followingCount }] =
      await Promise.all([
        supabase
          .from("follows")
          .select("id", { count: "exact", head: true })
          .eq("following_pet_id", targetPetId),
        supabase
          .from("follows")
          .select("id", { count: "exact", head: true })
          .eq("follower_pet_id", activeFollowerId),
      ]);

    const payload = {
      targetPetId,
      followerPetId: activeFollowerId,
      following: isFollowing,
      packMembersCount: packMembersCount ?? 0,
      followingCount: followingCount ?? 0,
    };

    await broadcastFollow(payload).catch((err) => {
      console.error("[auth] Follow broadcast failed:", err);
    });

    if (isFollowing) {
      try {
        const { data: targetPet } = await supabase
          .from("pets")
          .select("id, name, owner_id")
          .eq("id", targetPetId)
          .single();

        if (targetPet?.owner_id) {
          const { data: followerPet } = await supabase
            .from("pets")
            .select("name")
            .eq("id", activeFollowerId)
            .single();

          await createNotificationHelper(supabase, {
            userId: targetPet.owner_id,
            recipientPetId: targetPetId,
            actorPetId: activeFollowerId,
            type: "follow",
            title: "New Wag & Follow 🐕",
            body: `${followerPet?.name || "A pet"} started following ${targetPet.name || "your pet"}`,
            entityType: "pet",
            entityId: targetPetId,
          });
        }
      } catch (err) {
        console.error("[auth] Follow notification error:", err);
      }
    }

    res.status(200).json({
      success: true,
      ...payload,
    });
  } catch (err) {
    console.error("[auth] Follow pet error:", err);
    res.status(500).json({ error: "Failed to update follow status" });
  }
});

async function resolvePetId(supabase: any, param: string): Promise<string | null> {
  if (!param) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
  if (isUuid) return param;
  const { data } = await supabase.from("pets").select("id").eq("username", param).limit(1).maybeSingle();
  return data?.id || null;
}

/**
 * GET /auth/pet/:id/pack-members
 * Fetch list of follower pet profiles for pack members modal
 */
router.get("/pet/:id/pack-members", async (req: Request, res: Response): Promise<void> => {
  try {
    const param = String(req.params.id);
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const petId = await resolvePetId(supabase, param);

    if (!petId) {
      res.status(404).json({ error: "Pet profile not found" });
      return;
    }

    const { data: follows, error } = await supabase
      .from("follows")
      .select("follower_pet:follower_pet_id (id, name, username, breed, city, profile_image_url)")
      .eq("following_pet_id", petId);

    if (error) {
      res.status(500).json({ error: "Failed to fetch pack members" });
      return;
    }

    const members = (follows || [])
      .map((f: any) => {
        const pet = f.follower_pet;
        return Array.isArray(pet) ? pet[0] : pet;
      })
      .filter(Boolean);
    res.status(200).json({ members });
  } catch (err) {
    console.error("[auth] Pack members fetch error:", err);
    res.status(500).json({ error: "Failed to fetch pack members" });
  }
});

/**
 * GET /auth/pet/:id/following
 * Fetch list of pet profiles that this pet is following
 */
router.get("/pet/:id/following", async (req: Request, res: Response): Promise<void> => {
  try {
    const param = String(req.params.id);
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const petId = await resolvePetId(supabase, param);

    if (!petId) {
      res.status(404).json({ error: "Pet profile not found" });
      return;
    }

    const { data: follows, error } = await supabase
      .from("follows")
      .select("following_pet:following_pet_id (id, name, username, breed, city, profile_image_url)")
      .eq("follower_pet_id", petId);

    if (error) {
      res.status(500).json({ error: "Failed to fetch following list" });
      return;
    }

    const members = (follows || [])
      .map((f: any) => {
        const pet = f.following_pet;
        return Array.isArray(pet) ? pet[0] : pet;
      })
      .filter(Boolean);
    res.status(200).json({ following: members, members, count: members.length });
  } catch (err) {
    console.error("[auth] Following fetch error:", err);
    res.status(500).json({ error: "Failed to fetch following list" });
  }
});

/**
 * POST /auth/send-wag
 * Send a tail wag interaction to a pet profile
 */
router.post("/send-wag", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { targetPetId, senderPetId } = req.body;
    if (!targetPetId) {
      res.status(400).json({ error: "Target pet ID is required" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    let activeSenderId = senderPetId;
    if (!activeSenderId) {
      const { data: myPets } = await supabase
        .from("pets")
        .select("id")
        .eq("owner_id", user.id)
        .limit(1);

      if (myPets && myPets.length > 0) {
        activeSenderId = myPets[0].id;
      }
    }

    if (!activeSenderId) {
      res.status(400).json({ error: "No active pet profile found to send a wag" });
      return;
    }

    if (activeSenderId === targetPetId) {
      res.status(400).json({ error: "You cannot send a wag to your own pet" });
      return;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("wags")
      .insert({
        sender_pet_id: activeSenderId,
        target_pet_id: targetPetId,
        message: "Wagged at your profile! 🐾",
        created_at: new Date().toISOString(),
      })
      .select("id, created_at, message")
      .maybeSingle();

    if (insertError) {
      console.warn("[auth] Wag insert:", insertError.message);
    }

    const { data: senderPets } = await supabase
      .from("pets")
      .select("id, name, username, breed, profile_image_url")
      .eq("id", activeSenderId)
      .limit(1);
    const sender = senderPets && senderPets.length > 0 ? senderPets[0] : null;

    const wagId = inserted?.id || `wag-${Date.now()}`;
    const createdAt = inserted?.created_at || new Date().toISOString();

    await broadcastWag({
      id: wagId,
      targetPetId,
      senderPetId: activeSenderId,
      senderName: sender?.name,
      senderUsername: sender?.username,
      senderAvatar: sender?.profile_image_url,
      senderBreed: sender?.breed,
      created_at: createdAt,
      message: inserted?.message || "Wagged at your profile! 🐾",
    }).catch((err) => {
      console.error("[auth] Wag broadcast failed:", err);
    });

    try {
      const { data: targetPet } = await supabase
        .from("pets")
        .select("id, name, owner_id")
        .eq("id", targetPetId)
        .single();

      if (targetPet?.owner_id) {
        await createNotificationHelper(supabase, {
          userId: targetPet.owner_id,
          recipientPetId: targetPetId,
          actorPetId: activeSenderId,
          type: "follow",
          title: "New Wag 🐾",
          body: `${sender?.name || "A pet"} sent a tail wag to ${targetPet.name || "your pet"}!`,
          entityType: "pet",
          entityId: activeSenderId,
          metadata: { subtext: "Wagged at your profile", isWag: true },
        });
      }
    } catch (err) {
      console.error("[auth] Wag notification error:", err);
    }

    res.status(200).json({
      success: true,
      message: "Wag sent successfully! 🐾",
      targetPetId,
      senderPetId: activeSenderId,
    });
  } catch (err) {
    console.error("[auth] Send wag error:", err);
    res.status(500).json({ error: "Failed to send wag" });
  }
});

/**
 * GET /auth/wags
 * Tail wags received by a pet (Alerts inbox)
 */
router.get("/wags", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    let petId = typeof req.query.petId === "string" ? req.query.petId : "";
    if (!petId) {
      const { data: myPets } = await supabase
        .from("pets")
        .select("id")
        .eq("owner_id", user.id)
        .limit(1);
      petId = myPets && myPets.length > 0 ? myPets[0].id : "";
    }

    if (!petId) {
      res.status(200).json({ wags: [] });
      return;
    }

    const { data: rows, error } = await supabase
      .from("wags")
      .select(
        "id, created_at, message, sender_pet:sender_pet_id (id, name, username, breed, profile_image_url)",
      )
      .eq("target_pet_id", petId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.warn("[auth] Fetch wags:", error.message);
      res.status(200).json({ wags: [] });
      return;
    }

    const wags = (rows || [])
      .map((row: any) => {
        const sender = Array.isArray(row.sender_pet)
          ? row.sender_pet[0]
          : row.sender_pet;
        if (!sender?.id) return null;
        return {
          id: row.id,
          created_at: row.created_at,
          message: row.message,
          sender,
        };
      })
      .filter(Boolean);

    res.status(200).json({ wags });
  } catch (err) {
    console.error("[auth] Fetch wags error:", err);
    res.status(500).json({ error: "Failed to fetch wags" });
  }
});

/**
 * GET /auth/pet-lover/:id
 * Public endpoint to fetch pet lover details, their pets, and recent posts
 */
router.get(
  "/pet-lover/:id",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = String(req.params.id);
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const { data: user } = await supabase
        .from("users")
        .select("id, email, name, avatar_url, created_at")
        .eq("id", userId)
        .single();

      let loverUser = user;

      if (!loverUser) {
        try {
          const { data: authUserData } =
            await supabase.auth.admin.getUserById(userId);
          if (authUserData?.user) {
            loverUser = {
              id: authUserData.user.id,
              email: authUserData.user.email || "",
              name: authUserData.user.user_metadata?.name || "Pet Parent",
              avatar_url: authUserData.user.user_metadata?.avatar_url || "",
              created_at: authUserData.user.created_at,
            };
          }
        } catch (authErr) {
          console.warn("[auth] Error fetching auth user by id:", authErr);
        }
      }

      if (!loverUser) {
        res.status(404).json({ error: "Pet lover profile not found" });
        return;
      }

      const { data: pets } = await supabase
        .from("pets")
        .select(
          "id, name, username, breed, city, bio, profile_image_url, personality_tags",
        )
        .eq("owner_id", userId);

      const petIds = (pets || []).map((p) => p.id);

      let posts: any[] = [];
      if (petIds.length > 0) {
        const { data: userPosts } = await supabase
          .from("posts")
          .select(`
          id,
          caption,
          post_type,
          location_city,
          like_count,
          comment_count,
          status,
          created_at,
          pets:pet_id (
            id,
            name,
            username,
            breed,
            city,
            profile_image_url
          ),
          communities:community_id (
            id,
            name,
            slug
          ),
          post_media (
            id,
            media_url,
            display_order
          )
        `)
          .in("pet_id", petIds)
          .eq("status", "active")
          .order("created_at", { ascending: false });

        posts = (userPosts || []).map((post) => ({
          ...post,
          media:
            post.post_media?.sort(
              (a, b) => a.display_order - b.display_order,
            ) || [],
        }));
      }

      res.status(200).json({ lover: loverUser, pets: pets || [], posts });
    } catch (err) {
      console.error("[auth] Get pet lover error:", err);
      res.status(500).json({ error: "Failed to fetch pet lover profile" });
    }
  },
);

/**
 * GET /auth/my-pets
 * Fetch all pets owned by the authenticated user for multi-pet switcher
 */
router.get("/my-pets", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { data: pets, error: petsError } = await supabase
      .from("pets")
      .select("id, owner_id, name, username, breed, city, gender, bio, personality_tags, profile_image_url, created_at")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: true });

    if (petsError) {
      res.status(500).json({ error: petsError.message });
      return;
    }

    res.status(200).json({ pets: (pets || []).map((p) => attachPetType(p)) });
  } catch (err) {
    console.error("[auth] Get my pets error:", err);
    res.status(500).json({ error: "Failed to fetch user pets" });
  }
});

/**
 * GET /auth/pet/:id/pack-members
 * Fetch pack members (followers and companion pets) for a pet
 */
router.get(
  "/pet/:id/pack-members",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const param = String(req.params.id);
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          param,
        );

      const { data: pets } = isUuid
        ? await supabase
            .from("pets")
            .select("id")
            .eq("id", param)
            .limit(1)
        : await supabase
            .from("pets")
            .select("id")
            .eq("username", param)
            .limit(1);

      const targetPet = pets && pets.length > 0 ? pets[0] : null;

      if (!targetPet) {
        res.status(404).json({ error: "Pet profile not found" });
        return;
      }

      // Query followers from follows table
      let packPets: any[] = [];
      try {
        const { data: followRows } = await supabase
          .from("follows")
          .select("follower_pet_id")
          .eq("following_pet_id", targetPet.id);

        const followerIds = (followRows || [])
          .map((r: { follower_pet_id: string }) => r.follower_pet_id)
          .filter(Boolean);

        if (followerIds.length > 0) {
          const { data: followerPets } = await supabase
            .from("pets")
            .select(
              "id, name, username, breed, city, bio, profile_image_url, personality_tags",
            )
            .in("id", followerIds);
          packPets = followerPets || [];
        }
      } catch (e) {
        console.warn("[auth] Query follows error:", e);
      }

      // Fallback if pack is empty: fetch other pets in same city
      if (packPets.length === 0) {
        const { data: fallbackPets } = await supabase
          .from("pets")
          .select(
            "id, name, username, breed, city, bio, profile_image_url, personality_tags",
          )
          .neq("id", targetPet.id)
          .limit(10);
        packPets = fallbackPets || [];
      }

      res.status(200).json({ packMembers: packPets, count: packPets.length });
    } catch (err) {
      console.error("[auth] Get pack members error:", err);
      res.status(500).json({ error: "Failed to fetch pack members" });
    }
  },
);

/**
 * POST /auth/follow-pet
 * Toggle follow/unfollow a pet
 */
router.post(
  "/follow-pet",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accessToken = getAccessToken(req);
      if (!accessToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { targetPetId, followerPetId } = req.body;
      if (!targetPetId || !followerPetId) {
        res.status(400).json({ error: "targetPetId and followerPetId are required" });
        return;
      }

      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      // Check existing follow
      const { data: existingFollow } = await supabase
        .from("follows")
        .select("id")
        .eq("following_pet_id", targetPetId)
        .eq("follower_pet_id", followerPetId)
        .limit(1);

      let isFollowing = false;
      if (existingFollow && existingFollow.length > 0) {
        // Unfollow
        await supabase
          .from("follows")
          .delete()
          .eq("id", existingFollow[0].id);
        isFollowing = false;
      } else {
        // Follow
        await supabase
          .from("follows")
          .insert({
            following_pet_id: targetPetId,
            follower_pet_id: followerPetId,
            created_at: new Date().toISOString(),
          });
        isFollowing = true;
      }

      // Count updated followers
      const { count } = await supabase
        .from("follows")
        .select("id", { count: "exact", head: true })
        .eq("following_pet_id", targetPetId);

      res.status(200).json({ isFollowing, packMembersCount: count || 0 });
    } catch (err) {
      console.error("[auth] Follow pet error:", err);
      res.status(500).json({ error: "Failed to update follow status" });
    }
  },
);

export default router;
