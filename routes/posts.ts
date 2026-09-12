import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { z } from "zod";
import { broadcastFeedCounts, broadcastNewPost } from "../lib/feedBroadcast.js";
import { attachPetType } from "../lib/inferPetType.js";

dotenv.config();

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("[posts route] Missing Supabase environment variables");
}

// Helper to extract session token from cookie or Auth header
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

function tallyByPostId(
  rows: { post_id: string }[] | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows || []) {
    counts.set(row.post_id, (counts.get(row.post_id) || 0) + 1);
  }
  return counts;
}

async function recountLikes(
  supabase: any,
  postId: string,
): Promise<number> {
  const { count } = await supabase
    .from("likes")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId);
  const likeCount = count ?? 0;
  await (supabase.from("posts") as any)
    .update({ like_count: likeCount, updated_at: new Date().toISOString() })
    .eq("id", postId);
  return likeCount;
}

async function recountComments(
  supabase: any,
  postId: string,
): Promise<number> {
  const { count } = await supabase
    .from("comments")
    .select("id", { count: "exact", head: true })
    .eq("post_id", postId)
    .eq("status", "active");
  const commentCount = count ?? 0;
  await (supabase.from("posts") as any)
    .update({ comment_count: commentCount })
    .eq("id", postId);
  return commentCount;
}

const createPostSchema = z.object({
  petId: z.string().uuid(),
  communityId: z.string().uuid().optional().nullable(),
  caption: z.string().max(500).optional(),
  postType: z
    .enum(["regular", "question", "advice", "meme"])
    .default("regular"),
  mediaData: z.array(z.string()).optional(), // base64 strings or URLs
});

const createCommentSchema = z.object({
  petId: z.string().uuid(),
  content: z.string().min(1).max(500),
  parentCommentId: z.string().uuid().optional().nullable(),
});

const reportPostSchema = z.object({
  reporterPetId: z.string().uuid(),
  reason: z.string().min(1),
  details: z.string().optional(),
});

/**
 * GET /posts/feed
 * Chronological feed query: returns posts from joined communities & followed pets, or all active posts if none
 */
router.get("/feed", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const activePetId = req.query.petId as string;
    const communityId = String(req.query.communityId || "").trim();

    let feedQuery = supabase
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
      .eq("status", "active");

    if (communityId) {
      feedQuery = feedQuery.eq("community_id", communityId);
    }

    const { data: posts, error } = await feedQuery
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      console.error("[posts] Feed query error:", error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const postIds = (posts || []).map((post) => post.id);
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
      activePetId
        ? supabase.from("likes").select("post_id").eq("pet_id", activePetId)
        : Promise.resolve({ data: [] as { post_id: string }[], error: null }),
    ]);

    const likeCounts = (likeRows as any).error ? null : tallyByPostId((likeRows as any).data);
    const commentCounts = (commentRows as any).error
      ? null
      : tallyByPostId((commentRows as any).data);
    const likedPostIds = new Set(
      ((myLikes as any).data || []).map((row: { post_id: string }) => row.post_id),
    );

    const formattedPosts = posts?.map((post) => ({
      ...post,
      pets: attachPetType(post.pets as { breed?: string; pet_type?: string }),
      like_count: likeCounts ? likeCounts.get(post.id) || 0 : post.like_count,
      comment_count: commentCounts
        ? commentCounts.get(post.id) || 0
        : post.comment_count,
      hasLiked: likedPostIds.has(post.id),
      media:
        post.post_media?.sort((a, b) => a.display_order - b.display_order) ||
        [],
    }));

    res.status(200).json({ posts: formattedPosts });
  } catch (err) {
    console.error("[posts] Feed error:", err);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

/**
 * GET /posts/engagement?ids=&petId=
 * Live Treat/Bark counts for posts currently on screen
 */
router.get(
  "/engagement",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accessToken = getAccessToken(req);
      if (!accessToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rawIds = String(req.query.ids || "");
      const postIds = rawIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 30);

      if (postIds.length === 0) {
        res.status(200).json({ posts: [] });
        return;
      }

      const activePetId = req.query.petId as string | undefined;
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const [likeRows, commentRows, myLikes] = await Promise.all([
        supabase.from("likes").select("post_id").in("post_id", postIds),
        supabase
          .from("comments")
          .select("post_id")
          .eq("status", "active")
          .in("post_id", postIds),
        activePetId
          ? supabase
              .from("likes")
              .select("post_id")
              .eq("pet_id", activePetId)
              .in("post_id", postIds)
          : Promise.resolve({ data: [] as { post_id: string }[] }),
      ]);

      const likeCounts = tallyByPostId(likeRows.data);
      const commentCounts = tallyByPostId(commentRows.data);
      const likedPostIds = new Set(
        (myLikes.data || []).map((row) => row.post_id),
      );

      res.status(200).json({
        posts: postIds.map((id) => ({
          id,
          like_count: likeCounts.get(id) || 0,
          comment_count: commentCounts.get(id) || 0,
          hasLiked: likedPostIds.has(id),
        })),
      });
    } catch (err) {
      console.error("[posts] Engagement error:", err);
      res.status(500).json({ error: "Failed to fetch engagement" });
    }
  },
);

