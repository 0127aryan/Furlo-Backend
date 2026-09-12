import { Router, Request, Response } from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { attachPetType } from "../lib/inferPetType.js";

dotenv.config();

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const PACK_CATEGORIES = ["local", "breed", "nutrition", "training"] as const;
type PackCategory = (typeof PACK_CATEGORIES)[number];

const CORE_SELECT =
  "id, name, slug, description, cover_image_url, member_count, is_active, created_at";
const FULL_SELECT =
  "id, name, slug, description, cover_image_url, member_count, is_active, created_at, category, city, created_by_pet_id, rules, logo_image_url";

function db(): SupabaseClient {
  return createClient(supabaseUrl!, supabaseServiceKey!);
}

function getAccessToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map((c) => {
      const [key, ...v] = c.split("=");
      return [key, v.join("=")];
    }),
  );
  if (cookies.furlo_session) return cookies.furlo_session;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  return null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parsePet(value: unknown) {
  if (!value) return null;
  return Array.isArray(value) ? value[0] || null : value;
}

function tallyByPostId(
  rows: { post_id: string }[] | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows || []) {
    counts.set(row.post_id, (counts.get(row.post_id) || 0) + 1);
  }
  return counts;
}

async function uploadCover(
  supabase: SupabaseClient,
  coverData: string,
  slug: string,
): Promise<string> {
  if (!coverData.startsWith("data:image/")) return coverData;
  const matches = coverData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length < 3) return coverData;
  const mimeType = matches[1];
  const buffer = Buffer.from(matches[2], "base64");
  const extension = mimeType.split("/")[1] || "jpeg";
  const fileName = `packs/${slug}_${Date.now()}.${extension}`;
  const { error } = await supabase.storage.from("pet-profiles").upload(fileName, buffer, {
    contentType: mimeType,
    upsert: true,
  });
  if (error) {
    console.warn("[communities] Cover upload fallback:", error.message);
    return coverData;
  }
  const { data } = supabase.storage.from("pet-profiles").getPublicUrl(fileName);
  return data.publicUrl || coverData;
}

async function fetchCommunities(
  supabase: SupabaseClient,
  withExtras: boolean,
): Promise<{ data: any[] | null; error: any }> {
  if (withExtras) {
    return supabase
      .from("communities")
      .select(FULL_SELECT)
      .eq("is_active", true)
      .order("member_count", { ascending: false });
  }
  return supabase
    .from("communities")
    .select(CORE_SELECT)
    .eq("is_active", true)
    .order("member_count", { ascending: false });
}

function mapCommunity(
  row: Record<string, unknown>,
  extras: {
    joined?: boolean;
    trending?: boolean;
    sampleMembers?: unknown[];
  } = {},
) {
  const isApproved = row.is_approved === true || row.status === "approved" || row.is_verified === true;
  const isVerified = Boolean(row.is_verified || row.is_approved || row.status === "approved");
  const status = (row.status as string) || (isApproved ? "approved" : "pending");

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? "",
    cover_image_url: row.cover_image_url ?? null,
    logo_image_url: row.logo_image_url ?? row.cover_image_url ?? null,
    member_count: row.member_count ?? 0,
    category: (row.category as string) || (row.requested_category as string) || "General",
    requested_category: (row.requested_category as string) || (row.category as string) || "General",
    city: (row.city as string) || null,
    created_by_pet_id: row.created_by_pet_id ?? null,
    rules: Array.isArray(row.rules) ? row.rules : [],
    is_active: row.is_active,
    status,
    is_approved: isApproved,
    is_verified: isVerified,
    created_at: row.created_at,
    joined: Boolean(extras.joined),
    is_joined: Boolean(extras.joined),
    trending: Boolean(extras.trending),
    sample_members: extras.sampleMembers || [],
  };
}

async function requireUser(req: Request, supabase: SupabaseClient) {
  const accessToken = getAccessToken(req);
  if (!accessToken) return { error: "Unauthorized" as const, user: null };
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(accessToken);
  if (error || !user) return { error: "Invalid session" as const, user: null };
  return { error: null, user };
}

