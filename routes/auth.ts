import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const router = Router()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[auth] SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from environment variables')
}

// Helper to manually parse cookies from headers
const getCookie = (req: Request, name: string): string | undefined => {
  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return undefined
  const cookies = cookieHeader.split(';')
  for (const cookie of cookies) {
    const [key, val] = cookie.trim().split('=')
    if (key === name) {
      return decodeURIComponent(val)
    }
  }
  return undefined
}

// Cookie setting options helper
const getCookieOptions = (maxAgeMs: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: maxAgeMs,
})

const COOKIE_SESSION_MAX_AGE = 60 * 60 * 1000 // 1 hour (matching typical access token expiry)
const COOKIE_REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000 // 30 days

// Zod schemas for input validation
const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string(),
})

/**
 * Helper to fetch public user details and active pet profile
 */
async function fetchUserContext(supabase: any, userId: string) {
  // Fetch public user record
  const { data: userRecord, error: userError } = await supabase
    .from('users')
    .select('id, email, is_admin, status')
    .eq('id', userId)
    .single()

  if (userError || !userRecord) {
    console.error('[auth] Error fetching public user record:', userError?.message)
    return null
  }

  // Fetch active pet profile (primary actor)
  const { data: activePet, error: petError } = await supabase
    .from('pets')
    .select('id, owner_id, username, name, profile_image_url, breed, city, personality_tags')
    .eq('owner_id', userId)
    .eq('status', 'active')
    .limit(1)

  return {
    user: userRecord,
    activePet: activePet && activePet.length > 0 ? activePet[0] : null,
  }
}

/**
 * POST /auth/signup
 * Register a user via Supabase Auth
 */
router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = signupSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message })
      return
    }

    const { email, password } = parsed.data
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    })

    if (error) {
      res.status(error.status ?? 400).json({ error: error.message })
      return
    }

    res.status(201).json({
      message: 'Signup successful! Please check your email for the confirmation link.',
      user: data.user,
    })
  } catch (err) {
    console.error('[auth] Signup error:', err)
    res.status(500).json({ error: 'Internal server error during signup.' })
  }
})

/**
 * POST /auth/login
 * Log in via Supabase Auth and issue HTTP-only cookies
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message })
      return
    }

    const { email, password } = parsed.data
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error || !data.session) {
      res.status(error?.status ?? 401).json({ error: error?.message ?? 'Authentication failed' })
      return
    }

    const { access_token, refresh_token, user } = data.session

    // Set secure HttpOnly cookies
    res.cookie('furlo_session', access_token, getCookieOptions(COOKIE_SESSION_MAX_AGE))
    res.cookie('furlo_refresh', refresh_token, getCookieOptions(COOKIE_REFRESH_MAX_AGE))

    // Retrieve public user row and active pet context
    const context = await fetchUserContext(supabase, user.id)

    if (!context) {
      res.status(500).json({ error: 'Failed to retrieve user context profile.' })
      return
    }

    res.status(200).json(context)
  } catch (err) {
    console.error('[auth] Login error:', err)
    res.status(500).json({ error: 'Internal server error during login.' })
  }
})

/**
 * POST /auth/logout
 * Sign out from Supabase Auth and clear HTTP-only cookies
 */
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getCookie(req, 'furlo_session')
    
    // Clear cookies regardless of Supabase logout outcome
    res.clearCookie('furlo_session', { path: '/' })
    res.clearCookie('furlo_refresh', { path: '/' })

    if (accessToken) {
      const supabase = createClient(supabaseUrl!, supabaseServiceKey!, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        }
      })
      
      // Sign out user using the user's specific access token to invalidate it
      await supabase.auth.admin.signOut(accessToken)
    }

    res.status(200).json({ message: 'Logged out successfully.' })
  } catch (err) {
    console.error('[auth] Logout error:', err)
    res.status(500).json({ error: 'Internal server error during logout.' })
  }
})

/**
 * GET /auth/me
 * Check auth session and fetch profile/pet details (with automatic refresh)
 */
