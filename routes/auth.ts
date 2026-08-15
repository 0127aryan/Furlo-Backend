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

const COOKIE_SESSION_MAX_AGE = process.env.COOKIE_SESSION_MAX_AGE_MS
  ? parseInt(process.env.COOKIE_SESSION_MAX_AGE_MS, 10)
  : 60 * 60 * 1000

const COOKIE_REFRESH_MAX_AGE = process.env.COOKIE_REFRESH_MAX_AGE_MS
  ? parseInt(process.env.COOKIE_REFRESH_MAX_AGE_MS, 10)
  : 30 * 24 * 60 * 60 * 1000

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
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${frontendUrl}/auth/callback`,
      },
    })

    if (error) {
      res.status(error.status ?? 400).json({ error: error.message })
      return
    }

    if (data.session) {
      const cookieOptsSession = getCookieOptions(COOKIE_SESSION_MAX_AGE)
      const cookieOptsRefresh = getCookieOptions(COOKIE_REFRESH_MAX_AGE)

      res.setHeader('Set-Cookie', [
        `furlo_session=${encodeURIComponent(data.session.access_token)}; ${Object.entries(cookieOptsSession).map(([k, v]) => `${k}=${v}`).join('; ')}`,
        `furlo_refresh=${encodeURIComponent(data.session.refresh_token)}; ${Object.entries(cookieOptsRefresh).map(([k, v]) => `${k}=${v}`).join('; ')}`,
      ])
    }

    const requiresVerification = !data.session || (data.user && !data.user.email_confirmed_at)

    res.status(201).json({
      message: requiresVerification
        ? 'Signup successful! Please check your email to confirm your account.'
        : 'Signup successful!',
      user: data.user,
      session: data.session,
      requiresVerification,
    })
  } catch (err) {
    console.error('[auth] Signup error:', err)
    res.status(500).json({ error: 'Internal server error during signup.' })
  }
})

/**
 * POST /auth/resend-confirmation
 * Resend email confirmation link
 */
router.post('/resend-confirmation', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body
    if (!email) {
      res.status(400).json({ error: 'Email address is required.' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${frontendUrl}/auth/callback`,
      },
    })

    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    res.status(200).json({ message: 'Verification email resent successfully.' })
  } catch (err) {
    console.error('[auth] Resend confirmation error:', err)
    res.status(500).json({ error: 'Failed to resend verification email.' })
  }
})

/**
 * GET /auth/check-verification
 * Check if a user with given email has verified their email address
 */
router.get('/check-verification', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.query.email as string
    if (!email) {
      res.status(400).json({ error: 'Email is required' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data: { users }, error } = await supabase.auth.admin.listUsers()

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    const user = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (!user) {
      res.status(200).json({ verified: false, exists: false })
      return
    }

    const verified = Boolean(user.email_confirmed_at)

    if (verified) {
      // Auto-establish session cookies for Tab A via admin magiclink token exchange
      try {
        const { data: linkData } = await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: user.email!,
        })
        if (linkData?.properties?.hashed_token) {
          const { data: otpRes } = await supabase.auth.verifyOtp({
            token_hash: linkData.properties.hashed_token,
            type: 'magiclink',
          })
          if (otpRes?.session) {
            res.cookie('furlo_session', otpRes.session.access_token, getCookieOptions(COOKIE_SESSION_MAX_AGE))
            res.cookie('furlo_refresh', otpRes.session.refresh_token, getCookieOptions(COOKIE_REFRESH_MAX_AGE))
          }
        }
      } catch (genErr) {
        console.warn('[auth] Warning auto-establishing session on check-verification:', genErr)
      }
    }

    res.status(200).json({ verified, exists: true })
  } catch (err) {
    console.error('[auth] Check verification error:', err)
    res.status(500).json({ error: 'Failed to check email verification status.' })
  }
})

/**
 * POST /auth/verify-session
 * Establish cookies from access & refresh tokens passed from frontend callback
 */