/**
 * GET /communities/categories
 * Dynamically fetch only approved community category types from database
 */
router.get("/categories", async (_req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    let { data, error } = await supabase
      .from("communities")
      .select("category, status, is_approved, is_verified")
      .eq("is_active", true);

    if (error) {
      const retry = await supabase
        .from("communities")
        .select("category")
        .eq("is_active", true);
      data = retry.data;
    }

    // Only include categories from communities approved by Super Admin (or legacy rows without status)
    const approvedRows = (data || []).filter((r: any) => {
      return (
        r.is_approved === true ||
        r.status === "approved" ||
        r.is_verified === true ||
        r.status === null ||
        r.status === undefined
      );
    });

    const rawCategories = approvedRows
      .map((r: any) => String(r.category || "").trim())
      .filter((cat) => cat && cat.toLowerCase() !== "general" && cat.toLowerCase() !== "pending approval");

    const mapCategoryLabel = (cat: string) => {
      const lower = cat.toLowerCase();
      if (lower === "breed" || lower === "dog breeds") return "Dog Breeds";
      if (lower === "local" || lower === "bangalore local" || lower === "local meetups") return "Bangalore Local";
      if (lower === "nutrition" || lower === "nutrition & diet") return "Nutrition & Diet";
      if (lower === "training" || lower === "puppy training") return "Puppy Training";
      if (lower === "senior" || lower === "senior dogs") return "Senior Dogs";
      return cat;
    };

    const uniqueApprovedCategories = Array.from(new Set(rawCategories.map(mapCategoryLabel)));

    // Return "All Packs" + ONLY categories that belong to approved communities
    res.status(200).json(["All Packs", ...uniqueApprovedCategories]);
  } catch (err) {
    console.error("[communities] Categories fetch error:", err);
    res.status(200).json(["All Packs"]);
  }
});

/**
 * GET /communities
 */
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const q = String(req.query.q || "").trim();
    const categoryRaw = String(req.query.category || "").trim().toLowerCase();
    const petId = String(req.query.petId || "").trim();

    let { data: rows, error } = await fetchCommunities(supabase, true);
    if (error) {
      const retry = await fetchCommunities(supabase, false);
      rows = retry.data;
      error = retry.error;
    }

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    let list = (rows || []).filter((row) => (row as any).status !== "rejected");

    if (q) {
      const needle = q.toLowerCase();
      list = list.filter(
        (row) =>
          String(row.name || "").toLowerCase().includes(needle) ||
          String(row.description || "").toLowerCase().includes(needle) ||
          String(row.city || "").toLowerCase().includes(needle),
      );
    }

    if (categoryRaw && categoryRaw !== "all packs" && categoryRaw !== "all") {
      list = list.filter((row) => {
        const cat = String((row as any).category || "").toLowerCase();
        const name = String((row as any).name || "").toLowerCase();
        const desc = String((row as any).description || "").toLowerCase();

        if (cat === categoryRaw) return true;
        if (categoryRaw.includes("breed") && (cat.includes("breed") || name.includes("retriever") || name.includes("indie") || desc.includes("breed"))) return true;
        if (categoryRaw.includes("local") && (cat.includes("local") || name.includes("bangalore") || desc.includes("bangalore"))) return true;
        if (categoryRaw.includes("nutrition") && (cat.includes("nutrition") || desc.includes("feed") || desc.includes("diet"))) return true;
        if (categoryRaw.includes("train") && (cat.includes("train") || desc.includes("puppy"))) return true;
        if (categoryRaw.includes("senior") && (cat.includes("senior") || desc.includes("senior"))) return true;

        return false;
      });
    }

    const joinedIds = new Set<string>();
    if (petId) {
      const { data: memberships } = await supabase
        .from("community_members")
        .select("community_id")
        .eq("pet_id", petId);
      for (const row of memberships || []) joinedIds.add(row.community_id);
    }

    // Query exact live member counts from community_members table for all communities
    const memberCountMap: Record<string, number> = {};
    const { data: countRows } = await supabase
      .from("community_members")
      .select("community_id");

    if (countRows) {
      for (const row of countRows) {
        const cId = String(row.community_id);
        memberCountMap[cId] = (memberCountMap[cId] || 0) + 1;
      }
    }

    const formatted = list.map((row, index) => {
      const cId = String(row.id);
      const liveCount = memberCountMap[cId] !== undefined ? memberCountMap[cId] : (row.member_count ?? 0);
      return mapCommunity(
        { ...row, member_count: liveCount } as Record<string, unknown>,
        {
          joined: joinedIds.has(cId),
          trending: index < 5,
        },
      );
    });

    res.status(200).json(formatted);
  } catch (err) {
    console.error("[communities] List error:", err);
    res.status(500).json({ error: "Failed to fetch communities" });
  }
});

