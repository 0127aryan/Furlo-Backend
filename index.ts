import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import waitlistRouter from './routes/waitlist.js'

dotenv.config()

const app = express()
const port = process.env.PORT ?? 4000
const frontendUrl = process.env.FRONTEND_URL

if (!frontendUrl) {
  console.error('[startup] FRONTEND_URL is not set in .env — CORS will block all requests')
  process.exit(1)
}

app.use(cors({ origin: frontendUrl, methods: ['GET', 'POST', 'OPTIONS'] }))
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'furlo-backend' })
})

// Routes
app.use('/api/waitlist', waitlistRouter)

app.listen(port, () => {
  console.log(`✓ Furlo backend running on http://localhost:${port}`)
  console.log(`  CORS allowed origin: ${frontendUrl}`)
})
