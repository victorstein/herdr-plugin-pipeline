import type { SessionKey } from './types'

const SESSION_PATH = /\/sessions\/([^/]+)\/herdr\.sock$/

export function sessionKey(env: Record<string, string | undefined> = process.env): SessionKey {
  const named = env.HERDR_SESSION
  if (named && named.length > 0) return named

  const socket = env.HERDR_SOCKET_PATH
  if (socket) {
    const matched = SESSION_PATH.exec(socket)
    if (matched?.[1]) return matched[1]
  }

  return 'default'
}
