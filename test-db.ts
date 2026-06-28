import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.join(__dirname, '.env') })

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

async function testConnection() {
  console.log('--- Supabase Connection Test ---')
  console.log('SUPABASE_URL:', supabaseUrl ? 'Found' : 'MISSING ❌')
  console.log('SUPABASE_SERVICE_KEY:', supabaseServiceKey ? 'Found' : 'MISSING ❌')

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Setup Error: Environment variables are missing in .env')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  try {
    const start = Date.now()
    const { data, error } = await supabase.from('users').select('id').limit(1)

    if (error) {
      throw error
    }

    console.log(`✓ Success: Connected to Supabase database! (Response time: ${Date.now() - start}ms)`)
    console.log('DB connection test succeeded.')
    process.exit(0)
  } catch (err: any) {
    console.error('❌ Connection/Query Error:')
    console.error(err.message || err)
    process.exit(1)
  }
}

testConnection()
