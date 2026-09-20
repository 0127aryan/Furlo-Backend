import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { z } from "zod";
import { broadcastFeedCounts, broadcastNewPost, broadcastModerationReport } from "../lib/feedBroadcast.js";
import { attachPetType } from "../lib/inferPetType.js";
import { paginationMeta, parsePagination } from "../lib/pagination.js";
import { createNotificationHelper } from "./notifications.js";

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

const createPostSchema = z
  .object({
    petId: z.string().uuid(),
    communityId: z.string().uuid().optional().nullable(),
    caption: z.string().max(500).optional(),
    postType: z
      .enum(["regular", "question", "advice", "meme"])
      .default("regular"),
    topicCategory: z.string().optional().nullable(),
    mediaData: z.array(z.string()).optional(), // base64 strings or URLs
  })
  .refine(
    (data) => {
      const hasCaption = Boolean(data.caption?.trim());
      const hasMedia = Boolean(
        data.mediaData?.some((item) => typeof item === "string" && item.trim().length > 0)
      );
      return hasCaption || hasMedia;
    },
    { message: "Add a caption or a photo to post." }
  );

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
    const authorPetId = String(req.query.authorPetId || "").trim();
    const { page, limit, offset } = parsePagination(req.query);

    let feedQuery = supabase
      .from("posts")
      .select(
        `
        id,
        caption,
        post_type,
        topic_category,
        is_solved,
        accepted_answer_id,
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
          profile_image_url,
          is_verified,
          is_founding_pet
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
        { count: "exact" },
      )
      .eq("status", "active");

    if (communityId) {
      feedQuery = feedQuery.eq("community_id", communityId);
    }

    if (authorPetId) {
      feedQuery = feedQuery.eq("pet_id", authorPetId);
    }

    const { data: posts, error, count } = await feedQuery
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

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

    res.status(200).json({
      posts: formattedPosts,
      ...paginationMeta(page, limit, count || 0),
    });
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

    const { petId, communityId, caption, postType, topicCategory, mediaData } = parsed.data;

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
        topic_category: topicCategory || null,
        is_solved: false,
        location_city: pet.city || "Bangalore",
        status: "active",
      })
      .select(
        `
        id,
        caption,
        post_type,
        topic_category,
        is_solved,
        accepted_answer_id,
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
          profile_image_url,
          is_verified,
          is_founding_pet
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

    if (hasLiked) {
      // Trigger notification for post author
      try {
        const { data: { user } } = await supabase.auth.getUser(accessToken);
        if (user) {
          const { data: post } = await supabase
            .from("posts")
            .select("id, pet_id")
            .eq("id", postId)
            .single();

          if (post?.pet_id) {
            const { data: targetPet } = await supabase
              .from("pets")
              .select("name, owner_id")
              .eq("id", post.pet_id)
              .single();

            const postOwnerId = targetPet?.owner_id || user.id;
            if (postOwnerId !== user.id) {
              const { data: actorPet } = await supabase.from("pets").select("name").eq("id", petId).single();

              await createNotificationHelper(supabase, {
                userId: postOwnerId,
                recipientPetId: post.pet_id,
                actorPetId: petId,
                type: "treat",
                title: "New Treat 🐾",
                body: `${actorPet?.name || "A pet"} sent a treat to ${targetPet?.name ? targetPet.name + "'s" : "your"} post`,
                entityType: "post",
                entityId: postId,
              });
            }
          }
        }
      } catch (err) {
        console.error("[posts] Treat notification error:", err);
      }
    }

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
          profile_image_url,
          is_verified,
          is_founding_pet
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
      const { data: { user } } = await supabase.auth.getUser(accessToken);
      if (!user) {
        res.status(401).json({ error: "Invalid user session" });
        return;
      }

      const { petId, content, parentCommentId } = parsed.data;

      // Verify petId exists and belongs to user context
      let targetPetId = petId;
      const { data: petCheck } = await supabase
        .from("pets")
        .select("id, owner_id")
        .eq("id", petId)
        .single();

      if (!petCheck) {
        const { data: userPets } = await supabase
          .from("pets")
          .select("id")
          .eq("owner_id", user.id)
          .limit(1);

        if (userPets && userPets.length > 0) {
          targetPetId = userPets[0].id;
        } else {
          res.status(400).json({ error: "No active pet profile found. Please create a pet profile first." });
          return;
        }
      }

      const { data: insertedComment, error } = await supabase
        .from("comments")
        .insert({
          post_id: postId,
          pet_id: targetPetId,
          parent_comment_id: parentCommentId || null,
          content,
          status: "active",
        })
        .select("id, content, created_at, pet_id")
        .single();

      if (error || !insertedComment) {
        console.error("[posts] Add comment DB insert error:", error);
        res.status(500).json({ error: error?.message || "Failed to add comment" });
        return;
      }

      const { data: pet } = await supabase
        .from("pets")
        .select("id, name, username, profile_image_url")
        .eq("id", targetPetId)
        .single();

      const newComment = {
        ...insertedComment,
        pets: pet || null,
      };

      const commentCount = await recountComments(supabase, postId);
      await broadcastFeedCounts({ postId, commentCount }).catch((err) => {
        console.error("[posts] Live comment broadcast failed:", err);
      });

      // Trigger notification for post author
      try {
        const { data: post } = await supabase
          .from("posts")
          .select("id, pet_id")
          .eq("id", postId)
          .single();

        if (post?.pet_id) {
          const { data: targetPet } = await supabase
            .from("pets")
            .select("name, owner_id")
            .eq("id", post.pet_id)
            .single();

          const postOwnerId = targetPet?.owner_id || user.id;
          const { data: actorPet } = await supabase.from("pets").select("name").eq("id", targetPetId).single();

          await createNotificationHelper(supabase, {
            userId: postOwnerId,
            actorPetId: targetPetId,
            type: "comment",
            title: "New Comment 💬",
            body: `${actorPet?.name || "A pet"} commented: "${content.substring(0, 50)}"`,
            entityType: "post",
            entityId: postId,
            metadata: { commentId: newComment.id, excerpt: content },
          });
        }
      } catch (err) {
        console.error("[posts] Comment notification error:", err);
      }

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

      broadcastModerationReport(report).catch((bcErr) => {
        console.warn("[posts] Broadcast moderation report error:", bcErr);
      });

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

/**
 * GET /posts/qa/questions
 * Filterable Q&A Hub feed endpoint
 */
router.get("/qa/questions", async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const category = String(req.query.category || "").trim();
    const unanswered = req.query.unanswered === "true";
    const filter = String(req.query.filter || "all").trim().toLowerCase();
    const search = String(req.query.search || "").trim();
    const petId = req.query.petId as string | undefined;
    const { page, limit, offset } = parsePagination(req.query);

    let query = supabase
      .from("posts")
      .select(
        `
        id,
        caption,
        post_type,
        topic_category,
        is_solved,
        accepted_answer_id,
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
          profile_image_url,
          is_verified,
          is_founding_pet
        ),
        post_media (
          id,
          media_url,
          display_order
        )
      `,
        { count: "exact" },
      )
      .eq("status", "active")
      .eq("post_type", "question");

    if (category && category !== "All Questions") {
      query = query.ilike("topic_category", `%${category}%`);
    }

    if (unanswered) {
      query = query.eq("comment_count", 0);
    }

    if (filter === "solved") {
      query = query.eq("is_solved", true);
    } else if (filter === "unanswered") {
      query = query.eq("is_solved", false);
    }

    if (search) {
      query = query.or(`caption.ilike.%${search}%,topic_category.ilike.%${search}%`);
    }

    const { data: questions, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("[posts] Q&A query error:", error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const postIds = (questions || []).map((q) => q.id);
    const acceptedAnswerIds = (questions || [])
      .map((q) => q.accepted_answer_id)
      .filter(Boolean);

    let acceptedAnswersMap = new Map<string, any>();
    if (acceptedAnswerIds.length > 0) {
      const { data: answers } = await supabase
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
            profile_image_url,
            is_verified,
            is_founding_pet
          )
        `
        )
        .in("id", acceptedAnswerIds);

      for (const a of answers || []) {
        acceptedAnswersMap.set(a.id, a);
      }
    }

    let likedPostIds = new Set<string>();
    if (petId && postIds.length > 0) {
      const { data: myLikes } = await supabase
        .from("likes")
        .select("post_id")
        .eq("pet_id", petId)
        .in("post_id", postIds);
      (myLikes || []).forEach((row) => likedPostIds.add(row.post_id));
    }

    const formattedQuestions = (questions || []).map((q) => ({
      ...q,
      pets: attachPetType(q.pets as any),
      hasLiked: likedPostIds.has(q.id),
      accepted_answer: q.accepted_answer_id ? acceptedAnswersMap.get(q.accepted_answer_id) || null : null,
      media: q.post_media?.sort((a, b) => a.display_order - b.display_order) || [],
    }));

    res.status(200).json({
      questions: formattedQuestions,
      ...paginationMeta(page, limit, count || 0),
    });
  } catch (err) {
    console.error("[posts] Q&A Hub error:", err);
    res.status(500).json({ error: "Failed to fetch Q&A questions" });
  }
});

/**
 * GET /posts/qa/trending
 * Top trending questions for Q&A right sidebar (computed live from DB)
 */
router.get("/qa/trending", async (_req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const { data: questions } = await supabase
      .from("posts")
      .select("id, caption, like_count, comment_count, created_at")
      .eq("status", "active")
      .eq("post_type", "question")
      .order("comment_count", { ascending: false })
      .order("like_count", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5);

    res.status(200).json({ trending: questions || [] });
  } catch (err) {
    res.status(200).json({ trending: [] });
  }
});

/**
 * GET /posts/qa/top-helpers
 * Leaderboard for most helpful pets calculated dynamically ONLY from Q&A posts and answers
 */
router.get("/qa/top-helpers", async (_req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // 1. Fetch all active Q&A question post IDs
    const { data: qaPosts } = await supabase
      .from("posts")
      .select("id, pet_id, accepted_answer_id, like_count")
      .eq("status", "active")
      .eq("post_type", "question");

    const qaPostIds = (qaPosts || []).map((p) => p.id);
    const acceptedAnswerIds = new Set((qaPosts || []).map((p) => p.accepted_answer_id).filter(Boolean));

    const petScores = new Map<string, number>();

    // Add points for Q&A question authors receiving treats/likes on their questions
    for (const p of qaPosts || []) {
      if (p.pet_id && (p.like_count || 0) > 0) {
        petScores.set(p.pet_id, (petScores.get(p.pet_id) || 0) + p.like_count);
      }
    }

    // 2. Fetch all comments on Q&A posts only
    if (qaPostIds.length > 0) {
      const { data: qaComments } = await supabase
        .from("comments")
        .select("id, pet_id, is_accepted_answer, like_count")
        .eq("status", "active")
        .in("post_id", qaPostIds);

      for (const c of qaComments || []) {
        if (!c.pet_id) continue;
        const isAccepted = c.is_accepted_answer || acceptedAnswerIds.has(c.id);
        // 1 point for answering a Q&A, 10 bonus points for accepted best answer, plus treats received
        const score = 1 + (isAccepted ? 10 : 0) + (c.like_count || 0);
        petScores.set(c.pet_id, (petScores.get(c.pet_id) || 0) + score);
      }
    }

    // 3. Sort pet IDs by score descending (only pets with score > 0 get ranked top)
    const sortedEntries = Array.from(petScores.entries())
      .filter(([_, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const sortedPetIds = sortedEntries.map(([id]) => id);

    let pets: any[] = [];
    if (sortedPetIds.length > 0) {
      const { data: petRows } = await supabase
        .from("pets")
        .select("id, name, username, profile_image_url")
        .in("id", sortedPetIds);

      const petMap = new Map((petRows || []).map((p) => [p.id, p]));
      pets = sortedEntries
        .map(([id, score], idx) => {
          const pet = petMap.get(id);
          if (!pet) return null;
          return {
            ...pet,
            rank: idx + 1,
            helpful_count: score,
          };
        })
        .filter(Boolean);
    }

    res.status(200).json({ helpers: pets });
  } catch (err) {
    console.error("[posts] top-helpers error:", err);
    res.status(200).json({ helpers: [] });
  }
});

/**
 * GET /posts/single/:id
 * Get single post details including question & accepted answer metadata
 */
router.get("/single/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = req.params.id;
    const activePetId = req.query.petId as string | undefined;
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { data: post, error } = await supabase
      .from("posts")
      .select(
        `
        id,
        caption,
        post_type,
        topic_category,
        is_solved,
        accepted_answer_id,
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
          profile_image_url,
          is_verified,
          is_founding_pet
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
      `
      )
      .eq("id", postId)
      .single();

    if (error || !post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    let hasLiked = false;
    if (activePetId) {
      const { data: like } = await supabase
        .from("likes")
        .select("id")
        .eq("post_id", postId)
        .eq("pet_id", activePetId)
        .single();
      hasLiked = Boolean(like);
    }

    let acceptedAnswer = null;
    if (post.accepted_answer_id) {
      const { data: comment } = await supabase
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
            profile_image_url,
            breed,
            is_verified,
            is_founding_pet
          )
        `
        )
        .eq("id", post.accepted_answer_id)
        .single();
      acceptedAnswer = comment;
    }

    const formattedPost = {
      ...post,
      pets: attachPetType(post.pets as any),
      hasLiked,
      accepted_answer: acceptedAnswer,
      media: post.post_media?.sort((a, b) => a.display_order - b.display_order) || [],
    };

    res.status(200).json({ post: formattedPost });
  } catch (err) {
    console.error("[posts] Single post error:", err);
    res.status(500).json({ error: "Failed to fetch post details" });
  }
});

