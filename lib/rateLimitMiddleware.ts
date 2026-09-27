import type { NextFunction, Request, Response } from "express";
import { getEmailFromAuthBody } from "./authIdentity.js";
import { getClientIp } from "./clientIp.js";
import {
  consumeAuthEmailLimit,
  consumeAuthIpLimit,
  consumePublicIpLimit,
  consumeUserLimit,
  type ConsumeRateLimitResult,
} from "./rateLimitStore.js";
import {
  extractAccessTokenFromRequest,
  verifySupabaseAccessToken,
} from "./supabaseJwt.js";

const AUTH_SENSITIVE_POST_PATHS = new Set([
  "/signup",
  "/login",
  "/resend-confirmation",
  "/verify-email-otp",
  "/oauth/exchange",
]);

function isHealthOrOptions(req: Request): boolean {
  if (req.method === "OPTIONS") {
    return true;
  }
  return req.method === "GET" && (req.path === "/health" || req.originalUrl === "/health");
}

function isAuthSensitivePost(req: Request): boolean {
  if (req.method !== "POST") {
    return false;
  }
  const base = req.baseUrl || "";
  if (base !== "/auth") {
    return false;
  }
  return AUTH_SENSITIVE_POST_PATHS.has(req.path);
}

function sendRateLimitResponse(res: Response, result: ConsumeRateLimitResult): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "Too many requests. Please wait before trying again.",
    retryAfterSeconds,
  });
}

function mergeWorstResult(
  a: ConsumeRateLimitResult | null,
  b: ConsumeRateLimitResult | null,
): ConsumeRateLimitResult | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (!a.allowed) {
    return a;
  }
  if (!b.allowed) {
    return b;
  }
  return a;
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isHealthOrOptions(req)) {
    next();
    return;
  }

  void (async () => {
    try {
      const clientIp = getClientIp(req);

      if (isAuthSensitivePost(req)) {
        const email = getEmailFromAuthBody(req);
        let worst: ConsumeRateLimitResult | null = null;
        let rpcFailed = false;

        if (email) {
          const emailResult = await consumeAuthEmailLimit(email);
          if (emailResult === null) {
            rpcFailed = true;
          } else {
            worst = mergeWorstResult(worst, emailResult);
          }
        }

        const ipResult = await consumeAuthIpLimit(clientIp);
        if (ipResult === null) {
          rpcFailed = true;
        } else {
          worst = mergeWorstResult(worst, ipResult);
        }

        if (rpcFailed) {
          console.error("[rate-limit] auth limit RPC unavailable");
          res.status(503).json({ error: "Rate limiting temporarily unavailable." });
          return;
        }

        if (worst && !worst.allowed) {
          sendRateLimitResponse(res, worst);
          return;
        }

        next();
        return;
      }

      const token = extractAccessTokenFromRequest(
        req.headers.cookie,
        req.headers.authorization,
      );
      const verified = await verifySupabaseAccessToken(token);

      if (verified) {
        const userResult = await consumeUserLimit(verified.sub);
        if (userResult === null) {
          res.status(503).json({ error: "Rate limiting temporarily unavailable." });
          return;
        }
        if (!userResult.allowed) {
          sendRateLimitResponse(res, userResult);
          return;
        }
        next();
        return;
      }

      const publicResult = await consumePublicIpLimit(clientIp);
      if (publicResult === null) {
        res.status(503).json({ error: "Rate limiting temporarily unavailable." });
        return;
      }
      if (!publicResult.allowed) {
        sendRateLimitResponse(res, publicResult);
        return;
      }

      next();
    } catch (err) {
      console.error("[rate-limit] middleware error:", err);
      next(err);
    }
  })();
}
