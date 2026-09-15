import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { broadcastNotification } from "../lib/feedBroadcast.js";
import { sendPushForNotification } from "../lib/pushNotifications.js";

dotenv.config();

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

function getCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [key, val] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(val);
  }
  return undefined;
}

const LEGACY_TYPE_MAP: Record<string, string> = {
  treat: "like",
  pack_announcement: "community_announcement",
  best_answer: "comment",
  system: "comment",
};

const TREAT_TYPES = ["treat", "like"];
const COMMENT_TYPES = ["comment", "comment_reply"];
const QA_TYPES = ["best_answer", "qa_answer"];

function normalizeNotificationRow(row: any) {
  const storedType = row?.metadata?.notificationType as string | undefined;
  if (storedType) {
    row.type = storedType;
    return row;
  }
  if (row.type === "like") row.type = "treat";
  if (row.type === "community_announcement") row.type = "pack_announcement";
  if (row.type === "comment_reply") row.type = "comment";
  return row;
}

function getAccessToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  const sessionCookie = getCookie(req, "furlo_session");
  if (sessionCookie) return sessionCookie;
  const legacyCookie = getCookie(req, "sb_access_token");
  return legacyCookie || (req as any).cookies?.sb_access_token || null;
}

/**
 * Helper to safely create a notification for a user
 */
export async function createNotificationHelper(
  supabase: any,
  params: {
    userId: string;
    recipientPetId?: string;
    actorPetId?: string;
    type: "best_answer" | "treat" | "comment" | "follow" | "pack_announcement" | "system";
    title: string;
    body: string;
    entityType?: "post" | "comment" | "community" | "pet";
    entityId?: string;
    metadata?: Record<string, any>;
  }
) {
  try {
    // Check if user has settings enabling this notification type
    const { data: settings } = await supabase
      .from("user_notification_settings")
      .select("*")
      .eq("user_id", params.userId)
      .single();

    if (settings) {
      if (params.type === "treat" && !settings.treats_enabled) return null;
      if (params.type === "comment" && !settings.comments_enabled) return null;
      if (params.type === "follow" && !settings.followers_enabled) return null;
      if (params.type === "best_answer" && !settings.qa_best_answer_enabled) return null;
      if (params.type === "pack_announcement" && !settings.pack_announcements_enabled) return null;
    }

    const baseRow = {
      user_id: params.userId,
      recipient_pet_id: params.recipientPetId || null,
      actor_pet_id: params.actorPetId || null,
      title: params.title,
      body: params.body,
      entity_type: params.entityType || "post",
      entity_id: params.entityId || params.actorPetId || null,
      metadata: { ...(params.metadata || {}), notificationType: params.type },
      is_read: false,
      created_at: new Date().toISOString(),
    };

    let { data, error } = await supabase
      .from("notifications")
      .insert({ ...baseRow, type: params.type })
      .select()
      .single();

    if (error && (error.code === "23514" || String(error.message).includes("check constraint"))) {
      const legacyType = LEGACY_TYPE_MAP[params.type] || params.type;
      ({ data, error } = await supabase
        .from("notifications")
        .insert({ ...baseRow, type: legacyType })
        .select()
        .single());
    }

    if (error) {
      console.error("[notifications] Helper insert error:", error);
      return null;
    }

    if (data) {
      const row = normalizeNotificationRow({ ...data, type: params.type });

      if (params.actorPetId) {
        const { data: pet } = await supabase
          .from("pets")
          .select("id, name, username, profile_image_url, breed")
          .eq("id", params.actorPetId)
          .single();
        if (pet) row.pets = pet;
      }

      await broadcastNotification(params.userId, row).catch((err) => {
        console.error("[notifications] Realtime broadcast failed:", err);
      });

      void sendPushForNotification(params.userId, row).catch((err) => {
        console.error("[notifications] push send failed:", err);
      });
    }

    return data;
  } catch (err) {
    console.error("[notifications] Helper exception:", err);
    return null;
  }
}

