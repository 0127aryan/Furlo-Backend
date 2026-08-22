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

export type FollowBroadcastPayload = {
  targetPetId: string
  followerPetId: string
  following: boolean
  packMembersCount: number
  followingCount: number
}

const socialChannels = new Map<string, Promise<RealtimeChannel>>()

function getNamedChannel(name: string): Promise<RealtimeChannel> {
  const existing = socialChannels.get(name)
  if (existing) return existing

  const ready = new Promise<RealtimeChannel>((resolve, reject) => {
    const supabase = getRealtimeClient()
    if (!supabase) {
      reject(new Error('Supabase is not configured'))
      return
    }

    const channel = supabase.channel(name, {
      config: { broadcast: { ack: false, self: false } },
    })

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        resolve(channel)
        return
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        socialChannels.delete(name)
        reject(new Error(`Realtime ${status}`))
      }
    })
  })

  socialChannels.set(name, ready)
  return ready
}

export async function broadcastFollow(payload: FollowBroadcastPayload): Promise<void> {
  try {
    const channel = await getNamedChannel('pet-social')
    await channel.send({ type: 'broadcast', event: 'follow', payload })
  } catch (err) {
    console.error('[feedBroadcast] follow send failed:', err)
    socialChannels.delete('pet-social')
  }
}

export type WagBroadcastPayload = {
  id: string
  targetPetId: string
  senderPetId: string
  senderName?: string
  senderUsername?: string
  senderAvatar?: string | null
  senderBreed?: string
  created_at: string
  message?: string | null
}

export async function broadcastWag(payload: WagBroadcastPayload): Promise<void> {
  try {
    const channel = await getNamedChannel('pet-social')
    await channel.send({ type: 'broadcast', event: 'wag', payload })
  } catch (err) {
    console.error('[feedBroadcast] wag send failed:', err)
    socialChannels.delete('pet-social')
  }
}
