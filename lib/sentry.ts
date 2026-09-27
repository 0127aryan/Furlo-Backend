import * as Sentry from '@sentry/node'

const dsn = process.env.SENTRY_DSN
const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development'
const isProd = process.env.NODE_ENV === 'production'

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    enabled: isProd,
    tracesSampleRate: isProd ? 0.1 : 1.0,
    beforeSend(event) {
      if (event.user) {
        delete event.user.email
        delete event.user.ip_address
      }
      return event
    },
  })
}

export { Sentry }
