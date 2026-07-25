import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'

const router = Router()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

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

export default router