/**
 * GET /communities/mine
 */
router.get("/mine", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const petId = String(req.query.petId || "").trim();
    if (!petId) {
      res.status(200).json([]);
      return;
    }

    const { data: memberships, error } = await supabase
      .from("community_members")
      .select(
        "community:community_id (id, name, slug, description, cover_image_url, member_count, category, city, logo_image_url)",
      )
      .eq("pet_id", petId);

    if (error) {
      const retry = await supabase
        .from("community_members")
        .select(
          "community:community_id (id, name, slug, description, cover_image_url, member_count)",
        )
        .eq("pet_id", petId);
      if (retry.error) {
        res.status(500).json({ error: retry.error.message });
        return;
      }
      res.status(200).json(
        (retry.data || [])
          .map((row: { community?: unknown }) => parsePet(row.community))
          .filter(Boolean)
          .map((row) => mapCommunity(row as Record<string, unknown>, { joined: true })),
      );
      return;
    }

    res.status(200).json(
      (memberships || [])
        .map((row: { community?: unknown }) => parsePet(row.community))
        .filter(Boolean)
        .map((row) => mapCommunity(row as Record<string, unknown>, { joined: true })),
    );
  } catch (err) {
    console.error("[communities] Mine error:", err);
    res.status(500).json({ error: "Failed to fetch joined packs" });
  }
});

/**
 * POST /communities & POST /communities/create
 */
router.post(["/", "/create"], async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const auth = await requireUser(req, supabase);
    if (auth.error || !auth.user) {
      res.status(401).json({ error: auth.error || "Unauthorized" });
      return;
    }

    const { petId, name, category, city, location_city, description, coverData, cover_image_url } = req.body as {
      petId?: string;
      name?: string;
      category?: string;
      city?: string;
      location_city?: string;
      description?: string;
      coverData?: string;
      cover_image_url?: string;
    };

    if (!name || name.trim().length < 2) {
      res.status(400).json({ error: "Pack name must be at least 2 characters" });
      return;
    }

    const packCategory = PACK_CATEGORIES.includes(category as PackCategory)
      ? (category as PackCategory)
      : "local";

    let activePetId = petId;
    if (!activePetId) {
      const { data: myPets } = await supabase
        .from("pets")
        .select("id")
        .eq("owner_id", auth.user.id)
        .limit(1);
      activePetId = myPets?.[0]?.id;
    }
    if (!activePetId) {
      res.status(400).json({ error: "A pet profile is required to create a pack" });
      return;
    }

    let slug = slugify(name);
    if (!slug) slug = `pack-${Date.now()}`;
    const { data: existing } = await supabase.from("communities").select("id").eq("slug", slug).limit(1);
    if (existing && existing.length > 0) {
      slug = `${slug}-${Math.floor(100 + Math.random() * 900)}`;
    }

    const rawCover = coverData || cover_image_url;
    let coverUrl =
      rawCover && !rawCover.startsWith("data:image/")
        ? rawCover
        : "https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=1200&q=80";

    if (rawCover && rawCover.startsWith("data:image/")) {
      coverUrl = await uploadCover(supabase, rawCover, slug);
    }

    const requestedCategory = category?.trim() || packCategory;
    const packCity = city?.trim() || location_city?.trim() || null;

    const insertCore = {
      name: name.trim(),
      slug,
      description: (description || "").trim().slice(0, 300) || "A new pack on Furlo.",
      cover_image_url: coverUrl,
      member_count: 1,
      is_active: true,
      status: "pending",
      is_approved: false,
      is_verified: false,
    };

    const insertFull = {
      ...insertCore,
      category: requestedCategory,
      requested_category: requestedCategory,
      city: packCity,
      created_by_pet_id: activePetId,
      logo_image_url: coverUrl,
      rules: [] as string[],
    };

    const insertBare = {
      name: name.trim(),
      slug,
      description: (description || "").trim().slice(0, 300) || "A new pack on Furlo.",
      cover_image_url: coverUrl,
      member_count: 1,
      is_active: true,
    };

    let created = (
      await supabase.from("communities").insert(insertFull).select().single()
    );
    if (created.error) {
      created = await supabase.from("communities").insert(insertCore).select().single();
    }
    if (created.error) {
      created = await supabase.from("communities").insert(insertBare).select().single();
    }

    if (created.error || !created.data) {
      res.status(500).json({ error: created.error?.message || "Failed to create pack" });
      return;
    }

    await supabase.from("community_members").insert({
      community_id: created.data.id,
      pet_id: activePetId,
    });

    res.status(201).json({
      success: true,
      community: mapCommunity(created.data as Record<string, unknown>, { joined: true }),
    });
  } catch (err) {
    console.error("[communities] Create error:", err);
    res.status(500).json({ error: "Failed to create pack" });
  }
});

