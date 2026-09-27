import { normalizeEmail } from "./authIdentity.js";
import { resetAuthEmailStrikes } from "./rateLimitStore.js";

export function resetAuthRateLimitAfterSuccess(email: unknown): void {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return;
  }
  void resetAuthEmailStrikes(normalized);
}
