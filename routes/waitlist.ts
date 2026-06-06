import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const router = Router()

const waitlistSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  city: z.string().min(2, 'City is required').max(100),
  email: z.string().email('Please enter a valid email address'),
  is_pet_parent: z.boolean(),
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    res.status(500).json({ error: 'Server configuration error.' })
    return
  }

  const parsed = waitlistSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }

  // Service role key bypasses RLS — safe because this is server-only code
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data: existing } = await supabase
    .from('waitlist')
    .select('id')
    .eq('email', parsed.data.email)
    .single()

  if (existing) {
    res.status(409).json({ error: "You're already on the waitlist! We'll be in touch soon." })
    return
  }

  const { error } = await supabase.from('waitlist').insert({
    name: parsed.data.name,
    city: parsed.data.city,
    email: parsed.data.email,
    is_pet_parent: parsed.data.is_pet_parent,
  })

  if (error) {
    console.error('[waitlist] Insert error:', error.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
    return
  }

  res.status(201).json({
    message: "You're on the list! We'll email you when Furlo launches 🐾",
  })
})

export default router
