import { MOCHA } from '../kit/palette'
import { fit, spread } from '../kit/render'
import { listRuns } from '../lib/ledger'
import { sessionKey } from '../lib/session'
import { formatTaskDetail } from '../lib/status'

const HINT = 'details · jk scroll · esc to close'
const put = (row: number, s: string) => `\x1b[${row};1H${s}`

// the last row and column stay empty: a glyph there makes the terminal scroll the popup
export function detailScreen(title: string, body: string, cols: number, rows: number, offset: number): string {
  const width = cols - 1
  const shown = body.split('\n').slice(offset, offset + Math.max(0, rows - 2))
  let text = put(1, spread({ text: title, color: MOCHA.peach, bold: true }, [{ text: HINT, color: MOCHA.overlay0 }], width))
  for (let i = 0; i < rows - 2; i++) text += put(i + 2, fit((shown[i] ?? '').replace(/[\x00-\x1f\x7f]/g, ''), width))
  return text
}

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? ''
  const run = (await listRuns(stateDir, sessionKey(process.env))).find((r) => r.run_id === process.env.HPIPE_DETAIL_RUN)
  const task = run?.tasks.find((t) => t.task_id === process.env.HPIPE_DETAIL_TASK)
  const title = task ? `${task.bead} ${task.brief.title}` : 'details'
  const body = run && task ? formatTaskDetail(run, task) : 'that task is gone'
  let offset = 0
  const lines = body.split('\n').length
  const draw = () => process.stdout.write('\x1b[2J' + detailScreen(title, body, process.stdout.columns ?? 80, process.stdout.rows ?? 24, offset))
  const quit = () => {
    process.stdout.write('\x1b[2J\x1b[?25h')
    process.exit(0)
  }
  // herdr closes a popup only when its process exits
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', (data) => {
    const key = data.toString()
    if (key === 'j' || key === '\x1b[B') offset = Math.min(Math.max(0, lines - 1), offset + 1)
    else if (key === 'k' || key === '\x1b[A') offset = Math.max(0, offset - 1)
    else return quit()
    draw()
  })
  process.stdin.on('end', quit)
  process.on('SIGHUP', quit)
  process.stdout.on('resize', draw)
  process.stdout.write('\x1b[?25l')
  draw()
}

if (import.meta.main) await main()