/**
 * GET /posts/trending-hashtags
 * Returns top trending hashtags from database
 */
router.get(
  "/trending-hashtags",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
      const { data: hashtags, error } = await supabase
        .from("hashtags")
        .select("name, usage_count")
        .order("usage_count", { ascending: false })
        .limit(8);

      if (error) {
        res.status(200).json([]);
        return;
      }

      res.status(200).json(hashtags || []);
    } catch (err) {
      res.status(200).json([]);
    }
  },
);

/**
 * POST /posts/create
 * Create a new post with optional media attachments
 */
router.post("/create", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { petId, communityId, caption, postType, mediaData } = parsed.data;

    // Verify user owns the pet
    const { data: pet } = await supabase
      .from("pets")
      .select("id, city")
      .eq("id", petId)
      .eq("owner_id", user.id)
      .single();

    if (!pet) {
      res.status(403).json({ error: "You do not own this pet profile" });
      return;
    }

    // Insert post
    const { data: newPost, error: postError } = await supabase
      .from("posts")
      .insert({
        pet_id: petId,
        community_id: communityId || null,
        caption: caption || "",
        post_type: postType,
        location_city: pet.city || "Bangalore",
        status: "active",
      })
      .select(
        `
        id,
        caption,
        post_type,
        location_city,
        like_count,
        comment_count,
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
        )
      `,
      )
      .single();

    if (postError || !newPost) {
      console.error("[posts] Create post error:", postError?.message);
      res.status(500).json({ error: "Failed to create post" });
      return;
    }

    // Handle media uploads if provided
    const insertedMedia = [];
    if (mediaData && mediaData.length > 0) {
      for (let i = 0; i < mediaData.length; i++) {
        const item = mediaData[i];
        let mediaUrl = item;

        // Handle base64 upload to Supabase storage
        if (item.startsWith("data:image/")) {
          try {
            const matches = item.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
              const mimeType = matches[1];
              const buffer = Buffer.from(matches[2], "base64");
              const ext = mimeType.split("/")[1] || "jpeg";
              const fileName = `post_${newPost.id}_${i}_${Date.now()}.${ext}`;

              const { error: uploadError } = await supabase.storage
                .from("pet-profiles")
                .upload(fileName, buffer, {
                  contentType: mimeType,
                  upsert: true,
                });

              if (!uploadError) {
                const {
                  data: { publicUrl },
                } = supabase.storage
                  .from("pet-profiles")
                  .getPublicUrl(fileName);
                mediaUrl = publicUrl;
              } else {
                console.error(
                  "[posts] Supabase storage upload error:",
                  uploadError.message,
                );
                mediaUrl = item;
              }
            }
          } catch (e) {
            console.error("[posts] Exception uploading media:", e);
            mediaUrl = item;
          }
        }

        const { data: mediaRecord } = await supabase
          .from("post_media")
          .insert({
            post_id: newPost.id,
            media_url: mediaUrl,
            display_order: i,
          })
          .select()
          .single();

        if (mediaRecord) insertedMedia.push(mediaRecord);
      }
    }

    const createdPost = {
      ...newPost,
      pets: attachPetType(newPost.pets as { breed?: string; pet_type?: string }),
      hasLiked: false,
      media: insertedMedia
        .filter(
          (item: { media_url?: string }) =>
            item?.media_url && !String(item.media_url).startsWith("data:"),
        )
        .map(
          (item: { id: string; media_url: string; display_order: number }) => ({
            id: item.id,
            media_url: item.media_url,
            display_order: item.display_order,
          }),
        ),
    };

    await broadcastNewPost(createdPost).catch((err) => {
      console.error("[posts] Live post broadcast failed:", err);
    });

    res.status(201).json({
      post: createdPost,
    });
  } catch (err) {
    console.error("[posts] Create error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /posts/:id/like
 * Toggle like / treat for active pet
 */
router.post("/:id/like", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const petId = String(req.body.petId || '');
    if (!petId) {
      res.status(400).json({ error: "petId is required" });
      return;
    }

    const postId = String(req.params.id);
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // Check if already liked
    const { data: existingLike } = await supabase
      .from("likes")
      .select("id")
      .eq("post_id", postId)
      .eq("pet_id", petId)
      .single();

    let hasLiked = false;

    if (existingLike) {
      // Unlike
      await supabase.from("likes").delete().eq("id", existingLike.id);
      hasLiked = false;
    } else {
      // Like
      await supabase.from("likes").insert({ post_id: postId, pet_id: petId });
      hasLiked = true;
    }

    const likeCount = await recountLikes(supabase, postId);
    await broadcastFeedCounts({
      postId,
      likeCount,
      likedByPetId: hasLiked ? petId : null,
      unlikedByPetId: hasLiked ? null : petId,
    });

    res.status(200).json({ hasLiked, likeCount });
  } catch (err) {
    console.error("[posts] Like error:", err);
    res.status(500).json({ error: "Failed to update like status" });
  }
});

