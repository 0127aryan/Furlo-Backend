# Furlo Backend

Supabase-powered backend for the Furlo pet community platform.

## Stack

- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth (JWT + Google OAuth)
- **Storage**: Supabase Storage
- **Email**: Resend

## Structure

```
supabase/
  migrations/     # SQL migration files — run these in Supabase SQL editor in order
```

## Setup

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Note your **Project URL** and **anon key** from Settings → API

### 2. Run Migrations

Run each `.sql` file in `supabase/migrations/` in order via the **Supabase SQL Editor**.

| Migration | Description |
|---|---|
| `20260605_create_waitlist.sql` | Waitlist table with RLS |

### 3. Configure Frontend

Copy your Supabase credentials into `Furlo-Frontend/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

## Viewing Waitlist Signups

In the Supabase dashboard → **Table Editor** → `waitlist` table.

You can also use the **Resend** integration to trigger emails to waitlisted users once launched.