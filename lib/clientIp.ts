import type { Request } from "express";

/**
 * Client IP for rate limiting.
 * Prefer x-furlo-client-ip (Next proxy replace mode), then first x-forwarded-for hop, then Express req.ip.
 */
export function getClientIp(req: Request): string {
  const furloIp = req.headers["x-furlo-client-ip"];
  if (typeof furloIp === "string" && furloIp.trim()) {
    return furloIp.trim();
  }

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  if (Array.isArray(xff) && xff[0]) {
    const first = String(xff[0]).split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}
