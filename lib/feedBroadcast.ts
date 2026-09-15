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

async function sendBroadcast(channel: RealtimeChannel, event: string, payload: unknown): Promise<void> {
  const chan = channel as any
  if (typeof chan.httpSend === 'function') {
    await chan.httpSend(event, payload ?? {})
  } else {
    await channel.send({ type: 'broadcast', event, payload })
  }
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
    await sendBroadcast(channel, event, payload)
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
    await sendBroadcast(channel, 'follow', payload)
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
    await sendBroadcast(channel, 'wag', payload)
  } catch (err) {
    console.error('[feedBroadcast] wag send failed:', err)
    socialChannels.delete('pet-social')
  }
}

export async function broadcastNotification(
  userId: string,
  notification: Record<string, unknown>
): Promise<void> {
  const payload = { ...notification, user_id: userId }

  try {
    const social = await getNamedChannel('pet-social')
    await sendBroadcast(social, 'notification', payload)
  } catch (err) {
    console.error('[feedBroadcast] notification pet-social send failed:', err)
    socialChannels.delete('pet-social')
  }

  try {
    const channel = await getNamedChannel(`user-notifications-${userId}`)
    await sendBroadcast(channel, 'notification', payload)
  } catch (err) {
    console.error('[feedBroadcast] notification user channel send failed:', err)
    socialChannels.delete(`user-notifications-${userId}`)
  }
}

export async function broadcastBannerUpdate(banner: unknown): Promise<void> {
  try {
    const channel = await getNamedChannel('global-banners')
    await sendBroadcast(channel, 'banner_update', { banner })
  } catch (err) {
    console.error('[feedBroadcast] banner send failed:', err)
    socialChannels.delete('global-banners')
  }
}

export async function broadcastGlobalMessage(payload: { title: string; body: string; linkUrl?: string | null; id?: string }): Promise<void> {
  try {
    const channel = await getNamedChannel('global-broadcasts')
    await sendBroadcast(channel, 'global_broadcast', payload)
  } catch (err) {
    console.error('[feedBroadcast] global broadcast send failed:', err)
    socialChannels.delete('global-broadcasts')
  }

  try {
    const social = await getNamedChannel('pet-social')
    await sendBroadcast(social, 'global_broadcast', payload)
  } catch (err) {
    console.error('[feedBroadcast] global broadcast pet-social send failed:', err)
    socialChannels.delete('pet-social')
  }
}

export async function broadcastGlobalRevoke(payload: { title: string; body: string; id?: string }): Promise<void> {
  try {
    const channel = await getNamedChannel('global-broadcasts')
    await sendBroadcast(channel, 'revoke_broadcast', payload)
  } catch (err) {
    console.error('[feedBroadcast] revoke broadcast send failed:', err)
    socialChannels.delete('global-broadcasts')
  }

  try {
    const social = await getNamedChannel('pet-social')
    await sendBroadcast(social, 'revoke_broadcast', payload)
  } catch (err) {
    console.error('[feedBroadcast] revoke broadcast pet-social send failed:', err)
    socialChannels.delete('pet-social')
  }
}

export async function broadcastPetBadgeUpdate(payload: { petId: string; is_verified: boolean; is_founding_pet: boolean }): Promise<void> {
  try {
    const channel = await getNamedChannel('pet-social-badges')
    await sendBroadcast(channel, 'pet_badge_updated', payload)
  } catch (err) {
    console.error('[feedBroadcast] pet badge update send failed:', err)
    socialChannels.delete('pet-social-badges')
  }
}

export async function broadcastModerationReport(report: unknown): Promise<void> {
  try {
    const channel = await getNamedChannel('moderation-queue')
    await sendBroadcast(channel, 'report_created', { report })
  } catch (err) {
    console.error('[feedBroadcast] moderation report send failed:', err)
    socialChannels.delete('moderation-queue')
  }
}

export async function broadcastModerationAction(payload: { reportId: string; action: string; targetType?: string; targetId?: string }): Promise<void> {
  try {
    const channel = await getNamedChannel('moderation-queue')
    await sendBroadcast(channel, 'report_action', payload)
  } catch (err) {
    console.error('[feedBroadcast] moderation action send failed:', err)
    socialChannels.delete('moderation-queue')
  }
}

export async function broadcastPostRemoved(postId: string): Promise<void> {
  try {
    const feedChannel = await getChannel()
    await sendBroadcast(feedChannel, 'post_removed', { postId })
  } catch (err) {
    console.error('[feedBroadcast] post_removed feed send failed:', err)
    channelReady = null
  }

  try {
    const socialChannel = await getNamedChannel('pet-social')
    await sendBroadcast(socialChannel, 'post_removed', { postId })
  } catch (err) {
    console.error('[feedBroadcast] post_removed social send failed:', err)
    socialChannels.delete('pet-social')
  }
}
