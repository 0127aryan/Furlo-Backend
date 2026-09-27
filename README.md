# Furlo Backend

Express API for the Furlo pet community platform. Talks to PostgreSQL via Supabase.

## Stack

- **Runtime**: Node.js + Express + TypeScript
- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth (JWT + Google OAuth)
- **Storage**: Supabase Storage
- **Push**: Firebase Cloud Messaging (optional)
- **Email**: Custom SMTP via Supabase (e.g. Hostinger) — see [docs/supabase-auth-setup.md](docs/supabase-auth-setup.md)

Default port: **4000** (`http://localhost:4000`)

## Commands

```bash
npm install          # install dependencies
npm run dev          # hot-reload server (tsx watch index.ts)
npm run migrate      # apply supabase/migrations/*.sql in order
npm run build        # tsc → dist/
npm start            # run compiled server (node dist/index.js)
```

### Extra scripts

```bash
npx tsx test-db.ts                           # Supabase connectivity check
node scripts/diagnose-notifications.mjs      # inspect / test notification rows
node scripts/test-push.mjs                   # send a test FCM push
node scripts/apply-notifications-fix.mjs     # apply notifications Phase 9 SQL fix
```

Health check: `GET http://localhost:4000/health`

## Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Copy **Project URL**, **anon key**, and **service_role key** from Settings → API
3. Copy the database URL from Settings → Database (for migrations)

### 2. Environment

```bash
cp .env.example .env
```

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
SUPABASE_ANON_KEY=your_supabase_anon_key
PORT=4000
FRONTEND_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT.supabase.co:5432/postgres
```

`FRONTEND_URL` is required at startup. Use the **service_role** key for `SUPABASE_SERVICE_KEY` (never the anon key).

**Auth (OTP email + Google):** Configure Supabase dashboard per [docs/supabase-auth-setup.md](docs/supabase-auth-setup.md).

**Storage (avatars / posts):** Create the `pet-profiles` bucket per [docs/supabase-storage-setup.md](docs/supabase-storage-setup.md).

Optional push: `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_JSON`.

### 3. Run migrations

```bash
npm run migrate
```

Or run each file in `supabase/migrations/` in the Supabase SQL Editor, in filename order:

| Migration | Description |
|---|---|
| `20260607_create_schema.sql` | Core schema (users, pets, posts, communities) |
| `20260725_custom_breeds.sql` | Custom breeds |
| `20260726_personality_tags_approval.sql` | Personality tag approval |
| `20260726_species_verbs.sql` | Species-specific verbs |
| `20260823_wags.sql` | Wags |
| `20260824_community_pack_fields.sql` | Community / pack fields |
| `20260825_community_approval_fields.sql` | Community approval |
| `20260913_qa_hub_fields.sql` | Q&A hub |
| `20260913_notifications.sql` | Notifications |
| `20260914_notifications_phase9_fix.sql` | Notifications Phase 9 fix |
| `20260914_push_tokens_and_quiet_hours.sql` | Push tokens + quiet hours |
| `20260915_admin_dashboard.sql` | Admin dashboard |
| `20260921_pet_profiles_storage.sql` | Storage bucket `pet-profiles` + policies |

### 4. Start the server

```bash
npm run dev
```

## Web / mobile env

Web (`Furlo-Frontend/.env.local`):

```env
BACKEND_API_URL=http://localhost:4000
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

Mobile (optional override):

```env
EXPO_PUBLIC_API_URL=http://YOUR_LAN_IP:4000
```
