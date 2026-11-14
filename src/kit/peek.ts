import { createClient, readSnapshot, type Herdr } from './herdr'
import { MOCHA } from './palette'
import { fit, spread } from './render'
import type { Identity } from './stage'

export interface PeekView {
  title: string
  where: string
  body: string
}

export interface PeekTarget {
  terminalId: string
  title: string
  where: string
}

export async function openPeek(herdr: Herdr, identity: Identity, target: PeekTarget): Promise<void> {
  await herdr.call('plugin.pane.open', {
    plugin_id: identity.pluginId, entrypoint: identity.peekEntrypoint, placement: 'popup', width: '70%', height: '60%', focus: true,
    env: { KIT_PEEK_TERMINAL: target.terminalId, KIT_PEEK_TITLE: target.title, KIT_PEEK_WHERE: target.where },
  })
}

const HINT = 'peek · live · esc to close'
const put = (row: number, s: string) => `\x1b[${row};1H${s}`

// the last row and column stay empty: a glyph there makes the terminal scroll the popup
export function peekScreen(view: PeekView, cols: number, rows: number): string {
  const width = cols - 1
  const title = view.where ? `${view.title} · ${view.where}` : view.title
  const header = spread({ text: title, color: MOCHA.peach, bold: true }, [{ text: HINT, color: MOCHA.overlay0 }], width)
  const bodyRows = Math.max(0, rows - 2)
  const shown = view.body.replace(/\s+$/, '').split('\n').slice(-bodyRows)
  let text = put(1, header)
  for (let i = 0; i < bodyRows; i++) {
    const line = (shown[i] ?? '').replace(/\t/g, '    ').replace(/[\x00-\x1f\x7f]/g, '')
    text += put(i + 2, fit(line, width))
  }
  return text
}

async function main(): Promise<void> {
  const herdr = createClient()
  const terminalId = process.env.KIT_PEEK_TERMINAL
  let view: PeekView = { title: process.env.KIT_PEEK_TITLE ?? 'peek', where: process.env.KIT_PEEK_WHERE ?? '', body: '' }
  let gone = false

  const draw = () => process.stdout.write(peekScreen(view, process.stdout.columns ?? 80, process.stdout.rows ?? 24))
  const quit = () => {
    process.stdout.write('\x1b[2J\x1b[?25h')
    process.exit(0)
  }

  async function poll(): Promise<void> {
    try {
      const snap = await readSnapshot(herdr)
      const pane = snap.panes.find((p) => p.terminal_id === terminalId)
      if (!pane) {
        gone = true
        view = { ...view, body: 'this agent is gone' }
        return
      }
      const rows = process.stdout.rows ?? 24
      const { read } = await herdr.call<{ read: { text: string } }>('pane.read', {
        pane_id: pane.pane_id, source: 'recent', lines: Math.max(1, rows - 2), strip_ansi: true,
      })
      view = { ...view, body: read.text }
    } catch (e) {
      view = { ...view, body: e instanceof Error ? e.message : String(e) }
    }
  }

  async function loop(): Promise<void> {
    await poll()
    draw()
    if (!gone) setTimeout(loop, 1000)
  }

  // herdr closes a popup only when its process exits
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', (data) => {
    const key = data.toString()
    if (gone || key === '\x1b' || key === 'q' || key === ' ' || key === '\x03') quit()
  })
  process.stdin.on('end', quit)
  process.on('SIGHUP', quit)
  process.stdout.on('resize', () => {
    process.stdout.write('\x1b[2J')
    draw()
  })
  process.stdout.write('\x1b[?25l\x1b[2J')
  await loop()
}

if (import.meta.main) await main()
