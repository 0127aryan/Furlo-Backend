import { createClient } from "@supabase/supabase-js";

import { getFirebaseMessaging } from "./firebaseAdmin.js";

type NotificationRow = {
  id?: string;
  type?: string;
  title?: string;
  body?: string;
  actor_pet_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

type UserSettings = {
  master_push_enabled: boolean;
  treats_enabled: boolean;
  comments_enabled: boolean;
  followers_enabled: boolean;
  qa_answers_enabled: boolean;
  qa_best_answer_enabled: boolean;
  pack_announcements_enabled: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function resolveNotificationType(row: NotificationRow): string {
  const metaType = row.metadata?.notificationType;
  if (typeof metaType === "string" && metaType.length > 0) return metaType;
  return row.type || "system";
}

function isPushEnabledForType(settings: UserSettings, type: string): boolean {
  if (!settings.master_push_enabled) return false;
  if (type === "treat" && !settings.treats_enabled) return false;
  if (type === "comment" && !settings.comments_enabled) return false;
  if (type === "follow" && !settings.followers_enabled) return false;
  if (type === "best_answer" && !settings.qa_best_answer_enabled) return false;
  if (type === "qa_answer" && !settings.qa_answers_enabled) return false;
  if (type === "pack_announcement" && !settings.pack_announcements_enabled) return false;
  return true;
}

function getLocalMinutes(timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function parseTimeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour || 0) * 60 + (minute || 0);
}

function isWithinQuietHours(settings: UserSettings): boolean {
  if (!settings.quiet_hours_enabled) return false;

  const current = getLocalMinutes(settings.timezone || "UTC");
  const start = parseTimeToMinutes(settings.quiet_hours_start || "22:00");
  const end = parseTimeToMinutes(settings.quiet_hours_end || "07:00");

  if (start <= end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function getAndroidChannelId(type: string): string {
  if (type === "best_answer" || type === "qa_answer") return "furlo_qa_advice";
  if (type === "treat" || type === "comment") return "furlo_interactions";
  if (type === "follow" || type === "pack_announcement") return "furlo_pack_followers";
  return "default";
}

function buildWebPushLink(row: NotificationRow): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.WEB_APP_URL ||
    "http://localhost:3000";
  const linkUrl = row.metadata?.linkUrl;
  if (typeof linkUrl === "string" && linkUrl.startsWith("http")) return linkUrl;
  if (typeof linkUrl === "string" && linkUrl.startsWith("/")) return `${siteUrl}${linkUrl}`;
  if (row.entity_type === "post" && row.entity_id) return `${siteUrl}/qa/${row.entity_id}`;
  if (row.entity_type === "pet" && row.entity_id) return `${siteUrl}/pet/${row.entity_id}`;
  if (row.actor_pet_id) return `${siteUrl}/pet/${row.actor_pet_id}`;
  return `${siteUrl}/notifications`;
}

async function deleteInvalidTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("user_push_tokens").delete().in("token", tokens);
  if (error) {
    console.error("[push] Failed to delete invalid tokens:", error);
  }
}

export async function sendPushForNotification(
  userId: string,
  row: NotificationRow
): Promise<void> {
  try {
    const supabase = getSupabase();
    const messaging = getFirebaseMessaging();
    if (!supabase || !messaging) {
      console.warn("[push] Skipped — supabase or firebase messaging unavailable");
      return;
    }

    const { data: settings } = await supabase
      .from("user_notification_settings")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!settings) {
      console.warn("[push] Skipped — no settings for user", userId);
      return;
    }

    const notificationType = resolveNotificationType(row);
    if (!isPushEnabledForType(settings as UserSettings, notificationType)) {
      console.log("[push] Skipped — disabled for type", notificationType, "user", userId);
      return;
    }
    if (isWithinQuietHours(settings as UserSettings)) {
      console.log("[push] Skipped — quiet hours for user", userId);
      return;
    }

    const { data: tokenRows, error: tokenError } = await supabase
      .from("user_push_tokens")
      .select("token")
      .eq("user_id", userId);

    if (tokenError || !tokenRows?.length) {
      console.log("[push] Skipped — no tokens for user", userId, tokenError?.message);
      return;
    }

    const tokens = tokenRows.map((r: { token: string }) => r.token).filter(Boolean);
    if (tokens.length === 0) return;

    const channelId = getAndroidChannelId(notificationType);
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: row.title || "Furlo",
        body: row.body || "",
      },
      data: {
        notificationId: row.id || "",
        type: notificationType,
        entityType: row.entity_type || "",
        entityId: row.entity_id || "",
        actorPetId: row.actor_pet_id || "",
        linkUrl:
          typeof row.metadata?.linkUrl === "string" ? row.metadata.linkUrl : "",
      },
      android: {
        priority: "high",
        notification: {
          channelId,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
      webpush: {
        notification: {
          title: row.title || "Furlo",
          body: row.body || "",
          icon: "/logo.png",
        },
        fcmOptions: {
          link: buildWebPushLink(row),
        },
      },
    });

    console.log(
      "[push] FCM result:",
      response.successCount,
      "sent,",
      response.failureCount,
      "failed, user",
      userId,
      "channel",
      channelId
    );

    const staleTokens: string[] = [];
    response.responses.forEach((result: { success: boolean; error?: { code?: string; message?: string } }, index: number) => {
      if (result.success) return;
      console.warn("[push] FCM token error:", result.error?.code, result.error?.message);
      const code = result.error?.code || "";
      if (INVALID_TOKEN_CODES.has(code)) {
        staleTokens.push(tokens[index]);
      }
    });

    await deleteInvalidTokens(staleTokens);
  } catch (err) {
    console.error("[push] sendPushForNotification failed:", err);
  }
}
