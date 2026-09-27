import 'dotenv/config'
import { Sentry } from './lib/sentry.js'
import express from 'express'
import cors from 'cors'
import authRouter from './routes/auth.js'
import adminRouter from './routes/admin.js'
import postsRouter from './routes/posts.js'
import communitiesRouter from './routes/communities.js'
import notificationsRouter from './routes/notifications.js'
import { rateLimitMiddleware } from './lib/rateLimitMiddleware.js'
import { warnIfJwtSecretMissing } from './lib/supabaseJwt.js'

warnIfJwtSecretMissing()

const app = express()
app.set('trust proxy', 1)
const port = process.env.PORT ?? 4000
const frontendUrl = process.env.FRONTEND_URL

if (!frontendUrl) {
  console.error('[startup] FRONTEND_URL is not set in .env — CORS will block all requests')
  process.exit(1)
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow mobile apps / curl (no origin) or FRONTEND_URL / mobile emulator
      if (!origin || origin === frontendUrl || origin.startsWith('http://10.0.2.2')) {
        callback(null, true)
      } else {
        callback(null, true)
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })
)
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// Health check (before rate limiting)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'furlo-backend' })
})

app.use(rateLimitMiddleware)

// Routes
app.use('/auth', authRouter)
app.use('/admin', adminRouter)
app.use('/posts', postsRouter)
app.use('/communities', communitiesRouter)
app.use('/notifications', notificationsRouter)

if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app)
}

// Only listen if not running as a Vercel serverless function
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(Number(port), '0.0.0.0', () => {
    console.log(`✓ Furlo backend running on http://0.0.0.0:${port}`)
    console.log(`  CORS allowed origin: ${frontendUrl}`)
  })
}

export default app