/**
 * GET /posts/:id/comments
 * Fetch comments for a post
 */
router.get(
  "/:id/comments",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = req.params.id;
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const { data: comments, error } = await supabase
        .from("comments")
        .select(
          `
        id,
        content,
        created_at,
        pets:pet_id (
          id,
          name,
          username,
          profile_image_url
        )
      `,
        )
        .eq("post_id", postId)
        .eq("status", "active")
        .order("created_at", { ascending: true });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(200).json({ comments });
    } catch (err) {
      console.error("[posts] Get comments error:", err);
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  },
);

/**
 * POST /posts/:id/comments
 * Add a comment (bark) to a post
 */
router.post(
  "/:id/comments",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accessToken = getAccessToken(req);
      if (!accessToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const parsed = createCommentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const postId = String(req.params.id);
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const { petId, content, parentCommentId } = parsed.data;

      const { data: newComment, error } = await supabase
        .from("comments")
        .insert({
          post_id: postId,
          pet_id: petId,
          parent_comment_id: parentCommentId || null,
          content,
          status: "active",
        })
        .select(
          `
        id,
        content,
        created_at,
        pets:pet_id (
          id,
          name,
          username,
          profile_image_url
        )
      `,
        )
        .single();

      if (error || !newComment) {
        res.status(500).json({ error: "Failed to add comment" });
        return;
      }

      const commentCount = await recountComments(supabase, postId);
      await broadcastFeedCounts({ postId, commentCount });

      res.status(201).json({ comment: newComment, commentCount });
    } catch (err) {
      console.error("[posts] Add comment error:", err);
      res.status(500).json({ error: "Failed to add comment" });
    }
  },
);

/**
 * POST /posts/:id/report
 * Report a post
 */
router.post(
  "/:id/report",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accessToken = getAccessToken(req);
      if (!accessToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const parsed = reportPostSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }

      const postId = req.params.id;
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

      const { reporterPetId, reason, details } = parsed.data;

      const { data: report, error } = await supabase
        .from("reports")
        .insert({
          reporter_pet_id: reporterPetId,
          entity_type: "post",
          entity_id: postId,
          reason: details ? `${reason}: ${details}` : reason,
          status: "pending",
        })
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: "Failed to submit report" });
        return;
      }

      res
        .status(201)
        .json({ message: "Report submitted successfully", report });
    } catch (err) {
      console.error("[posts] Report error:", err);
      res.status(500).json({ error: "Failed to submit report" });
    }
  },
);

/**
 * DELETE /posts/:id
 * Delete a post (owner only)
 */
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const postId = String(req.params.id);
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    // Fetch post details to check ownership
    const { data: post } = await supabase
      .from("posts")
      .select("id, pet_id, pets:pet_id (owner_id)")
      .eq("id", postId)
      .single();

    if (!post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const ownerId = (post.pets as any)?.owner_id;
    if (ownerId && ownerId !== user.id) {
      res.status(403).json({ error: "Forbidden: You do not own this post" });
      return;
    }

    // Soft delete post by setting status to 'deleted'
    await (supabase.from("posts") as any)
      .update({ status: "deleted" })
      .eq("id", postId);

    // Hard delete for database cleanup if allowed
    try {
      await supabase.from("posts").delete().eq("id", postId);
    } catch {
      // Ignored if foreign key cascades exist
    }

    res.status(200).json({ success: true, message: "Post deleted successfully", postId });
  } catch (err) {
    console.error("[posts] Delete post error:", err);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

export default router;
