import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key);
const bucketId = "pet-profiles";

const { data: existing, error: listError } = await supabase.storage.listBuckets();
if (listError) {
  console.error("listBuckets failed:", listError.message);
  process.exit(1);
}

if (existing?.some((b) => b.id === bucketId)) {
  console.log(`Bucket "${bucketId}" already exists.`);
  process.exit(0);
}

const { error: createError } = await supabase.storage.createBucket(bucketId, {
  public: true,
  fileSizeLimit: 5 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
});

if (createError) {
  console.error("createBucket failed:", createError.message);
  process.exit(1);
}

console.log(`Created public bucket "${bucketId}". Run the storage migration for RLS policies if needed.`);
