import type { Request } from "express";

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function getEmailFromAuthBody(req: Request): string | null {
  const body = req.body as { email?: unknown } | undefined;
  return normalizeEmail(body?.email);
}
