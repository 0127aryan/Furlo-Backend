import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'

const router = Router()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

/**
 * GET /admin/pending-breeds
 * List all custom breed & pet type submissions awaiting admin approval
 */
router.get('/pending-breeds', async (_req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase
      .from('pending_breed_approvals')
      .select('id, pet_id, submission_type, pet_type, name, status, created_at, pets(name, username, owner_id)')
      .order('created_at', { ascending: false })

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json(data)
  } catch (err) {
    console.error('[admin] Error fetching pending breeds:', err)
    res.status(500).json({ error: 'Failed to fetch pending breed submissions.' })
  }
})

/**
 * POST /admin/approve-breed
 * Approve a pending custom breed or pet type submission
 */
router.post('/approve-breed', async (req: Request, res: Response): Promise<void> => {
  try {
    const { approvalId } = req.body
    if (!approvalId) {
      res.status(400).json({ error: 'approvalId is required.' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    
    // Update pending_breed_approvals status to approved
    const { data, error } = await supabase
      .from('pending_breed_approvals')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', approvalId)
      .select()
      .single()

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json({ message: 'Submission approved successfully!', item: data })
  } catch (err) {
    console.error('[admin] Error approving breed:', err)
    res.status(500).json({ error: 'Internal server error approving submission.' })
  }
})

/**
 * POST /admin/reject-breed
 * Reject a pending custom breed or pet type submission
 */
router.post('/reject-breed', async (req: Request, res: Response): Promise<void> => {
  try {
    const { approvalId } = req.body
    if (!approvalId) {
      res.status(400).json({ error: 'approvalId is required.' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    
    const { data, error } = await supabase
      .from('pending_breed_approvals')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', approvalId)
      .select()
      .single()

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json({ message: 'Submission rejected.', item: data })
  } catch (err) {
    console.error('[admin] Error rejecting breed:', err)
    res.status(500).json({ error: 'Internal server error rejecting submission.' })
  }
})

/**
 * GET /admin/species-verbs
 * Fetch all species verb records for admin panel
 */
router.get('/species-verbs', async (_req: Request, res: Response): Promise<void> => {
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase
      .from('species_verbs')
      .select('*')
      .order('species', { ascending: true })

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json(data)
  } catch (err) {
    console.error('[admin] Error fetching species verbs:', err)
    res.status(500).json({ error: 'Failed to fetch species verbs' })
  }
})

/**
 * POST /admin/species-verbs
 * Create a new species verb mapping
 */
router.post('/species-verbs', async (req: Request, res: Response): Promise<void> => {
  try {
    const { species, label, verb, icon } = req.body
    if (!species || !label || !verb) {
      res.status(400).json({ error: 'species, label, and verb are required.' })
      return
    }

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase
      .from('species_verbs')
      .insert({
        species: species.toLowerCase().trim(),
        label,
        verb,
        icon: icon || 'pets',
        is_active: true,
      })
      .select()
      .single()

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(201).json({ message: 'Species verb created successfully', item: data })
  } catch (err) {
    console.error('[admin] Error creating species verb:', err)
    res.status(500).json({ error: 'Failed to create species verb' })
  }
})

/**
 * PUT /admin/species-verbs/:id
 * Update an existing species verb mapping
 */
router.put('/species-verbs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params
    const { label, verb, icon, is_active } = req.body

    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)
    const { data, error } = await supabase
      .from('species_verbs')
      .update({
        ...(label && { label }),
        ...(verb && { verb }),
        ...(icon && { icon }),
        ...(typeof is_active === 'boolean' && { is_active }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json({ message: 'Species verb updated successfully', item: data })
  } catch (err) {
    console.error('[admin] Error updating species verb:', err)
    res.status(500).json({ error: 'Failed to update species verb' })
  }
})

/**
 * DELETE /admin/species-verbs/:id
 * Delete a species verb mapping
 */
router.delete('/species-verbs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!)

    const { error } = await supabase
      .from('species_verbs')
      .delete()
      .eq('id', id)

    if (error) {
      res.status(500).json({ error: error.message })
      return
    }

    res.status(200).json({ message: 'Species verb deleted successfully' })
  } catch (err) {
    console.error('[admin] Error deleting species verb:', err)
    res.status(500).json({ error: 'Failed to delete species verb' })
  }
})

export default router
