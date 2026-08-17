import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'

export type FeedCountPayload = {
  postId: string
  likeCount?: number
  commentCount?: number
  likedByPetId?: string | null
  unlikedByPetId?: string | null
}

let client: SupabaseClient | null = null
let channelReady: Promise<RealtimeChannel> | null = null

function getRealtimeClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  if (!client) {
    client = createClient(url, key, {
      realtime: { params: { eventsPerSecond: 20 } },
    })
  }
  return client
}

function getChannel(): Promise<RealtimeChannel> {
  if (channelReady) return channelReady

  channelReady = new Promise((resolve, reject) => {
    const supabase = getRealtimeClient()
    if (!supabase) {
      reject(new Error('Supabase is not configured'))
      return
    }

    const channel = supabase.channel('yard-feed', {
      config: { broadcast: { ack: false, self: false } },
    })

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        resolve(channel)
        return
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        channelReady = null
        reject(new Error(`Realtime ${status}`))
      }
    })
  })

  return channelReady
}

export async function broadcastFeedEvent(event: string, payload: unknown): Promise<void> {
  try {
    const channel = await getChannel()
    await channel.send({ type: 'broadcast', event, payload })
  } catch (err) {
    console.error('[feedBroadcast] send failed:', err)
    channelReady = null
  }
}

export async function broadcastFeedCounts(payload: FeedCountPayload): Promise<void> {
  await broadcastFeedEvent('counts', payload)
}

export async function broadcastNewPost(post: unknown): Promise<void> {
  await broadcastFeedEvent('post', post)
}