/**
 * POST /communities/:id/join
 */
router.post("/:id/join", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const auth = await requireUser(req, supabase);
    if (auth.error || !auth.user) {
      res.status(401).json({ error: auth.error || "Unauthorized" });
      return;
    }

    const communityId = String(req.params.id);
    let activePetId = String(req.body?.petId || "").trim();
    if (!activePetId) {
      const { data: myPets } = await supabase
        .from("pets")
        .select("id")
        .eq("owner_id", auth.user.id)
        .limit(1);
      activePetId = myPets?.[0]?.id || "";
    }
    if (!activePetId) {
      res.status(400).json({ error: "No active pet profile found to join pack" });
      return;
    }

    const { data: existing } = await supabase
      .from("community_members")
      .select("id")
      .eq("community_id", communityId)
      .eq("pet_id", activePetId)
      .maybeSingle();

    let joined = false;
    if (existing) {
      await supabase.from("community_members").delete().eq("id", existing.id);
      joined = false;
    } else {
      await supabase.from("community_members").insert({
        community_id: communityId,
        pet_id: activePetId,
      });
      joined = true;
    }

    const { count } = await supabase
      .from("community_members")
      .select("id", { count: "exact", head: true })
      .eq("community_id", communityId);

    await supabase
      .from("communities")
      .update({ member_count: count ?? 0 })
      .eq("id", communityId);

    res.status(200).json({
      success: true,
      joined,
      is_joined: joined,
      member_count: count ?? 0,
    });
  } catch (err) {
    console.error("[communities] Join error:", err);
    res.status(500).json({ error: "Failed to update pack membership" });
  }
});

/**
 * GET /communities/:slug
 */
