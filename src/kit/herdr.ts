import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Snapshot } from './types'

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

export interface Herdr {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

export type Subscription = { type: string; pane_id?: string }

export const socketPath = () => process.env.HERDR_SOCKET_PATH ?? join(homedir(), '.config/herdr/herdr.sock')

function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffered = ''
  return (chunk) => {
    buffered += chunk.toString()
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim()) onLine(line)
    }
  }
}

export function createClient(path = socketPath(), timeoutMs = 10_000): Herdr {
  let seq = 0
  return {
    call<T>(method: string, params: Record<string, unknown> = {}) {
      return new Promise<T>((settle, fail) => {
        const id = `kit-${++seq}`
        const sock = connect(path)
        const timer = setTimeout(() => {
          reject(new HerdrError('timeout', `herdr did not answer ${method} within ${timeoutMs} ms`))
          sock.destroy()
        }, timeoutMs)
        const resolve = (value: T) => {
          clearTimeout(timer)
          settle(value)
        }
        const reject = (reason: unknown) => {
          clearTimeout(timer)
          fail(reason)
        }
        sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'))
        sock.on('data', lines((line) => {
          let msg: { id?: string; result?: T; error?: { code: string; message: string } }
          try {
            msg = JSON.parse(line)
          } catch (e) {
            sock.destroy()
            reject(e)
            return
          }
          if (msg.id !== id) return
          sock.end()
          if (msg.error) reject(new HerdrError(msg.error.code, msg.error.message))
          else resolve(msg.result as T)
        }))
        sock.on('error', reject)
        sock.on('close', () => reject(new HerdrError('closed', 'herdr closed the connection before replying')))
      })
    },
  }
}

export async function readSnapshot(herdr: Herdr): Promise<Snapshot> {
  return (await herdr.call<{ snapshot: Snapshot }>('session.snapshot')).snapshot
}

export function subscribe(subs: Subscription[], onEvent: () => void, onEnd: () => void, path = socketPath()): () => void {
  let stopped = false
  const sock = connect(path)
  const end = () => {
    if (stopped) return
    stopped = true
    onEnd()
  }
  sock.on('connect', () => sock.write(JSON.stringify({ id: 'kit-sub', method: 'events.subscribe', params: { subscriptions: subs } }) + '\n'))
  sock.on('data', lines((line) => {
    let msg: { event?: string; error?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      sock.destroy()
      return
    }
    // events_lost, or a subscribed pane that no longer exists: herdr closes the stream and the caller resubscribes
    if (msg.error) sock.destroy()
    else if (msg.event) onEvent()
  }))
  sock.on('close', end)
  sock.on('error', end)
  return () => {
    stopped = true
    sock.destroy()
  }
}
