# Supabase Storage — `pet-profiles` bucket

The backend uploads pet avatars, post media, and community covers to **`pet-profiles`**. If the bucket is missing, logs show:

`[storage] Storage upload warning (using base64 fallback): Bucket not found`

The app still saves the image as **base64 in the database** (works but heavy and slow). Create the bucket to get normal HTTPS image URLs.

## Option A — SQL migration (recommended)

From `Furlo-Backend`:

```bash
npm run migrate
```

This applies `supabase/migrations/20260921_pet_profiles_storage.sql`.

Or paste that file into **Supabase Dashboard → SQL → New query → Run**.

## Option B — Dashboard

1. [Supabase](https://supabase.com/dashboard) → your project → **Storage**.
2. **New bucket**
   - Name: `pet-profiles`
   - **Public bucket**: on
3. (Optional) Limit file size ~5 MB and MIME types: JPEG, PNG, WebP, GIF.

Policies: the migration adds public **read** and **service_role** full access (backend uses `SUPABASE_SERVICE_KEY`).

## Option C — Script

```bash
cd Furlo-Backend
node scripts/ensure-storage-buckets.mjs
```

Requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `.env`.

## Verify

Upload a pet photo during onboarding. Backend logs should **not** show the bucket warning; `profile_image_url` should look like:

`https://<project-ref>.supabase.co/storage/v1/object/public/pet-profiles/...`