async function resolveAuthenticatedUser(req: Request, res: Response, supabase: any) {
  let accessToken = getAccessToken(req);
  if (accessToken) {
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (!error && user) return user;
  }

  const refreshToken = getCookie(req, "furlo_refresh");
  if (refreshToken) {
    const { data, error: refreshError } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (!refreshError && data?.session) {
      res.cookie("furlo_session", data.session.access_token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.cookie("furlo_refresh", data.session.refresh_token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      return data.session.user;
    }
  }

  return null;
}

/**
 * GET /notifications
 * Fetch user's notifications list and unread count
 */
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const user = await resolveAuthenticatedUser(req, res, supabase);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const category = (req.query.category as string) || "all";
    const limit = parseInt((req.query.limit as string) || "20", 10);
    const page = parseInt((req.query.page as string) || "1", 10);
    const offset = (page - 1) * limit;

    const { data: ownedPets } = await supabase
      .from("pets")
      .select("id")
      .eq("owner_id", user.id);
    const petIds = (ownedPets || []).map((pet: { id: string }) => pet.id);

    let query = supabase
      .from("notifications")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (petIds.length > 0) {
      query = query.or(
        `user_id.eq.${user.id},recipient_pet_id.in.(${petIds.join(",")})`
      );
    } else {
      query = query.eq("user_id", user.id);
    }

    if (category === "treats") {
      query = query.in("type", TREAT_TYPES);
    } else if (category === "comments") {
      query = query.in("type", COMMENT_TYPES);
    } else if (category === "followers") {
      query = query.eq("type", "follow");
    } else if (category === "qa") {
      query = query.in("type", QA_TYPES);
    }

    const { data: rawNotifications, count, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error("[notifications] GET error:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
      return;
    }

    const notifications = (rawNotifications || []).map(normalizeNotificationRow);

    // Batch resolve actor pet details
    if (notifications.length > 0) {
      const petIds = Array.from(new Set(notifications.map((n: any) => n.actor_pet_id).filter(Boolean)));
      if (petIds.length > 0) {
        const { data: petRows } = await supabase
          .from("pets")
          .select("id, name, username, profile_image_url, breed")
          .in("id", petIds);

        if (petRows) {
          const petMap: Record<string, any> = {};
          petRows.forEach((p: any) => { petMap[p.id] = p; });
          notifications.forEach((n: any) => {
            if (n.actor_pet_id && petMap[n.actor_pet_id]) {
              n.pets = petMap[n.actor_pet_id];
            }
          });
        }
      }
    }

    // Calculate total unread count
    let unreadQuery = supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_read", false);

    if (petIds.length > 0) {
      unreadQuery = unreadQuery.or(
        `user_id.eq.${user.id},recipient_pet_id.in.(${petIds.join(",")})`
      );
    } else {
      unreadQuery = unreadQuery.eq("user_id", user.id);
    }

    const { count: unreadCount } = await unreadQuery;

    res.status(200).json({
      notifications: notifications || [],
      unreadCount: unreadCount || 0,
      totalCount: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("[notifications] GET exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /notifications/mark-read
 * Mark a single notification or all notifications as read
 */
router.post("/mark-read", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const user = await resolveAuthenticatedUser(req, res, supabase);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { notificationId, markAll } = req.body;

    if (markAll) {
      await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", user.id)
        .eq("is_read", false);

      res.status(200).json({ success: true, message: "Marked all notifications as read" });
      return;
    }

    if (notificationId) {
      await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", notificationId)
        .eq("user_id", user.id);

      res.status(200).json({ success: true, message: "Marked notification as read" });
      return;
    }

    res.status(400).json({ error: "notificationId or markAll is required" });
  } catch (err) {
    console.error("[notifications] mark-read error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /notifications/settings
 * Fetch user notification preferences
 */
router.get("/settings", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const user = await resolveAuthenticatedUser(req, res, supabase);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let { data: settings } = await supabase
      .from("user_notification_settings")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (!settings) {
      // Create default settings row
      const { data: newSettings } = await supabase
        .from("user_notification_settings")
        .insert({
          user_id: user.id,
          master_push_enabled: true,
          qa_answers_enabled: true,
          qa_best_answer_enabled: true,
          treats_enabled: true,
          comments_enabled: true,
          followers_enabled: true,
          pack_announcements_enabled: true,
          email_digest_enabled: false,
          quiet_hours_enabled: false,
          quiet_hours_start: "22:00",
          quiet_hours_end: "07:00",
          timezone: "UTC",
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      settings = newSettings;
    }

    res.status(200).json({ settings });
  } catch (err) {
    console.error("[notifications] GET settings error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /notifications/settings
 * Save user notification preferences
 */
router.post("/settings", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const user = await resolveAuthenticatedUser(req, res, supabase);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const payload = req.body;

    const { data: settings, error } = await supabase
      .from("user_notification_settings")
      .upsert({
        user_id: user.id,
        master_push_enabled: payload.master_push_enabled ?? true,
        qa_answers_enabled: payload.qa_answers_enabled ?? true,
        qa_best_answer_enabled: payload.qa_best_answer_enabled ?? true,
        treats_enabled: payload.treats_enabled ?? true,
        comments_enabled: payload.comments_enabled ?? true,
        followers_enabled: payload.followers_enabled ?? true,
        pack_announcements_enabled: payload.pack_announcements_enabled ?? true,
        email_digest_enabled: payload.email_digest_enabled ?? false,
        quiet_hours_enabled: payload.quiet_hours_enabled ?? false,
        quiet_hours_start: payload.quiet_hours_start ?? "22:00",
        quiet_hours_end: payload.quiet_hours_end ?? "07:00",
        timezone: payload.timezone ?? "UTC",
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error("[notifications] POST settings error:", error);
      res.status(500).json({ error: "Failed to save settings" });
      return;
    }

    res.status(200).json({ success: true, settings });
  } catch (err) {
    console.error("[notifications] POST settings exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /notifications/register-device
 * Upsert a push token for the authenticated user
 */
router.post("/register-device", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const user = await resolveAuthenticatedUser(req, res, supabase);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { token, platform, device_id: deviceId } = req.body;

    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token is required" });
      return;
    }

    if (!["ios", "android", "web"].includes(platform)) {
      res.status(400).json({ error: "platform must be ios, android, or web" });
      return;
    }

    const { data, error } = await supabase
      .from("user_push_tokens")
      .upsert(
        {
          user_id: user.id,
          token,
          platform,
          device_id: deviceId || null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "user_id,token" }
      )
      .select()
      .single();

    if (error) {
      console.error("[notifications] register-device error:", error);
      res.status(500).json({ error: "Failed to register device" });
      return;
    }

    res.status(200).json({ success: true, token: data });
  } catch (err) {
    console.error("[notifications] register-device exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /notifications/register-device
 * Remove a push token (logout / disable push on device)
 */
router.delete("/register-device", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const user = await resolveAuthenticatedUser(req, res, supabase);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = req.body?.token as string | undefined;
    if (!token) {
      res.status(400).json({ error: "token is required" });
      return;
    }

    const { error } = await supabase
      .from("user_push_tokens")
      .delete()
      .eq("user_id", user.id)
      .eq("token", token);

    if (error) {
      console.error("[notifications] unregister-device error:", error);
      res.status(500).json({ error: "Failed to unregister device" });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[notifications] unregister-device exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
