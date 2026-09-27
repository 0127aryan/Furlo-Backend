# Supabase auth setup (OTP email + Google)

Dashboard checklist for Furlo. Secrets stay in Supabase; Furlo backend only uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_KEY`.

## API keys

**Project Settings → API**

| Env var | Supabase field |
|---------|----------------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon public |
| `SUPABASE_SERVICE_KEY` | service_role (never expose to clients) |
| `SUPABASE_JWT_SECRET` | JWT Secret (API settings) — required for per-user rate limits |

## Custom SMTP (Hostinger)

**Authentication → Emails → SMTP**

| Field | Furlo dev |
|-------|-----------|
| Custom SMTP | ON |
| Sender | `info@furlopets.in` |
| Sender name | `Furlo \| Where Pets Belong` |
| Host | `smtp.hostinger.com` |
| Port | 587 |

Username should be the full mailbox. Ensure SPF/DKIM on `furlopets.in` for deliverability.

## Email OTP (signup verification)

Furlo sends verification codes via **`signInWithOtp` only** (no `signUp()` / no Confirm sign up email).

1. **Providers → Email** — Confirm email **ON** (users stay unverified until OTP).
2. **Authentication → Email Templates → Magic link or OTP** — OTP-only body:
   - Include **`{{ .Token }}`** (6-digit code).
   - **Remove `{{ .ConfirmationURL }}`** — if that variable is present, Supabase sends a link instead of a code.

Example Magic Link template:

```html
<h2>Your Furlo verification code</h2>
<p>Enter this code in the app:</p>
<p style="font-size: 24px; letter-spacing: 4px;"><strong>{{ .Token }}</strong></p>
<p>This code expires soon. If you didn't request this, ignore this email.</p>
```

Optional: update **Confirm signup** the same way for legacy flows; Furlo signup no longer uses `auth.signUp()` confirmation emails.

## URL configuration

**Authentication → URL Configuration**

| Setting | Furlo dev |
|---------|-----------|
| Site URL | `https://dev.furlopets.in` |
| Redirect URLs | `https://dev.furlopets.in/auth/callback` |
| | `http://localhost:3000/auth/callback` |
| | `furlo://auth/callback` |

Backend: `FRONTEND_URL=https://dev.furlopets.in` (no trailing slash) on the server using this project.

## Google OAuth

1. **Google Cloud** — OAuth consent screen: **External**. Credentials → **OAuth client ID** → **Web application** (one client for web + mobile via Supabase).
2. **Authorized redirect URI** (Google only):

   `https://fhexwzurursdfeahvloq.supabase.co/auth/v1/callback`

   Replace `fhexwzurursdfeahvloq` with your project ref if different.

3. **Supabase → Providers → Google** — Enable; paste Client ID + Secret. Do **not** add Furlo URLs to Google redirect URIs.

4. While app is in **Testing**, add test users on the Google consent screen.

Do **not** create Android/iOS OAuth clients for the Supabase browser flow.

### Mobile Google sign-in

Mobile Google sign-in uses a **deep link** so the in-app browser closes and control returns to the app (HTTPS `dev.furlopets.in/auth/callback` loads the **web** app and stays in the browser):

| Variable | Example |
|----------|---------|
| Supabase Redirect URL | `furlo://auth/callback` |
| Backend default (mobile) | `MOBILE_OAUTH_REDIRECT_URL=furlo://auth/callback` |
| Mobile override | `EXPO_PUBLIC_OAUTH_REDIRECT_URL=furlo://auth/callback` (omit to use app scheme from `app.json`) |

Optional HTTPS bridge (legacy): `https://dev.furlopets.in/auth/callback?client=mobile` — web callback redirects to `furlo://` with the code.

Flow: app opens OAuth in `WebBrowser` → Supabase redirects to `furlo://auth/callback?code=` → session closes → app calls `POST /auth/oauth/exchange` with `code` + `state` (PKCE verifier cached on backend for 15 minutes).

### Google consent screen shows `*.supabase.co`

Google shows **Sign in to &lt;project-ref&gt;.supabase.co** because Supabase’s servers complete the OAuth exchange (Furlo uses Supabase-only Google auth). You cannot change that line with Furlo app code alone.

**Improve branding (free, do this first)** — [Google Cloud → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent):

| Field | Suggested value |
|-------|-----------------|
| App name | `Furlo` or `Furlo Pets` |
| User support email | `support@furlopets.in` |
| App logo | Furlo icon (120×120) |
| Application home page | `https://dev.furlopets.in` (prod URL when live) |
| Privacy policy / Terms | Your `/privacy` and `/terms` URLs |
| Authorized domains | `furlopets.in`, `supabase.co` |

That updates the app name and logo in the permission list. The large **Sign in to …** host often stays `*.supabase.co` until you use a custom auth domain.

**Show your domain instead of `*.supabase.co` (Supabase custom domain)** — [Supabase custom domains](https://supabase.com/docs/guides/platform/custom-domains):

1. Add something like `auth.furlopets.in` (CNAME in Hostinger → Supabase).
2. Activate the auth custom domain on the Supabase project.
3. In **Google Cloud**, change the OAuth redirect URI to  
   `https://auth.furlopets.in/auth/v1/callback`  
   (exact URL from Supabase after setup).
4. Re-save Google Client ID/Secret in Supabase if needed.

Then Google typically shows **Sign in to auth.furlopets.in** (or your chosen subdomain).

**Not available with Supabase-only OAuth:** pointing Google OAuth redirect directly at `dev.furlopets.in` only — Google must redirect to Supabase’s `/auth/v1/callback` (default or custom auth domain).

## Verification checklist

| # | Check | Pass |
|---|--------|------|
| 1 | Signup email arrives | Auth Logs + inbox |
| 2 | Email shows 6-digit code | Template uses `{{ .Token }}` |
| 3 | OTP verify in app | Session / cookies set |
| 4 | Google web | Redirect to feed or onboarding |
| 5 | Google mobile | `furlo://auth/callback` + tokens stored |
| 6 | `public.users` row | New auth user mirrored |

## Troubleshooting

- **redirect_uri_mismatch** — Google redirect URI must match Supabase callback exactly.
- **Redirect after Google fails** — Furlo URL must be in Supabase Redirect URLs, not Google.
- **No email** — SMTP credentials, spam folder, 60s resend cooldown.
- **Invalid OTP** — Code expired; use Resend code.
