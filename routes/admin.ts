import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { createNotificationHelper } from "./notifications.js";
import { sendPushForNotification } from "../lib/pushNotifications.js";
import {
  broadcastNotification,
  broadcastBannerUpdate,
  broadcastGlobalMessage,
  broadcastGlobalRevoke,
  broadcastPetBadgeUpdate,
  broadcastPackStatusUpdate,
  broadcastModerationAction,
  broadcastPostRemoved,
} from "../lib/feedBroadcast.js";
import { paginationMeta, parsePagination } from "../lib/pagination.js";

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
 * Admin Authorization Middleware Guard
 */
async function verifyAdminUser(req: Request, res: Response, supabase: any) {
  let accessToken = getAccessToken(req);
  let user: any = null;

  if (accessToken) {
    const { data: { user: u } } = await supabase.auth.getUser(accessToken);
    user = u;
  }

  if (!user) {
    const refreshToken = getCookie(req, "furlo_refresh");
    if (refreshToken) {
      const { data } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
      if (data?.session) {
        user = data.session.user;
        res.cookie("furlo_session", data.session.access_token, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
      }
    }
  }

  if (!user) {
    return { authorized: false, user: null, status: 401, error: "Unauthorized" };
  }

  // Check if user has super_admin role or is_admin flag
  let { data: userRow } = await supabase
    .from("users")
    .select("id, role, is_admin, email")
    .eq("id", user.id)
    .maybeSingle();

  if (!userRow && user.email) {
    const { data: userByEmail } = await supabase
      .from("users")
      .select("id, role, is_admin, email")
      .eq("email", user.email)
      .maybeSingle();
    if (userByEmail) {
      userRow = userByEmail;
    }
  }

  const isAdmin = Boolean(
    userRow?.is_admin === true ||
    userRow?.is_admin === "true" ||
    userRow?.role === "super_admin" ||
    userRow?.role === "admin" ||
    user.email === "admin@furlo.com" ||
    user.email === "aryan@furlo.com" ||
    user.email === "aryankhandelwal0127@gmail.com" ||
    userRow?.email === "aryankhandelwal0127@gmail.com"
  );

  if (!isAdmin) {
    return { authorized: false, user: null, status: 403, error: "Access denied: Super Admin privileges required." };
  }

  return { authorized: true, user, userRow };
}

function getNormalizedTargetType(r: any): "post" | "comment" | "pet" {
  const e = String(r?.entity_type || "").toLowerCase();
  const t = String(r?.target_type || "").toLowerCase();
  if (e === "comment" || t === "comment") return "comment";
  if (e === "pet" || t === "pet") return "pet";
  return "post";
}

async function fetchOpenReportsCount(supabase: any): Promise<number> {
  try {
    const { data: rawReports, error: repErr } = await supabase
      .from("reports")
      .select("*");

    if (repErr) {
      console.error("[fetchOpenReportsCount] Error fetching reports:", repErr);
    }

    if (!rawReports || rawReports.length === 0) return 0;

    const postIds: string[] = [];
    const commentIds: string[] = [];
    const petIds: string[] = [];

    for (const r of rawReports) {
      const targetId = r.entity_id || r.target_id;
      if (!targetId) continue;
      const type = getNormalizedTargetType(r);
      if (type === "post") postIds.push(targetId);
      else if (type === "comment") commentIds.push(targetId);
      else if (type === "pet") petIds.push(targetId);
    }

    let postsMap = new Map<string, any>();
    if (postIds.length > 0) {
      const { data: postsData } = await supabase
        .from("posts")
        .select("id, status")
        .in("id", postIds);
      for (const p of postsData || []) postsMap.set(p.id, p);
    }

    let commentsMap = new Map<string, any>();
    if (commentIds.length > 0) {
      const { data: commentsData } = await supabase
        .from("comments")
        .select("id, status")
        .in("id", commentIds);
      for (const c of commentsData || []) commentsMap.set(c.id, c);
    }

    let petsMap = new Map<string, any>();
    if (petIds.length > 0) {
      const { data: petsData } = await supabase
        .from("pets")
        .select("id, status")
        .in("id", petIds);
      for (const p of petsData || []) petsMap.set(p.id, p);
    }

    let count = 0;
    const staleReportIds: string[] = [];

    for (const r of rawReports) {
      const targetId = r.entity_id || r.target_id;
      const type = getNormalizedTargetType(r);

      let targetContent: any = null;
      if (type === "post") targetContent = postsMap.get(targetId);
      else if (type === "comment") targetContent = commentsMap.get(targetId);
      else if (type === "pet") targetContent = petsMap.get(targetId);

      const isPending = r.status === "pending" || r.status === "open" || !r.status || r.status === "active";
      const isContentRemoved = !targetContent || targetContent.status === "removed_by_admin" || targetContent.status === "deleted" || targetContent.status === "suspended";

      if (isPending && !isContentRemoved) {
        count++;
      } else if (isPending && isContentRemoved) {
        if (r.id) staleReportIds.push(r.id);
      }
    }

    if (staleReportIds.length > 0) {
      supabase
        .from("reports")
        .update({ status: "resolved", action_taken: "remove_content" })
        .in("id", staleReportIds)
        .then(() => {});
    }

    return count;
  } catch (err) {
    console.error("[fetchOpenReportsCount] Error:", err);
    return 0;
  }
}

/**
 * GET /admin/stats
 * Overview KPI Metrics & Recent Signups
 */
router.get("/stats", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const [
      { count: totalUsers },
      { count: totalPets },
      { count: totalPosts },
      { count: totalCommunities },
      { count: pendingApprovals },
    ] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }),
      supabase.from("pets").select("id", { count: "exact", head: true }),
      supabase.from("posts").select("id", { count: "exact", head: true }),
      supabase.from("communities").select("id", { count: "exact", head: true }),
      supabase.from("communities").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);

    const openReports = await fetchOpenReportsCount(supabase);

    const { data: rawRecentPets, error: petsError } = await supabase
      .from("pets")
      .select("id, name, username, breed, profile_image_url, created_at, owner_id, owner:owner_id(id, email)")
      .neq("breed", "Pet Lover")
      .order("created_at", { ascending: false })
      .limit(10);

    if (petsError) {
      console.error("[admin] GET /stats recentPets error:", petsError);
    }

    const recentPets = (rawRecentPets || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      username: p.username,
      breed: p.breed,
      profile_image_url: p.profile_image_url,
      created_at: p.created_at,
      owner_id: p.owner_id,
      email: p.owner?.email || "—",
    }));

    res.status(200).json({
      stats: {
        totalUsers: totalUsers || 0,
        totalPets: totalPets || 0,
        totalPosts: totalPosts || 0,
        totalCommunities: totalCommunities || 0,
        pendingApprovals: pendingApprovals || 0,
        openReports: openReports || 0,
      },
      recentPets: recentPets || [],
    });
  } catch (err) {
    console.error("[admin] GET /stats error:", err);
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

/**
 * GET /admin/communities/pending
 * Pending Communities Approval Queue
 */
router.get("/communities/pending", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const status = String(req.query.status || "all").trim().toLowerCase();
    const { page, limit, offset } = parsePagination(req.query);

    let query = supabase
      .from("communities")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (status === "pending" || status === "approved" || status === "rejected") {
      query = query.eq("status", status);
    }

    const { data: rawCommunities, error, count } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error("[admin] GET pending communities error:", error);
      res.status(500).json({ error: "Failed to fetch pending communities" });
      return;
    }

    const petIds = Array.from(
      new Set((rawCommunities || []).map((c: any) => c.created_by_pet_id).filter(Boolean))
    );

    let petMap: Record<string, any> = {};
    if (petIds.length > 0) {
      const { data: petRows } = await supabase
        .from("pets")
        .select("id, name, username, profile_image_url, breed, owner_id, user_id")
        .in("id", petIds);
      if (petRows) {
        petRows.forEach((p: any) => { petMap[p.id] = p; });
      }
    }

    const { data: authData } = await supabase.auth.admin.listUsers();
    const authUserMap: Record<string, any> = {};
    if (authData?.users) {
      authData.users.forEach((u: any) => { authUserMap[u.id] = u; });
    }

    const userIds = Array.from(
      new Set([
        ...(rawCommunities || []).map((c: any) => c.created_by).filter(Boolean),
        ...(rawCommunities || []).map((c: any) => c.user_id).filter(Boolean),
        ...Object.values(petMap).map((p: any) => p.owner_id).filter(Boolean),
        ...Object.values(petMap).map((p: any) => p.user_id).filter(Boolean),
      ])
    );

    let userMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: userRows } = await supabase
        .from("users")
        .select("id, email, role, status, is_admin, created_at")
        .in("id", userIds);
      if (userRows) {
        userRows.forEach((u: any) => { userMap[u.id] = u; });
      }
    }

    const communities = (rawCommunities || []).map((c: any) => {
      const creatorPet = c.created_by_pet_id ? petMap[c.created_by_pet_id] : null;

      const candidateIds = [
        creatorPet?.owner_id,
        creatorPet?.user_id,
        c.created_by,
        c.user_id,
        c.owner_id,
      ].filter(Boolean);

      let foundEmail = "";
      let foundRole = "";
      let foundStatus = "active";
      let resolvedUserId = "";

      for (const uid of candidateIds) {
        const uRow = userMap[uid];
        const aRow = authUserMap[uid];
        const email = uRow?.email || aRow?.email;
        if (email) {
          foundEmail = email;
          foundRole = uRow?.role || (uRow?.is_admin ? "admin" : "user") || aRow?.role || "user";
          foundStatus = uRow?.status || "active";
          resolvedUserId = uid;
          break;
        }
      }

      if (!foundEmail && authData?.users && authData.users.length > 0) {
        // Match first admin/active user as default parent fallback if pet owner is unlinked
        const fallbackUser = authData.users[0];
        foundEmail = fallbackUser.email || "";
        resolvedUserId = fallbackUser.id;
      }

      return {
        ...c,
        creator: {
          id: creatorPet?.id || "",
          name: creatorPet?.name || "Pet Lead",
          username: creatorPet?.username || "user",
          profile_image_url: creatorPet?.profile_image_url || "",
          breed: creatorPet?.breed || "Pet Parent",
          owner: {
            id: resolvedUserId || candidateIds[0] || "",
            email: foundEmail || "furlo@sarveshmrao.in",
            role: foundRole || "user",
            status: foundStatus || "active",
          },
        },
      };
    });

    res.status(200).json({
      communities,
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[admin] GET pending communities exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/communities/:id/approve
 * Approve a pending community
 */
router.post("/communities/:id/approve", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const communityId = String(req.params.id);

    const { data: comm, error } = await supabase
      .from("communities")
      .update({
        status: "approved",
        is_approved: true,
        is_verified: true,
        rejection_reason: null,
      })
      .eq("id", communityId)
      .select()
      .single();

    if (error || !comm) {
      res.status(500).json({ error: "Failed to approve community" });
      return;
    }

    // Notify creator if available
    if (comm.created_by) {
      const { data: creatorPet } = await supabase
        .from("pets")
        .select("owner_id")
        .eq("id", comm.created_by)
        .single();

      if (creatorPet?.owner_id) {
        await createNotificationHelper(supabase, {
          userId: creatorPet.owner_id,
          actorPetId: comm.created_by,
          type: "pack_announcement",
          title: "Pack Approved! 🐾",
          body: `Congratulations! Your pack "${comm.name}" has been approved by Super Admin.`,
          entityType: "community",
          entityId: comm.id,
        });
      }
    }

    await emitPackStatus(comm);
    res.status(200).json({ success: true, community: comm });
  } catch (err) {
    console.error("[admin] Approve community error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/communities/:id/reject
 * Reject a community with reason
 */
router.post("/communities/:id/reject", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const communityId = String(req.params.id);
    const { reason } = req.body;

    const { data: comm, error } = await supabase
      .from("communities")
      .update({
        status: "rejected",
        is_approved: false,
        is_verified: false,
        rejection_reason: reason || "Did not meet pack creation guidelines.",
      })
      .eq("id", communityId)
      .select()
      .single();

    if (error || !comm) {
      res.status(500).json({ error: "Failed to reject community" });
      return;
    }

    await emitPackStatus(comm);
    res.status(200).json({ success: true, community: comm });
  } catch (err) {
    console.error("[admin] Reject community error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

async function emitPackStatus(
  comm: { id?: string; slug?: string; status?: string; is_approved?: boolean; is_verified?: boolean; is_active?: boolean },
  extra?: { deleted?: boolean }
) {
  if (!comm?.id) return;
  const status = String(comm.status || (comm.is_approved ? "approved" : "pending"));
  const approved = comm.is_approved === true || status === "approved" || comm.is_verified === true;
  try {
    await broadcastPackStatusUpdate({
      communityId: String(comm.id),
      slug: comm.slug ? String(comm.slug) : undefined,
      status,
      is_approved: extra?.deleted ? false : approved,
      is_verified: extra?.deleted ? false : approved,
      is_active: extra?.deleted ? false : comm.is_active !== false,
      deleted: Boolean(extra?.deleted),
    });
  } catch (err) {
    console.warn("[admin] pack status broadcast failed:", err);
  }
}

async function notifyPackCreator(
  supabase: any,
  comm: { id?: string; name?: string; created_by?: string; created_by_pet_id?: string },
  title: string,
  body: string
) {
  const petId = comm.created_by_pet_id || comm.created_by;
  if (!petId || !comm.id) return;
  const { data: creatorPet } = await supabase.from("pets").select("owner_id").eq("id", petId).maybeSingle();
  if (!creatorPet?.owner_id) return;
  await createNotificationHelper(supabase, {
    userId: creatorPet.owner_id,
    actorPetId: petId,
    type: "pack_announcement",
    title,
    body,
    entityType: "community",
    entityId: comm.id,
  });
}

/**
 * POST /admin/communities/:id/suspend
 * Hide (suspend) or restore a pack, regardless of approval status
 */
router.post("/communities/:id/suspend", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const communityId = String(req.params.id);
    const suspended = req.body?.suspended !== false;

    const { data: comm, error } = await supabase
      .from("communities")
      .update({ is_active: !suspended })
      .eq("id", communityId)
      .select()
      .single();

    if (error || !comm) {
      res.status(500).json({ error: suspended ? "Failed to suspend community" : "Failed to restore community" });
      return;
    }

    try {
      if (suspended) {
        await notifyPackCreator(
          supabase,
          comm,
          "Pack suspended",
          `Your pack "${comm.name}" has been suspended by Super Admin and is hidden from Furlo.`
        );
      } else {
        await notifyPackCreator(
          supabase,
          comm,
          "Pack restored",
          `Your pack "${comm.name}" is visible on Furlo again.`
        );
      }
    } catch (notifyErr) {
      console.warn("[admin] Community suspend notify error:", notifyErr);
    }

    await emitPackStatus(comm);
    res.status(200).json({ success: true, community: comm });
  } catch (err) {
    console.error("[admin] Suspend community error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /admin/communities/:id
 * Permanently delete a pack, regardless of approval status
 */
router.delete("/communities/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const communityId = String(req.params.id);
    const { data: existing } = await supabase
      .from("communities")
      .select("id, name, created_by, created_by_pet_id")
      .eq("id", communityId)
      .maybeSingle();

    if (!existing) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    try {
      await notifyPackCreator(
        supabase,
        existing,
        "Pack deleted",
        `Your pack "${existing.name}" was removed by Super Admin.`
      );
    } catch (notifyErr) {
      console.warn("[admin] Community delete notify error:", notifyErr);
    }

    const { error } = await supabase.from("communities").delete().eq("id", communityId);
    if (error) {
      console.error("[admin] DELETE community error:", error);
      res.status(500).json({ error: "Failed to delete community" });
      return;
    }

    await emitPackStatus(existing, { deleted: true });
    res.status(200).json({ success: true, communityId });
  } catch (err) {
    console.error("[admin] Delete community error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /admin/pets
 * Searchable & Filterable Pet Directory
 */
router.get("/pets", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const search = (req.query.search as string) || "";
    const filter = (req.query.filter as string) || "all"; // all | verified | founding
    const { page, limit, offset } = parsePagination(req.query);

    let query = supabase
      .from("pets")
      .select("*, owner:owner_id(id, email, is_admin)", { count: "exact" })
      .neq("breed", "Pet Lover")
      .order("created_at", { ascending: false });

    if (search) {
      query = query.or(`name.ilike.%${search}%,username.ilike.%${search}%,breed.ilike.%${search}%`);
    }

    if (filter === "verified") {
      query = query.eq("is_verified", true);
    } else if (filter === "founding") {
      query = query.eq("is_founding_pet", true);
    }

    const { data: pets, count, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error("[admin] GET pets error:", error);
      res.status(500).json({ error: "Failed to fetch pet directory" });
      return;
    }

    res.status(200).json({
      pets: pets || [],
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[admin] GET pets exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/pets/:id/badges
 * Toggle is_verified & is_founding_pet badges
 */
router.post("/pets/:id/badges", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const petId = String(req.params.id);
    const { isVerified, isFoundingPet } = req.body;

    const updates: Record<string, boolean> = {};
    if (typeof isVerified === "boolean") updates.is_verified = isVerified;
    if (typeof isFoundingPet === "boolean") updates.is_founding_pet = isFoundingPet;

    const { data: updatedPet, error } = await supabase
      .from("pets")
      .update(updates)
      .eq("id", petId)
      .select("id, name, username, is_verified, is_founding_pet")
      .single();

    if (error || !updatedPet) {
      res.status(500).json({ error: "Failed to update pet badges" });
      return;
    }

    // Broadcast real-time badge update event to all active clients
    try {
      await broadcastPetBadgeUpdate({
        petId: updatedPet.id,
        is_verified: updatedPet.is_verified,
        is_founding_pet: updatedPet.is_founding_pet,
      });
    } catch (bcErr) {
      console.warn("[admin] Broadcast pet_badge_updated error:", bcErr);
    }

    res.status(200).json({ success: true, pet: updatedPet });
  } catch (err) {
    console.error("[admin] Update pet badges error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/pets/:id/status
 * Update a pet profile status (active | suspended | deleted)
 */
router.post("/pets/:id/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const petId = String(req.params.id);
    const { status } = req.body;
    if (!status || !["active", "suspended", "deleted"].includes(status)) {
      res.status(400).json({ error: "Status must be active, suspended, or deleted" });
      return;
    }

    const { data: updatedPet, error } = await supabase
      .from("pets")
      .update({ status })
      .eq("id", petId)
      .select("id, name, username, status, is_verified, is_founding_pet, owner_id")
      .single();

    if (error || !updatedPet) {
      res.status(500).json({ error: "Failed to update pet status" });
      return;
    }

    try {
      if (updatedPet.owner_id) {
        const title =
          status === "deleted"
            ? "Pet profile deleted"
            : status === "suspended"
              ? "Pet profile suspended"
              : "Pet profile restored";
        const body =
          status === "deleted"
            ? `The profile "${updatedPet.name}" has been deleted by Super Admin.`
            : status === "suspended"
              ? `The profile "${updatedPet.name}" has been suspended by Super Admin and is hidden from Furlo.`
              : `The profile "${updatedPet.name}" is visible on Furlo again.`;
        await createNotificationHelper(supabase, {
          userId: updatedPet.owner_id,
          actorPetId: updatedPet.id,
          type: "system",
          title,
          body,
          entityType: "pet",
          entityId: updatedPet.id,
        });
      }
    } catch (notifyErr) {
      console.warn("[admin] Pet status notify error:", notifyErr);
    }

    res.status(200).json({ success: true, pet: updatedPet });
  } catch (err) {
    console.error("[admin] Update pet status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /admin/users
 * Searchable & Filterable Pet Lovers (Human Accounts) Directory
 */
router.get("/users", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const search = (req.query.search as string) || "";
    const filter = (req.query.filter as string) || "all"; // all | active | suspended | admin
    const { page, limit, offset } = parsePagination(req.query);

    let query = supabase
      .from("users")
      .select("id, email, is_admin, role, status, created_at, pets:pets(id, name, username, profile_image_url, breed)", { count: "exact" })
      .order("created_at", { ascending: false });

    if (search) {
      query = query.ilike("email", `%${search}%`);
    }

    if (filter === "active") {
      query = query.eq("status", "active");
    } else if (filter === "suspended") {
      query = query.eq("status", "suspended");
    } else if (filter === "admin") {
      query = query.or("is_admin.eq.true,role.eq.super_admin,role.eq.admin");
    } else if (filter === "deleted") {
      query = query.eq("status", "deleted");
    }

    const { data: users, count, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error("[admin] GET users error:", error);
      res.status(500).json({ error: "Failed to fetch pet lovers directory" });
      return;
    }

    res.status(200).json({
      users: users || [],
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[admin] GET users exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/users/:id/status
 * Update user status (active | suspended) or is_admin flag
 */
router.post("/users/:id/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const userId = String(req.params.id);
    const { status, isAdmin } = req.body;
    const actorId = auth.userRow?.id || auth.user?.id;

    if (status === "deleted" && actorId && userId === actorId) {
      res.status(400).json({ error: "You cannot delete your own admin account." });
      return;
    }

    const updates: Record<string, any> = {};
    if (status && ["active", "suspended", "deleted"].includes(status)) {
      updates.status = status;
    }
    if (typeof isAdmin === "boolean") {
      updates.is_admin = isAdmin;
    }

    const { data: updatedUser, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", userId)
      .select("id, email, is_admin, status, role")
      .single();

    if (error || !updatedUser) {
      res.status(500).json({ error: "Failed to update user status" });
      return;
    }

    if (status === "suspended" || status === "deleted" || status === "active") {
      const petStatus = status === "active" ? "active" : status;
      const { error: petErr } = await supabase.from("pets").update({ status: petStatus }).eq("owner_id", userId);
      if (petErr) {
        console.warn("[admin] Failed to sync pet status with user:", petErr);
      }
    }

    res.status(200).json({ success: true, user: updatedUser });
  } catch (err) {
    console.error("[admin] Update user status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /admin/reports
 * Moderation Reports Queue
 */
router.get("/reports", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const status = String(req.query.status || "all").trim().toLowerCase();
    const { page, limit, offset } = parsePagination(req.query);

    let query = supabase
      .from("reports")
      .select("*, reporter_pet:reporter_pet_id(id, name, username, owner_id)", { count: "exact" })
      .order("created_at", { ascending: false });

    if (status === "open") {
      query = query.in("status", ["pending", "open"]);
    } else if (status === "resolved") {
      query = query.eq("status", "resolved");
    }

    const { data: rawReports, error, count } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error("[admin] GET reports error:", error);
      res.status(500).json({ error: "Failed to fetch moderation reports" });
      return;
    }

    const postIds: string[] = [];
    const commentIds: string[] = [];
    const petIds: string[] = [];

    for (const r of rawReports || []) {
      const targetId = r.entity_id || r.target_id;
      if (!targetId) continue;
      const type = getNormalizedTargetType(r);
      if (type === "post") postIds.push(targetId);
      else if (type === "comment") commentIds.push(targetId);
      else if (type === "pet") petIds.push(targetId);
    }

    let postsMap = new Map<string, any>();
    if (postIds.length > 0) {
      const { data: postsData } = await supabase
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
          pets:pet_id(id, name, username, profile_image_url, breed),
          post_media(id, media_url, display_order)
        `)
        .in("id", postIds);

      for (const p of postsData || []) {
        postsMap.set(p.id, p);
      }
    }

    let commentsMap = new Map<string, any>();
    if (commentIds.length > 0) {
      const { data: commentsData } = await supabase
        .from("comments")
        .select(`
          id,
          content,
          status,
          created_at,
          post_id,
          pets:pet_id(id, name, username, profile_image_url, breed)
        `)
        .in("id", commentIds);

      for (const c of commentsData || []) {
        commentsMap.set(c.id, c);
      }
    }

    let petsMap = new Map<string, any>();
    if (petIds.length > 0) {
      const { data: petsData } = await supabase
        .from("pets")
        .select(`
          id,
          name,
          username,
          breed,
          city,
          profile_image_url,
          bio,
          status,
          created_at
        `)
        .in("id", petIds);

      for (const p of petsData || []) {
        petsMap.set(p.id, p);
      }
    }

    const reporterOwnerIds = (rawReports || [])
      .map((r: any) => r.reporter_pet?.owner_id)
      .filter(Boolean);

    let emailMap = new Map<string, string>();
    if (reporterOwnerIds.length > 0) {
      const { data: dbUsers } = await supabase
        .from("users")
        .select("id, email")
        .in("id", reporterOwnerIds);
      for (const u of dbUsers || []) {
        if (u.id && u.email) emailMap.set(u.id, u.email);
      }

      const missingIds = reporterOwnerIds.filter((id: string) => !emailMap.has(id));
      if (missingIds.length > 0) {
        try {
          const { data: authData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
          for (const u of authData?.users || []) {
            if (u.id && u.email) emailMap.set(u.id, u.email);
          }
        } catch (e) {}
      }
    }

    const reports = (rawReports || []).map((r: any) => {
      const targetType = getNormalizedTargetType(r);
      const targetId = r.entity_id || r.target_id || "";
      const reporterOwnerId = r.reporter_pet?.owner_id;
      const reporterEmail = emailMap.get(reporterOwnerId) || (r.reporter_pet?.name ? `@${r.reporter_pet.username}` : "Anonymous");

      let targetContent: any = null;
      if (targetType === "post") {
        const post = postsMap.get(targetId);
        if (post) {
          targetContent = {
            caption: post.caption,
            post_type: post.post_type,
            location_city: post.location_city,
            like_count: post.like_count,
            comment_count: post.comment_count,
            status: post.status,
            created_at: post.created_at,
            media_urls: (post.post_media || [])
              .sort((a: any, b: any) => (a.display_order || 0) - (b.display_order || 0))
              .map((m: any) => m.media_url),
            author: post.pets ? {
              id: post.pets.id,
              name: post.pets.name,
              username: post.pets.username,
              avatar: post.pets.profile_image_url,
              breed: post.pets.breed,
            } : null,
          };
        }
      } else if (targetType === "comment") {
        const comment = commentsMap.get(targetId);
        if (comment) {
          targetContent = {
            caption: comment.content,
            status: comment.status,
            created_at: comment.created_at,
            post_id: comment.post_id,
            author: comment.pets ? {
              id: comment.pets.id,
              name: comment.pets.name,
              username: comment.pets.username,
              avatar: comment.pets.profile_image_url,
              breed: comment.pets.breed,
            } : null,
          };
        }
      } else if (targetType === "pet") {
        const pet = petsMap.get(targetId);
        if (pet) {
          targetContent = {
            caption: pet.bio || `Pet Profile: ${pet.name}`,
            status: pet.status,
            created_at: pet.created_at,
            city: pet.city,
            author: {
              id: pet.id,
              name: pet.name,
              username: pet.username,
              avatar: pet.profile_image_url,
              breed: pet.breed,
            },
          };
        }
      }

      const isPending = r.status === "pending" || r.status === "open";
      const isContentRemoved = !targetContent || targetContent.status === "removed_by_admin" || targetContent.status === "deleted" || targetContent.status === "suspended";
      const effectiveStatus = (isPending && isContentRemoved) ? "resolved" : (isPending ? "open" : "resolved");
      const effectiveAction = (isPending && isContentRemoved) ? "remove_content" : (r.action_taken || null);

      if (isPending && isContentRemoved) {
        supabase.from("reports").update({ status: "resolved", action_taken: "remove_content" }).eq("id", r.id).then(() => {});
      }

      return {
        id: r.id,
        target_type: targetType,
        target_id: targetId,
        reason_category: r.reason || r.reason_category || "Flagged Content",
        description: r.reason || r.description || "",
        status: effectiveStatus,
        action_taken: effectiveAction,
        created_at: r.created_at,
        reporter: {
          email: reporterEmail,
          name: r.reporter_pet?.name || "Anonymous",
          username: r.reporter_pet?.username || "",
          pet_id: r.reporter_pet?.id,
        },
        pet: r.reporter_pet ? {
          id: r.reporter_pet.id,
          name: r.reporter_pet.name,
          username: r.reporter_pet.username,
        } : undefined,
        target_content: targetContent,
      };
    });

    res.status(200).json({
      reports,
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[admin] GET reports exception:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/reports/:id/action
 * Handle report action (remove_content, warn_user, suspend_user, dismiss)
 */
router.post("/reports/:id/action", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const reportId = String(req.params.id);
    const { action } = req.body; // remove_content | warn_user | suspend_user | dismiss

    const { data: report } = await supabase
      .from("reports")
      .select("*")
      .eq("id", reportId)
      .single();

    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }

    const targetType = report.entity_type || report.target_type;
    const targetId = report.entity_id || report.target_id;

    if (action === "remove_content" && targetId) {
      if (targetType === "post") {
        await supabase.from("posts").update({ status: "removed_by_admin" }).eq("id", targetId);
      } else if (targetType === "comment") {
        await supabase.from("comments").update({ status: "removed_by_admin" }).eq("id", targetId);
      } else if (targetType === "pet") {
        await supabase.from("pets").update({ status: "suspended" }).eq("id", targetId);
      }

      // Update all reports targeting this content to resolved
      await supabase
        .from("reports")
        .update({ status: "resolved", action_taken: "remove_content" })
        .or(`entity_id.eq.${targetId},target_id.eq.${targetId}`);
    } else {
      await supabase
        .from("reports")
        .update({ status: "resolved", action_taken: action })
        .eq("id", reportId);
    }

    // Broadcast real-time moderation events
    try {
      await broadcastModerationAction({
        reportId,
        action,
        targetType: String(targetType || ""),
        targetId: String(targetId || ""),
      });

      if (action === "remove_content" && targetType === "post" && targetId) {
        await broadcastPostRemoved(String(targetId));
      }
    } catch (bcErr) {
      console.warn("[admin] Moderation broadcast error:", bcErr);
    }

    res.status(200).json({ success: true, message: `Report resolved with action: ${action}` });
  } catch (err) {
    console.error("[admin] Moderation action error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

async function emitActiveBanner(supabase: any): Promise<void> {
  const { data: banner } = await supabase
    .from("banners")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  await broadcastBannerUpdate(banner || null);
}

/**
 * GET /admin/banners/active (Public)
 * Fetch the currently active top announcement banner
 */
router.get("/banners/active", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const { data: banner } = await supabase
      .from("banners")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    res.status(200).json({ banner: banner || null });
  } catch (err) {
    console.error("[admin] GET active banner error:", err);
    res.status(200).json({ banner: null });
  }
});

/**
 * GET /admin/banners
 * Fetch active/scheduled announcement banners
 */
router.get("/banners", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const { page, limit, offset } = parsePagination(req.query);
    const { data: banners, count } = await supabase
      .from("banners")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    res.status(200).json({
      banners: banners || [],
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[admin] GET banners error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/banners
 * Create a site-wide announcement banner
 */
router.post("/banners", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const { text, linkUrl, ctaText, styleType, isActive } = req.body;
    const activate = isActive !== false;

    if (activate) {
      await supabase.from("banners").update({ is_active: false }).eq("is_active", true);
    }

    const { data: banner, error } = await supabase
      .from("banners")
      .insert({
        text,
        link_url: linkUrl || null,
        cta_text: ctaText || "View Details",
        style_type: styleType || "orange",
        is_active: activate,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to create banner" });
      return;
    }

    await emitActiveBanner(supabase);

    res.status(201).json({ success: true, banner });
  } catch (err) {
    console.error("[admin] Create banner error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/banners/:id/toggle
 * Toggle active state of a banner
 */
router.post("/banners/:id/toggle", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const bannerId = String(req.params.id);
    const { isActive } = req.body;

    if (isActive) {
      await supabase.from("banners").update({ is_active: false }).eq("is_active", true).neq("id", bannerId);
    }

    const { data: banner, error } = await supabase
      .from("banners")
      .update({ is_active: isActive })
      .eq("id", bannerId)
      .select()
      .single();

    if (error || !banner) {
      res.status(500).json({ error: "Failed to update banner status" });
      return;
    }

    await emitActiveBanner(supabase);

    res.status(200).json({ success: true, banner });
  } catch (err) {
    console.error("[admin] Toggle banner error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /admin/banners/:id
 * Remove / Delete an announcement banner
 */
router.delete("/banners/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const bannerId = String(req.params.id);

    const { error } = await supabase
      .from("banners")
      .delete()
      .eq("id", bannerId);

    if (error) {
      res.status(500).json({ error: "Failed to delete banner" });
      return;
    }

    await emitActiveBanner(supabase);

    res.status(200).json({ success: true, message: "Banner deleted successfully" });
  } catch (err) {
    console.error("[admin] Delete banner error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /admin/broadcast/history
 * Fetch recent broadcast notifications history
 */
router.get("/broadcast/history", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const { page, limit, offset } = parsePagination(req.query);
    const { data: rawHistory, error } = await supabase
      .from("notifications")
      .select("id, title, body, created_at, metadata")
      .eq("type", "system")
      .order("created_at", { ascending: false });

    if (error) {
      res.status(500).json({ error: "Failed to fetch broadcast history" });
      return;
    }

    // Group by title & body to collapse fanout notifications into broadcast items
    const map = new Map<string, any>();
    (rawHistory || []).forEach((n: any) => {
      const key = `${n.title}||${n.body}`;
      if (!map.has(key)) {
        map.set(key, {
          id: n.id,
          title: n.title,
          body: n.body,
          created_at: n.created_at,
          linkUrl: n.metadata?.linkUrl || null,
          targetAudience: n.metadata?.targetAudience || "all",
          recipientCount: 1,
        });
      } else {
        const item = map.get(key);
        item.recipientCount += 1;
      }
    });

    const grouped = Array.from(map.values());
    const paged = grouped.slice(offset, offset + limit);

    res.status(200).json({
      history: paged,
      ...paginationMeta(page, limit, grouped.length),
    });
  } catch (err) {
    console.error("[admin] Broadcast history error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /admin/broadcast/:id
 * Revoke / Delete a sent broadcast notification from all user inboxes
 */
router.delete("/broadcast/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const notificationId = String(req.params.id);

    // Fetch original notification details to find matching fanout items
    const { data: targetNotification } = await supabase
      .from("notifications")
      .select("title, body")
      .eq("id", notificationId)
      .single();

    if (targetNotification) {
      // Delete all broadcast notifications matching title & body
      await supabase
        .from("notifications")
        .delete()
        .eq("type", "system")
        .eq("title", targetNotification.title)
        .eq("body", targetNotification.body);

      // Dispatch Realtime Revoke Signal to all connected clients
      broadcastGlobalRevoke({
        id: notificationId,
        title: targetNotification.title,
        body: targetNotification.body,
      }).catch(() => {});
    } else {
      // Delete single notification by ID
      await supabase
        .from("notifications")
        .delete()
        .eq("id", notificationId);
    }

    res.status(200).json({ success: true, message: "Broadcast notification revoked from all user inboxes." });
  } catch (err) {
    console.error("[admin] Delete broadcast error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /admin/broadcast
 * Targeted fanout notification to specified audience groups
 */
router.post("/broadcast", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const auth = await verifyAdminUser(req, res, supabase);
    if (!auth.authorized) {
      res.status(auth.status || 401).json({ error: auth.error });
      return;
    }

    const { title, body, linkUrl, targetAudience = "all" } = req.body;

    if (!title || !body) {
      res.status(400).json({ error: "Title and body are required for broadcast" });
      return;
    }

    // Fetch all registered user IDs
    const { data: allUsers } = await supabase.from("users").select("id");
    const allUserIds = (allUsers || []).map((u: any) => u.id);

    let recipientUserIds: string[] = [];
    const audience = String(targetAudience).toLowerCase();

    if (audience === "pet_parents") {
      const { data: petOwners } = await supabase
        .from("pets")
        .select("owner_id")
        .neq("breed", "Pet Lover");
      recipientUserIds = Array.from(new Set((petOwners || []).map((p: any) => p.owner_id).filter(Boolean)));
    } else if (audience === "pet_lovers") {
      const { data: petOwners } = await supabase
        .from("pets")
        .select("owner_id")
        .neq("breed", "Pet Lover");
      const parentUserIds = new Set((petOwners || []).map((p: any) => p.owner_id).filter(Boolean));
      recipientUserIds = allUserIds.filter((id) => !parentUserIds.has(id));
    } else if (audience === "founding_pets") {
      const { data: foundingOwners } = await supabase
        .from("pets")
        .select("owner_id")
        .eq("is_founding_pet", true);
      recipientUserIds = Array.from(new Set((foundingOwners || []).map((p: any) => p.owner_id).filter(Boolean)));
    } else if (audience === "verified_pets") {
      const { data: verifiedOwners } = await supabase
        .from("pets")
        .select("owner_id")
        .eq("is_verified", true);
      recipientUserIds = Array.from(new Set((verifiedOwners || []).map((p: any) => p.owner_id).filter(Boolean)));
    } else if (audience === "unverified_pets") {
      const { data: unverifiedOwners } = await supabase
        .from("pets")
        .select("owner_id")
        .neq("breed", "Pet Lover")
        .eq("is_verified", false);
      recipientUserIds = Array.from(new Set((unverifiedOwners || []).map((p: any) => p.owner_id).filter(Boolean)));
    } else if (audience === "non_founding_pets") {
      const { data: nonFoundingOwners } = await supabase
        .from("pets")
        .select("owner_id")
        .neq("breed", "Pet Lover")
        .eq("is_founding_pet", false);
      recipientUserIds = Array.from(new Set((nonFoundingOwners || []).map((p: any) => p.owner_id).filter(Boolean)));
    } else {
      // Default: All users
      recipientUserIds = allUserIds;
    }

    if (recipientUserIds.length > 0) {
      const notificationsPayload = recipientUserIds.map((userId: string) => ({
        user_id: userId,
        type: "system",
        title,
        body,
        metadata: { linkUrl: linkUrl || null, isBroadcast: true, targetAudience: audience },
        is_read: false,
        created_at: new Date().toISOString(),
      }));

      // Insert notifications in batches of 500
      const batchSize = 500;
      let allInserted: any[] = [];
      for (let i = 0; i < notificationsPayload.length; i += batchSize) {
        const batch = notificationsPayload.slice(i, i + batchSize);
        const { data: inserted } = await supabase
          .from("notifications")
          .insert(batch)
          .select("id, user_id, title, body, created_at, type, metadata");
        if (inserted) {
          allInserted = allInserted.concat(inserted);
        }
      }

      const primaryId = allInserted[0]?.id || `broadcast-${Date.now()}`;

      // Realtime broadcast signals
      broadcastGlobalMessage({ title, body, linkUrl, id: primaryId }).catch(() => {});

      if (allInserted.length > 0) {
        allInserted.forEach((item: any) => {
          broadcastNotification(item.user_id, item).catch(() => {});
          void sendPushForNotification(item.user_id, {
            id: item.id,
            type: item.type,
            title: item.title,
            body: item.body,
            metadata: item.metadata,
            entity_type: item.entity_type,
            entity_id: item.entity_id,
            actor_pet_id: item.actor_pet_id,
          }).catch((err) => {
            console.error("[admin] broadcast push failed:", err);
          });
        });
      } else {
        recipientUserIds.forEach((uId: string) => {
          broadcastNotification(uId, {
            id: `broadcast-${Date.now()}-${uId}`,
            title,
            body,
            type: "system",
            created_at: new Date().toISOString(),
          }).catch(() => {});
        });
      }
    }

    res.status(200).json({
      success: true,
      recipientCount: recipientUserIds.length,
      message: `Targeted broadcast sent to ${recipientUserIds.length} users.`,
    });
  } catch (err) {
    console.error("[admin] Broadcast notification error:", err);
    res.status(500).json({ error: "Failed to send broadcast" });
  }
});

export default router;