/**
 * POST /posts/:id/accept-answer
 * Mark an answer comment as accepted best answer
 */
router.post("/:id/accept-answer", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const postId = req.params.id;
    const { commentId, petId } = req.body;

    if (!commentId || !petId) {
      res.status(400).json({ error: "commentId and petId are required" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // Verify user owns pet
    const { data: { user } } = await supabase.auth.getUser(accessToken);
    if (!user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { data: pet } = await supabase
      .from("pets")
      .select("id")
      .eq("id", petId)
      .eq("owner_id", user.id)
      .single();

    if (!pet) {
      res.status(403).json({ error: "Forbidden: You do not own this pet profile" });
      return;
    }

    // Check post ownership
    const { data: post } = await supabase
      .from("posts")
      .select("id, pet_id, accepted_answer_id")
      .eq("id", postId)
      .single();

    if (!post || post.pet_id !== petId) {
      res.status(403).json({ error: "Forbidden: Only the question author can accept a best answer" });
      return;
    }

    // Reset old accepted answer comments if any
    try {
      await (supabase.from("comments") as any)
        .update({ is_accepted_answer: false })
        .eq("post_id", postId);
    } catch {
      // Ignored if column optional
    }

    // Set accepted_answer_id only — is_solved is managed separately
    await (supabase.from("posts") as any)
      .update({
        accepted_answer_id: commentId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId);

    // Mark comment as accepted answer
    try {
      await (supabase.from("comments") as any)
        .update({ is_accepted_answer: true })
        .eq("id", commentId);
    } catch {
      // Ignored if column optional
    }

    // Trigger notification for answer author
    // Trigger notification for answer author
    try {
      const { data: acceptedComment } = await supabase
        .from("comments")
        .select("id, pet_id, content")
        .eq("id", commentId)
        .single();

      if (acceptedComment?.pet_id) {
        const { data: answerPet } = await supabase
          .from("pets")
          .select("name, owner_id")
          .eq("id", acceptedComment.pet_id)
          .single();

        const answerAuthorOwnerId = answerPet?.owner_id || user.id;
        const { data: questionAuthorPet } = await supabase.from("pets").select("name").eq("id", petId).single();

        await createNotificationHelper(supabase, {
          userId: answerAuthorOwnerId,
          recipientPetId: acceptedComment.pet_id,
          actorPetId: petId,
          type: "best_answer",
          title: "Best Answer Accepted ⭐",
          body: `${questionAuthorPet?.name || "Question author"} accepted your answer as the Best Answer!`,
          entityType: "post",
          entityId: String(postId),
          metadata: { commentId, excerpt: acceptedComment?.content },
        });
      }
    } catch (err) {
      console.error("[posts] Best answer notification error:", err);
    }

    res.status(200).json({ success: true, message: "Marked as accepted answer" });
  } catch (err) {
    console.error("[posts] Accept answer error:", err);
    res.status(500).json({ error: "Failed to accept answer" });
  }
});

/**
 * POST /posts/:id/unaccept-answer
 * Remove / unmark the best answer from a Q&A post
 */
router.post("/:id/unaccept-answer", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const postId = req.params.id;
    const { petId } = req.body;

    if (!petId) {
      res.status(400).json({ error: "petId is required" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    // Verify user owns pet
    const { data: { user } } = await supabase.auth.getUser(accessToken);
    if (!user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { data: pet } = await supabase
      .from("pets")
      .select("id")
      .eq("id", petId)
      .eq("owner_id", user.id)
      .single();

    if (!pet) {
      res.status(403).json({ error: "Forbidden: You do not own this pet profile" });
      return;
    }

    const { data: post } = await supabase
      .from("posts")
      .select("id, pet_id, accepted_answer_id")
      .eq("id", postId)
      .single();

    if (!post || post.pet_id !== petId) {
      res.status(403).json({ error: "Forbidden: Only the question author can remove the best answer" });
      return;
    }

    // Clear accepted_answer_id only — is_solved is managed separately
    await (supabase.from("posts") as any)
      .update({
        accepted_answer_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId);

    // Unmark comments as accepted answer
    try {
      await (supabase.from("comments") as any)
        .update({ is_accepted_answer: false })
        .eq("post_id", postId);
    } catch {
      // Ignored if column optional
    }

    res.status(200).json({ success: true, message: "Removed best answer" });
  } catch (err) {
    console.error("[posts] Unaccept answer error:", err);
    res.status(500).json({ error: "Failed to remove best answer" });
  }
});

/**
 * POST /posts/:id/mark-solved
 * Mark a Q&A question as solved (no best answer required)
 */
router.post("/:id/mark-solved", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const postId = req.params.id;
    const { petId } = req.body;

    if (!petId) {
      res.status(400).json({ error: "petId is required" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { data: { user } } = await supabase.auth.getUser(accessToken);
    if (!user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { data: pet } = await supabase
      .from("pets")
      .select("id")
      .eq("id", petId)
      .eq("owner_id", user.id)
      .single();

    if (!pet) {
      res.status(403).json({ error: "Forbidden: You do not own this pet profile" });
      return;
    }

    const { data: post } = await supabase
      .from("posts")
      .select("id, pet_id, post_type")
      .eq("id", postId)
      .single();

    if (!post || post.pet_id !== petId) {
      res.status(403).json({ error: "Forbidden: Only the question author can mark as solved" });
      return;
    }

    if (post.post_type !== "question") {
      res.status(400).json({ error: "Only question posts can be marked as solved" });
      return;
    }

    await (supabase.from("posts") as any)
      .update({
        is_solved: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId);

    res.status(200).json({ success: true, message: "Question marked as solved" });
  } catch (err) {
    console.error("[posts] Mark solved error:", err);
    res.status(500).json({ error: "Failed to mark question as solved" });
  }
});

/**
 * POST /posts/:id/mark-unsolved
 * Mark a Q&A question as unsolved (does not affect best answer)
 */
router.post("/:id/mark-unsolved", async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const postId = req.params.id;
    const { petId } = req.body;

    if (!petId) {
      res.status(400).json({ error: "petId is required" });
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { data: { user } } = await supabase.auth.getUser(accessToken);
    if (!user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { data: pet } = await supabase
      .from("pets")
      .select("id")
      .eq("id", petId)
      .eq("owner_id", user.id)
      .single();

    if (!pet) {
      res.status(403).json({ error: "Forbidden: You do not own this pet profile" });
      return;
    }

    const { data: post } = await supabase
      .from("posts")
      .select("id, pet_id, post_type")
      .eq("id", postId)
      .single();

    if (!post || post.pet_id !== petId) {
      res.status(403).json({ error: "Forbidden: Only the question author can mark as unsolved" });
      return;
    }

    if (post.post_type !== "question") {
      res.status(400).json({ error: "Only question posts can be marked as unsolved" });
      return;
    }

    await (supabase.from("posts") as any)
      .update({
        is_solved: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId);

    res.status(200).json({ success: true, message: "Question marked as unsolved" });
  } catch (err) {
    console.error("[posts] Mark unsolved error:", err);
    res.status(500).json({ error: "Failed to mark question as unsolved" });
  }
});

export default router;
