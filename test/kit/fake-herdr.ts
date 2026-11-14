import type { Herdr } from '../../src/kit/herdr'

type Handler = (params: Record<string, unknown>) => unknown

export function fakeHerdr(handlers: Record<string, Handler>) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const herdr: Herdr = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected call ${method}`)
      return handler(params) as T
    },
  }
  return { herdr, calls, methods: () => calls.map((c) => c.method) }
}

export const moved = (paneId: string, changed = true, reason: string | null = null) => ({
  move_result: { changed, reason, pane: { pane_id: paneId } },
})

export const opened = (paneId: string, tabId = 'wP:t1') => ({ plugin_pane: { pane: { pane_id: paneId, tab_id: tabId } } })