router.post('/verify-session', async (req: Request, res: Response): Promise<void> => {
  try {
    const { access_token, refresh_token } = req.body
    if (!access_token) {
      res.status(400).json({ error: 'Access token is required' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data: { user }, error } = await supabase.auth.getUser(access_token)

    if (error || !user) {
      res.status(401).json({ error: 'Invalid access token' })
      return
    }

    // Set secure HttpOnly cookies
    res.cookie('furlo_session', access_token, getCookieOptions(COOKIE_SESSION_MAX_AGE))
    if (refresh_token) {
      res.cookie('furlo_refresh', refresh_token, getCookieOptions(COOKIE_REFRESH_MAX_AGE))
    }

    const context = await fetchUserContext(supabase, user.id)

    res.status(200).json({
      message: 'Session verified',
      user,
      context,
    })
  } catch (err) {
    console.error('[auth] Verify session error:', err)
    res.status(500).json({ error: 'Internal server error verifying session.' })
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
 * Email verification & OAuth callback handler
 */
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const code = req.query.code as string
    const token_hash = req.query.token_hash as string
    const type = req.query.type as string
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    let sessionData: any = null

    if (token_hash && type) {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash,
        type: type as any,
      })
      if (!error && data.session) {
        sessionData = data.session
      }
    } else if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      if (!error && data.session) {
        sessionData = data.session
      }
    }

    if (!sessionData) {
      console.error('[auth] Auth callback failed to exchange session.')
      res.redirect(`${frontendUrl}/join?error=verification_failed`)
      return
    }

    const { access_token, refresh_token, user } = sessionData

    // Set secure cookies
    res.cookie('furlo_session', access_token, getCookieOptions(COOKIE_SESSION_MAX_AGE))
    res.cookie('furlo_refresh', refresh_token, getCookieOptions(COOKIE_REFRESH_MAX_AGE))

    // Query context to check if they have a pet profile (onboarded)
    const context = await fetchUserContext(supabase, user.id)

    // If user has an active pet profile already, send to feed. Otherwise send to profile creation section (/join/select).
    if (context && context.activePet) {
      res.redirect(`${frontendUrl}/feed`)
    } else {
      res.redirect(`${frontendUrl}/join/select`)
    }
  } catch (err) {
    console.error('[auth] Auth callback error:', err)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/join?error=server_error`)
  }
})

/**
 * GET /auth/check-username
 * Checks if a pet username is available
 */
router.get('/check-username', async (req: Request, res: Response): Promise<void> => {
  try {
    const username = req.query.username as string
    if (!username || username.length < 3 || username.length > 30) {
      res.status(400).json({ error: 'Username must be between 3 and 30 characters.' })
      return
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      res.status(400).json({ error: 'Username can only contain alphanumeric characters and underscores.' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data: existingPet, error } = await supabase
      .from('pets')
      .select('id')
      .eq('username', username)
      .limit(1)

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    const available = !existingPet || existingPet.length === 0
    res.status(200).json({ available })
  } catch (err) {
    console.error('[auth] Check username error:', err)
    res.status(500).json({ error: 'Internal server error checking username.' })
  }
})

const onboardingSetupSchema = z.object({
  role: z.enum(['parent', 'lover']).optional(),
  petName: z.string().min(1, 'Name is required'),
  petUsername: z.string().optional(),
  petType: z.string().optional(),
  customPetType: z.string().optional(),
  breed: z.string().optional(),
  customBreed: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  bio: z.string().max(300).optional(),
  personalityTags: z.array(z.string()).optional(),
  customPersonalityTags: z.array(z.string()).optional(),
  avatarData: z.string().optional(),
  packs: z.array(z.string()).optional(),
})

/**
 * GET /auth/species-verbs
 * Returns all active species verb mappings from database
 */
router.get('/species-verbs', async (_req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase
      .from('species_verbs')
      .select('id, species, label, verb, icon, is_active')
      .eq('is_active', true)
      .order('species', { ascending: true })

    if (error) {
      // Fallback if table not created yet
      res.status(200).json([])
      return
    }

    res.status(200).json(data || [])
  } catch (err) {
    console.error('[auth] Error fetching species verbs:', err)
    res.status(200).json([])
  }
})

/**
 * GET /auth/communities
 * Lists all active communities
 */
router.get('/communities', async (req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, description, cover_image_url, member_count')
      .eq('is_active', true)

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json(data)
  } catch (err) {
    console.error('[auth] Get communities error:', err)
    res.status(500).json({ error: 'Internal server error fetching communities.' })
  }
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

    // 1. Ensure user row exists in public.users table (mirroring auth.users)
    try {
      await supabase.from('users').upsert({
        id: user.id,
        email: user.email!,
        auth_provider: 'email',
        is_email_verified: Boolean(user.email_confirmed_at),
      }, { onConflict: 'id' })
    } catch (uErr) {
      console.warn('[auth] Warning upserting user record:', uErr)
    }

    const { role, petName, petUsername: rawUsername, petType, customPetType, breed, customBreed, city, gender, bio, personalityTags, customPersonalityTags, avatarData, packs } = parsed.data

    // If username is provided, sanitize & check availability. Otherwise autogenerate a clean unique handle.
    let petUsername = rawUsername ? rawUsername.toLowerCase().replace(/[^a-z0-9_]/g, '') : ''
    if (!petUsername || petUsername.length < 3) {
      const cleanName = petName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'pet'
      petUsername = `${cleanName}_${Math.floor(1000 + Math.random() * 9000)}`
    } else {
      const { data: existingPet } = await supabase
        .from('pets')
        .select('id')
        .eq('username', petUsername)
        .limit(1)

      if (existingPet && existingPet.length > 0) {
        petUsername = `${petUsername}_${Math.floor(100 + Math.random() * 900)}`
      }
    }

    // Set profileImageUrl strictly from user avatarData uploaded during signup
    let profileImageUrl = avatarData || ''

    // Handle base64 avatar upload to Supabase storage if provided
    if (avatarData && avatarData.startsWith('data:image/')) {
      try {
        const matches = avatarData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
        if (matches && matches.length === 3) {
          const mimeType = matches[1]
          const buffer = Buffer.from(matches[2], 'base64')
          const extension = mimeType.split('/')[1] || 'jpeg'
          const fileName = `${petUsername}_${Date.now()}.${extension}`

          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('pet-profiles')
            .upload(fileName, buffer, {
              contentType: mimeType,
              upsert: true,
            })

          if (uploadError) {
            console.warn('[storage] Storage upload warning (using base64 fallback):', uploadError.message)
            profileImageUrl = avatarData
          } else {
            const { data: { publicUrl } } = supabase.storage
              .from('pet-profiles')
              .getPublicUrl(fileName)
            profileImageUrl = publicUrl
          }
        }
      } catch (uploadErr) {
        console.warn('[storage] Exception during avatar upload, fallback to avatarData:', uploadErr)
        profileImageUrl = avatarData
      }
    } else if (avatarData && (avatarData.startsWith('http://') || avatarData.startsWith('https://'))) {
      profileImageUrl = avatarData
    }

    // Construct pet payload
    const petInsertPayload: any = {
      owner_id: user.id,
      name: petName,
      username: petUsername,
      breed: breed || (role === 'lover' ? 'Pet Lover' : 'Unknown'),
      city: city || 'Bangalore',
      gender: gender || 'unknown',
      bio: bio || '',
      personality_tags: personalityTags || [],
      profile_image_url: profileImageUrl,
      vaccination_status: 'unknown',
      is_public: true,
    }

    // Check if pet profile already exists for this owner in database
    const { data: existingPet } = await supabase
      .from('pets')
      .select('id')
      .eq('owner_id', user.id)
      .limit(1)

    let petRecord: any = null
    let insertError: any = null

    if (existingPet && existingPet.length > 0) {
      // Update existing pet profile row in DB
      console.log(`[auth] Updating existing pet profile (${existingPet[0].id}) in DB...`)
      const updateResult = await supabase
        .from('pets')
        .update({
          name: petName,
          username: petUsername,
          breed: breed || (role === 'lover' ? 'Pet Lover' : 'Unknown'),
          city: city || 'Bangalore',
          gender: gender || 'unknown',
          bio: bio || '',
          personality_tags: personalityTags || [],
          profile_image_url: profileImageUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingPet[0].id)
        .select()
        .single()

      petRecord = updateResult.data
      insertError = updateResult.error
    } else {
      // Insert new pet profile into DB
      let insertResult = await supabase
        .from('pets')
        .insert({
          ...petInsertPayload,
          pet_type: petType || (role === 'lover' ? 'lover' : 'dogs'),
        })
        .select()
        .single()

      if (insertResult.error && (insertResult.error.message.includes('pet_type') || insertResult.error.code === 'PGRST204')) {
        console.log('[auth] Retrying pet insert without pet_type column...')
        insertResult = await supabase
          .from('pets')
          .insert(petInsertPayload)
          .select()
          .single()
      }

      petRecord = insertResult.data
      insertError = insertResult.error
    }

    if (insertError) {
      console.error('[auth] Error inserting pet profile to DB:', insertError.message)
      res.status(500).json({ error: `Failed to save profile: ${insertError.message}` })
      return
    }

    // Record custom breed/pet_type/personality_tags for admin catalog approval notification
    if (customBreed || customPetType || (customPersonalityTags && customPersonalityTags.length > 0)) {
      try {
        const approvalsToInsert: any[] = []
        if (customBreed) {
          approvalsToInsert.push({
            pet_id: petRecord.id,
            submission_type: 'breed',
            pet_type: petType || 'dogs',
            name: customBreed,
            status: 'pending',
          })
        }
        if (customPetType) {
          approvalsToInsert.push({
            pet_id: petRecord.id,
            submission_type: 'pet_type',
            pet_type: customPetType,
            name: customPetType,
            status: 'pending',
          })
        }
        if (customPersonalityTags && customPersonalityTags.length > 0) {
          customPersonalityTags.forEach((tag) => {
            approvalsToInsert.push({
              pet_id: petRecord.id,
              submission_type: 'personality_tag',
              pet_type: petType || 'dogs',
              name: tag,
              status: 'pending',
            })
          })
        }
        await supabase.from('pending_breed_approvals').insert(approvalsToInsert)
      } catch (approvalErr) {
        console.error('[auth] Exception logging pending breed/tag approval:', approvalErr)
      }
    }

    // Join communities if selected
    if (packs && packs.length > 0) {
      try {
        const { data: dbCommunities, error: commError } = await supabase
          .from('communities')
          .select('id, slug')
          .in('slug', packs)

        if (!commError && dbCommunities && dbCommunities.length > 0) {
          const memberRows = dbCommunities.map((c) => ({
            community_id: c.id,
            pet_id: petRecord.id,
          }))

          const { error: joinError } = await supabase
            .from('community_members')
            .insert(memberRows)

          if (joinError) {
            console.error('[auth] Error joining communities:', joinError.message)
          }
        }
      } catch (joinErr) {
        console.error('[auth] Exception while joining communities:', joinErr)
      }
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

/**
 * PUT /auth/update-pet-profile
 * Updates active pet profile photo & details in database
 */
router.put('/update-pet-profile', async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = getCookie(req, 'furlo_session')
    if (!accessToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken)

    if (authError || !user) {
      res.status(401).json({ error: 'Invalid session' })
      return
    }

    const { name, breed, city, bio, avatarData } = req.body

    let profileImageUrl: string | undefined = undefined

    if (avatarData && avatarData.startsWith('data:image/')) {
      try {
        const matches = avatarData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
        if (matches && matches.length === 3) {
          const mimeType = matches[1]
          const buffer = Buffer.from(matches[2], 'base64')
          const extension = mimeType.split('/')[1] || 'jpeg'
          const fileName = `pet_${user.id}_${Date.now()}.${extension}`

          const { error: uploadError } = await supabase.storage
            .from('pet-profiles')
            .upload(fileName, buffer, { contentType: mimeType, upsert: true })

          if (!uploadError) {
            const { data: { publicUrl } } = supabase.storage
              .from('pet-profiles')
              .getPublicUrl(fileName)
            profileImageUrl = publicUrl
          } else {
            profileImageUrl = avatarData
          }
        }
      } catch (e) {
        profileImageUrl = avatarData
      }
    } else if (avatarData !== undefined) {
      profileImageUrl = avatarData
    }

    const updatePayload: any = {
      ...(name && { name }),
      ...(breed && { breed }),
      ...(city && { city }),
      ...(bio !== undefined && { bio }),
      ...(profileImageUrl !== undefined && { profile_image_url: profileImageUrl }),
      updated_at: new Date().toISOString(),
    }

    const { data: updatedPet, error } = await supabase
      .from('pets')
      .update(updatePayload)
      .eq('owner_id', user.id)
      .select()
      .single()

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json({ pet: updatedPet })
  } catch (err) {
    console.error('[auth] Update pet profile error:', err)
    res.status(500).json({ error: 'Failed to update pet profile' })
  }
})

export default router