router.get("/:slug", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const param = String(req.params.slug);
    const petId = String(req.query.petId || "").trim();
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    let result: any = isUuid
      ? await supabase.from("communities").select(FULL_SELECT).eq("id", param).limit(1)
      : await supabase.from("communities").select(FULL_SELECT).eq("slug", param).limit(1);

    if (result.error) {
      result = isUuid
        ? await supabase.from("communities").select(CORE_SELECT).eq("id", param).limit(1)
        : await supabase.from("communities").select(CORE_SELECT).eq("slug", param).limit(1);
    }

    const communityRow = result.data?.[0];
    if (result.error || !communityRow) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    let joined = false;
    if (petId) {
      const { data: memberRow } = await supabase
        .from("community_members")
        .select("id")
        .eq("community_id", communityRow.id)
        .eq("pet_id", petId)
        .maybeSingle();
      joined = Boolean(memberRow);
    }

    const { data: memberRows, count: totalMemberCount } = await supabase
      .from("community_members")
      .select("pet:pet_id (id, name, username, breed, city, profile_image_url)", { count: "exact" })
      .eq("community_id", communityRow.id)
      .limit(80);

    const members = (memberRows || []).map((row) => parsePet(row.pet)).filter(Boolean);
    const liveCount = totalMemberCount ?? members.length;

    let announcement: { title: string; content: string } | null = null;
    const pinned = await supabase
      .from("community_announcements")
      .select("title, content")
      .eq("community_id", communityRow.id)
      .eq("is_pinned", true)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!pinned.error && pinned.data?.[0]) {
      announcement = {
        title: pinned.data[0].title,
        content: pinned.data[0].content,
      };
    } else {
      const latest = await supabase
        .from("community_announcements")
        .select("title, content")
        .eq("community_id", communityRow.id)
        .order("created_at", { ascending: false })
        .limit(1);
      if (!latest.error && latest.data?.[0]) {
        announcement = {
          title: latest.data[0].title,
          content: latest.data[0].content,
        };
      }
    }

    let admins: unknown[] = [];
    const createdBy = (communityRow as { created_by_pet_id?: string }).created_by_pet_id;
    if (createdBy) {
      const { data: adminPets } = await supabase
        .from("pets")
        .select("id, name, username, breed, city, profile_image_url")
        .eq("id", createdBy)
        .limit(1);
      admins = adminPets || [];
    }
    if (admins.length === 0) admins = members.slice(0, 1);

    // Query community posts
    const { data: communityPosts } = await supabase
      .from("posts")
      .select(
        `
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
      `,
      )
      .eq("community_id", communityRow.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(50);

    const postIds = (communityPosts || []).map((post) => post.id);
    const [likeRows, commentRows, myLikes] = await Promise.all([
      postIds.length
        ? supabase.from("likes").select("post_id").in("post_id", postIds)
        : Promise.resolve({ data: [] as { post_id: string }[], error: null }),
      postIds.length
        ? supabase
            .from("comments")
            .select("post_id")
            .eq("status", "active")
            .in("post_id", postIds)
        : Promise.resolve({ data: [] as { post_id: string }[], error: null }),
      petId
        ? supabase.from("likes").select("post_id").eq("pet_id", petId)
        : Promise.resolve({ data: [] as { post_id: string }[], error: null }),
    ]);

    const likeCounts = (likeRows as any).error ? null : tallyByPostId((likeRows as any).data);
    const commentCounts = (commentRows as any).error
      ? null
      : tallyByPostId((commentRows as any).data);
    const likedPostIds = new Set(
      ((myLikes as any).data || []).map((row: { post_id: string }) => row.post_id),
    );

    const formattedPosts = (communityPosts || []).map((post) => ({
      ...post,
      pets: attachPetType(post.pets as { breed?: string; pet_type?: string }),
      like_count: likeCounts ? likeCounts.get(post.id) || 0 : post.like_count,
      comment_count: commentCounts
        ? commentCounts.get(post.id) || 0
        : post.comment_count,
      hasLiked: likedPostIds.has(post.id),
      media:
        post.post_media?.sort((a: any, b: any) => a.display_order - b.display_order) ||
        [],
    }));

    const mapped = mapCommunity(
      { ...communityRow, member_count: liveCount } as Record<string, unknown>,
      { joined },
    );

    res.status(200).json({
      community: mapped,
      joined,
      members,
      admins,
      announcement,
      rules: mapped.rules,
      posts: formattedPosts,
    });
  } catch (err) {
    console.error("[communities] Detail error:", err);
    res.status(500).json({ error: "Failed to fetch community details" });
  }
});

export default router;
