import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: tokens, error: tokenErr } = await sb.from("user_push_tokens").select("user_id, token, platform").limit(1);
console.log("tokens:", tokenErr?.message || tokens?.length, tokens?.[0]?.platform);

if (!tokens?.length) process.exit(1);

const userId = tokens[0].user_id;
const { data: settings } = await sb
  .from("user_notification_settings")
  .select("master_push_enabled, treats_enabled, quiet_hours_enabled")
  .eq("user_id", userId)
  .single();
console.log("settings:", settings);

const { getFirebaseMessaging } = await import("../lib/firebaseAdmin.js");
const messaging = getFirebaseMessaging();
console.log("firebase messaging:", messaging ? "OK" : "MISSING");

if (!messaging) process.exit(1);

const { sendPushForNotification } = await import("../lib/pushNotifications.js");
await sendPushForNotification(userId, {
  id: "diag-test",
  type: "treat",
  title: "Via sendPushForNotification",
  body: "Full pipeline test",
  metadata: { notificationType: "treat" },
});
console.log("sendPushForNotification done");

for (const channelId of ["default", "furlo_interactions"]) {
  const response = await messaging.sendEachForMulticast({
    tokens: [tokens[0].token],
    notification: {
      title: `Furlo test (${channelId})`,
      body: `Channel: ${channelId}`,
    },
    android: {
      priority: "high",
      notification: { channelId },
    },
  });
  console.log(
    channelId,
    "success:",
    response.successCount,
    "failure:",
    response.failureCount,
    response.responses[0]?.error?.message || "ok"
  );
}