router.get('/me', async (req: Request, res: Response): Promise<void> => {
  try {
    let accessToken = getCookie(req, 'furlo_session')
    const refreshToken = getCookie(req, 'furlo_refresh')
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)

    // 1. If access token is present, attempt to authenticate
    if (accessToken) {
      const { data: { user }, error } = await supabase.auth.getUser(accessToken)

      if (!error && user) {
        const context = await fetchUserContext(supabase, user.id)
        if (context) {
          res.status(200).json(context)
          return
        }
      }
    }

    // 2. If access token is expired/invalid but refresh token is present, refresh the session
    if (refreshToken) {
      console.log('[auth] Access token expired or missing. Attempting refresh...')
      const { data, error: refreshError } = await supabase.auth.refreshSession({
        refresh_token: refreshToken,
      })

      if (!refreshError && data.session) {
        const { access_token: newAccessToken, refresh_token: newRefreshToken, user } = data.session

        // Issue fresh cookies
        res.cookie('furlo_session', newAccessToken, getCookieOptions(COOKIE_SESSION_MAX_AGE))
        res.cookie('furlo_refresh', newRefreshToken, getCookieOptions(COOKIE_REFRESH_MAX_AGE))

        const context = await fetchUserContext(supabase, user.id)
        if (context) {
          res.status(200).json(context)
          return
        }
      }
      
      console.warn('[auth] Refresh token invalid or expired:', refreshError?.message)
    }

    // 3. Unauthenticated — clear any lingering cookies
    res.clearCookie('furlo_session', { path: '/' })
    res.clearCookie('furlo_refresh', { path: '/' })
    res.status(401).json({ error: 'Unauthorized. Please log in.' })
  } catch (err) {
    console.error('[auth] Session me error:', err)
    res.status(500).json({ error: 'Internal server error validating session.' })
  }
})

/**
 * GET /auth/callback
 * OAuth callback handler (backend exchange)
 */
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const code = req.query.code as string

    if (!code) {
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=no_code`)
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error || !data.session) {
      console.error('[auth] OAuth code exchange error:', error?.message)
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=exchange_failed`)
      return
    }

    const { access_token, refresh_token, user } = data.session

    // Set cookies
    res.cookie('furlo_session', access_token, getCookieOptions(COOKIE_SESSION_MAX_AGE))
    res.cookie('furlo_refresh', refresh_token, getCookieOptions(COOKIE_REFRESH_MAX_AGE))

    // Query context to check if they have a pet profile (onboarded)
    const context = await fetchUserContext(supabase, user.id)

    // Redirect user: if no active pet profile exists, redirect to onboarding step 1, otherwise to feed
    if (context && context.activePet) {
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/feed`)
    } else {
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/onboarding`)
    }
  } catch (err) {
    console.error('[auth] OAuth callback error:', err)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=server_error`)
  }
})

const onboardingSetupSchema = z.object({
  petName: z.string().min(1, 'Name is required'),
  petUsername: z.string().min(3, 'Username must be at least 3 characters'),
  breed: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  bio: z.string().max(300).optional(),
  personalityTags: z.array(z.string()).optional(),
})

/**
 * POST /auth/complete-onboarding
 * Create pet/user profile in DB once verified and logged in
 */
router.post('/complete-onboarding', async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getCookie(req, 'furlo_session')
    if (!accessToken) {
      res.status(401).json({ error: 'Unauthorized. Please login first.' })
      return
    }

    const parsed = onboardingSetupSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken)

    if (authError || !user) {
      res.status(401).json({ error: 'Unauthorized. Invalid session.' })
      return
    }

    const { petName, petUsername, breed, city, gender, bio, personalityTags } = parsed.data

    // Check if username is already taken
    const { data: existingPet } = await supabase
      .from('pets')
      .select('id')
      .eq('username', petUsername)
      .limit(1)

    if (existingPet && existingPet.length > 0) {
      res.status(409).json({ error: 'Username is already taken by another pack member.' })
      return
    }

    // Default placeholder images
    const defaultProfileImage = 'https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&q=80&w=250'

    // Insert pet record
    const { data: petRecord, error: insertError } = await supabase
      .from('pets')
      .insert({
        owner_id: user.id,
        name: petName,
        username: petUsername,
        breed: breed || 'Human',
        city: city || 'Bangalore',
        gender: gender || 'unknown',
        bio: bio || '',
        personality_tags: personalityTags || [],
        profile_image_url: defaultProfileImage,
        vaccination_status: 'unknown',
        is_public: true,
      })
      .select()
      .single()

    if (insertError) {
      console.error('[auth] Error inserting pet profile:', insertError.message)
      res.status(500).json({ error: 'Failed to save pet profile. Please try again.' })
      return
    }

    res.status(200).json({
      message: 'Profile setup completed successfully!',
      pet: petRecord,
    })
  } catch (err) {
    console.error('[auth] Complete onboarding error:', err)
    res.status(500).json({ error: 'Internal server error during onboarding setup.' })
  }
})

export default router
