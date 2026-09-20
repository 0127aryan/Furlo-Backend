import { Router, Request, Response } from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { paginationMeta, parsePagination } from "../lib/pagination.js";

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
  "id, name, slug, description, cover_image_url, member_count, is_active, created_at, status, is_approved, is_verified";
const FULL_SELECT =
  "id, name, slug, description, cover_image_url, member_count, is_active, created_at, category, city, created_by_pet_id, rules, logo_image_url, status, is_approved, is_verified";

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

function ilikeSafe(value: string) {
  return value.replace(/[%_,()]/g, " ").trim();
}

function applyCommunityFilters(query: any, q: string, categoryRaw: string) {
  let next = query.or("status.is.null,status.neq.rejected");

  if (q) {
    const needle = ilikeSafe(q);
    if (needle) {
      next = next.or(
        `name.ilike.%${needle}%,description.ilike.%${needle}%,city.ilike.%${needle}%`,
      );
    }
  }

  if (categoryRaw && categoryRaw !== "all packs" && categoryRaw !== "all") {
    if (categoryRaw.includes("breed")) {
      next = next.or(
        "category.ilike.%breed%,name.ilike.%retriever%,name.ilike.%indie%,description.ilike.%breed%",
      );
    } else if (categoryRaw.includes("local")) {
      next = next.or(
        "category.ilike.%local%,name.ilike.%bangalore%,description.ilike.%bangalore%",
      );
    } else if (categoryRaw.includes("nutrition")) {
      next = next.or(
        "category.ilike.%nutrition%,description.ilike.%feed%,description.ilike.%diet%",
      );
    } else if (categoryRaw.includes("train")) {
      next = next.or("category.ilike.%train%,description.ilike.%puppy%");
    } else if (categoryRaw.includes("senior")) {
      next = next.or("category.ilike.%senior%,description.ilike.%senior%");
    } else {
      const category = ilikeSafe(categoryRaw);
      if (category) next = next.ilike("category", `%${category}%`);
    }
  }

  return next;
}

async function fetchCommunitiesPage(
  supabase: SupabaseClient,
  withExtras: boolean,
  q: string,
  categoryRaw: string,
  offset: number,
  limit: number,
): Promise<{ data: any[] | null; error: any; count: number | null }> {
  const columns = withExtras ? FULL_SELECT : CORE_SELECT;
  const query = applyCommunityFilters(
    supabase
      .from("communities")
      .select(columns, { count: "exact" })
      .eq("is_active", true)
      .order("member_count", { ascending: false }),
    q,
    categoryRaw,
  );
  return query.range(offset, offset + limit - 1);
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
        .select("category, status, is_approved, is_verified")
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
    const { page, limit, offset } = parsePagination(req.query);

    let { data: rows, error, count } = await fetchCommunitiesPage(
      supabase,
      true,
      q,
      categoryRaw,
      offset,
      limit,
    );
    if (error) {
      const retry = await fetchCommunitiesPage(supabase, false, q, categoryRaw, offset, limit);
      rows = retry.data;
      error = retry.error;
      count = retry.count;
    }

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const list = rows || [];
    const pageIds = list.map((row) => String(row.id));

    const joinedIds = new Set<string>();
    if (petId && pageIds.length > 0) {
      const { data: memberships } = await supabase
        .from("community_members")
        .select("community_id")
        .eq("pet_id", petId)
        .in("community_id", pageIds);
      for (const row of memberships || []) joinedIds.add(row.community_id);
    }

    const memberCountMap: Record<string, number> = {};
    if (pageIds.length > 0) {
      const { data: countRows } = await supabase
        .from("community_members")
        .select("community_id")
        .in("community_id", pageIds);

      for (const row of countRows || []) {
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
          trending: page === 1 && index < 5,
        },
      );
    });

    res.status(200).json({
      communities: formatted,
      ...paginationMeta(page, limit, count || 0),
    });
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
        "community:community_id (id, name, slug, description, cover_image_url, member_count, category, city, logo_image_url, status, is_approved, is_verified)",
      )
      .eq("pet_id", petId);

    if (error) {
      const retry = await supabase
        .from("community_members")
        .select(
          "community:community_id (id, name, slug, description, cover_image_url, member_count, status, is_approved, is_verified)",
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
async function resolveCommunity(supabase: SupabaseClient, param: string) {
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
  if (result.error || !communityRow || communityRow.is_active === false) {
    return null;
  }
  return communityRow;
}

router.get("/:slug/members", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const communityRow = await resolveCommunity(supabase, String(req.params.slug));
    if (!communityRow) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    const { page, limit, offset } = parsePagination(req.query);
    const { data: memberRows, count, error } = await supabase
      .from("community_members")
      .select("pet:pet_id (id, name, username, breed, city, profile_image_url)", { count: "exact" })
      .eq("community_id", communityRow.id)
      .range(offset, offset + limit - 1);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const members = (memberRows || []).map((row) => parsePet(row.pet)).filter(Boolean);
    res.status(200).json({
      members,
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[communities] Members error:", err);
    res.status(500).json({ error: "Failed to fetch community members" });
  }
});

router.get("/:slug", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = db();
    const param = String(req.params.slug);
    const petId = String(req.query.petId || "").trim();
    const communityRow = await resolveCommunity(supabase, param);
    if (!communityRow) {
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
      .limit(10);

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

    const mapped = mapCommunity(
      { ...communityRow, member_count: liveCount } as Record<string, unknown>,
      { joined },
    );

    res.status(200).json({
      community: mapped,
      joined,
      members,
      memberCount: liveCount,
      admins,
      announcement,
      rules: mapped.rules,
      posts: [],
    });
  } catch (err) {
    console.error("[communities] Detail error:", err);
    res.status(500).json({ error: "Failed to fetch community details" });
  }
});

export default router;
