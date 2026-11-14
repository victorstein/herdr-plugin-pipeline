import { GLASS_ROWS, glassImageId, type Cell } from './glass'
import type { Placement } from './kitty'
import { COLUMNS, locate, type Column } from './nav'
import { MOCHA } from './palette'
import { framesOf, imageId, type Accessory, type Scene } from './sprites'

// two text rows and a gap row, which the glass panels above and below each reach halfway into
export const CARD_H = 3
export const SPRITE_COLS = 6
const SPRITE_GUTTER = SPRITE_COLS + 1
const MIN_TEXT = 14

export interface CardView {
  id: string
  column: Column
  title: string
  subtitle: string
  /** Row 2's right-hand label. */
  badge: Span
  since: number | null
  ctx: number | null
  /** The loop scene; the enter transitions for Done and Needs you play over it. */
  scene: Scene
  accessory: Accessory
  enteredAt: number | null
}

export interface View {
  board: Record<Column, CardView[]>
  cursor: string | null
  /** Row 1, left to right: the first span always shows, the rest only while they fit. */
  header: Span[]
  summary: string
  keys: string
  titles?: Partial<Record<Column, string>>
  message: string | null
  prompt?: string | null
  now: number
  tick: number
  cell?: Cell | null
}

const HEAD: Record<Column, [string, string]> = {
  needs: ['● Needs you', MOCHA.red],
  working: ['◐ Working', MOCHA.blue],
  done: ['✓ Done', MOCHA.green],
  idle: ['○ Idle', MOCHA.overlay1],
}
const ENTER: Partial<Record<Column, Scene>> = { done: 'enterDone', needs: 'enterNeeds' }
// below the text but above the tinted cell backgrounds, so the column tint shows through the frost
const GLASS_Z = -1
const GLASS_PLACEMENT = 50_000
const ENTER_FRAME_MS = 250
const ENTER_MS = 1500

function spriteImage(card: CardView, now: number, tick: number): number {
  const enter = ENTER[card.column]
  const sinceEntered = card.enteredAt === null ? -1 : now - card.enteredAt
  const sweat = (card.ctx ?? 0) >= 70
  if (enter && sinceEntered >= 0 && sinceEntered < ENTER_MS) return imageId(enter, Math.floor(sinceEntered / ENTER_FRAME_MS), card.accessory, sweat)
  return imageId(card.scene, tick % framesOf(card.scene), card.accessory, sweat)
}

const ESC = '\x1b['
const RESET = `${ESC}0m`
const fg = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `${ESC}38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m`
}
const put = (row: number, col: number, s: string) => `${ESC}${row};${col}H${s}`

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const chars = [...text]
  if (chars.length <= width) return text + ' '.repeat(width - chars.length)
  return chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

const paint = (text: string, width: number, color: string, bold = false) => (bold ? `${ESC}1m` : '') + fg(color) + fit(text, width) + RESET

const COLUMN_PADDING = 1
const TITLE_GAP = 1
const FIRST_CARD_ROW = 3 + TITLE_GAP
// about 8% of each state's colour mixed into Mocha base; Idle uses mantle so it recedes
const COLUMN_TINT: Record<Column, string> = { needs: '#2f2738', working: '#272a3e', done: '#292e37', idle: MOCHA.mantle }

const bg = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `${ESC}48;2;${n >> 16};${(n >> 8) & 255};${n & 255}m`
}

// every colour reset inside a column would also drop its background, so the tint is re-applied after each one
function tinted(segment: string, background: string): string {
  const code = bg(background)
  return code + segment.replaceAll(RESET, RESET + code) + RESET
}

export function formatAge(since: number | null, now: number): string {
  if (since === null) return '—'
  const minutes = Math.floor((now - since) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export interface Span {
  text: string
  color: string
  bold?: boolean
}

const spanWidth = (spans: Span[]) => spans.reduce((n, s) => n + [...s.text].length + 1, -1)

// the right group is space-separated; when it cannot fit, only its last span is kept (and truncated)
export function spread(left: Span, right: Span[], width: number): string {
  const kept = spanWidth(right) <= width ? right : right.slice(-1)
  const rightWidth = Math.min(spanWidth(kept), width)
  const leftWidth = Math.max(0, width - rightWidth - 1)
  let room = rightWidth
  const group = kept.map((s, i) => {
    const w = Math.min([...s.text].length, room)
    room -= w + 1
    return (i ? ' ' : '') + paint(s.text, w, s.color, s.bold)
  })
  return paint(left.text, leftWidth, left.color, left.bold) + ' '.repeat(width - rightWidth - leftWidth) + group.join('')
}

function contextSpan(ctx: number): Span {
  const color = ctx >= 85 ? MOCHA.red : ctx >= 70 ? MOCHA.peach : ctx >= 50 ? MOCHA.yellow : MOCHA.overlay0
  return { text: `${ctx}%`, color }
}

const hasSprite = (width: number) => width - 2 - SPRITE_GUTTER >= MIN_TEXT

function cardLines(card: CardView, width: number, selected: boolean, glass: boolean, now: number): string[] {
  // on glass the selected panel is frosted more heavily, so the bar is only for terminals that never reported a cell size
  const bar = selected && !glass ? fg(MOCHA.lavender) + '▌' + RESET : ' '
  const gutter = hasSprite(width) ? SPRITE_GUTTER : 0
  const textWidth = width - 2 - gutter
  const title = { text: card.title, color: card.column === 'needs' ? MOCHA.red : MOCHA.text, bold: true }
  const age = { text: formatAge(card.since, now), color: MOCHA.overlay0 }
  return [
    spread(title, card.ctx === null ? [age] : [contextSpan(card.ctx), age], textWidth),
    spread({ text: card.subtitle, color: MOCHA.overlay1 }, [card.badge], textWidth),
  ].map((line) => bar + ' '.repeat(gutter) + line + ' ')
}

function headerLine(spans: Span[], cols: number): string {
  const width = cols - 1
  let used = 0
  let line = ''
  for (const [i, span] of spans.entries()) {
    const gap = i ? 2 : 0
    const w = [...span.text].length
    if (i && used + gap + w > width) break
    const shown = Math.min(w, width - used - gap)
    line += ' '.repeat(gap) + paint(span.text, shown, span.color, span.bold)
    used += gap + shown
  }
  return line + ' '.repeat(Math.max(0, width - used))
}

function statusLine(view: View, cols: number): string {
  const width = cols - 1
  if (view.prompt) return paint(view.prompt, width, MOCHA.lavender)
  if (view.message) return paint(view.message, width, MOCHA.red)
  const summaryWidth = [...view.summary].length
  const room = width - summaryWidth - 2
  if (room <= 0) return paint(view.summary, width, MOCHA.overlay1)
  return paint(view.summary, summaryWidth, MOCHA.overlay1) + '  ' + paint(view.keys, room, MOCHA.lavender)
}

export function render(view: View, cols: number, rows: number): { text: string; placements: Placement[] } {
  // the last column stays empty: a glyph there makes the terminal wrap and scroll the board
  const colWidth = Math.max(10, Math.floor((cols - 4) / 4))
  // rows: header, column title, a blank gap under the title, the cards with a gap row after each, then the status line
  const fits = Math.max(0, Math.floor((rows - FIRST_CARD_ROW) / CARD_H))
  const at = locate(view.board, view.cursor)
  const placements: Placement[] = []
  let text = put(1, 1, headerLine(view.header, cols))

  COLUMNS.forEach((column, ci) => {
    const cards = view.board[column]
    const offset = at && at.col === ci ? Math.max(0, at.row - fits + 1) : 0
    const shown = cards.slice(offset, offset + fits)
    const hidden = cards.length - shown.length
    const x = 1 + ci * (colWidth + 1)
    const inner = x + COLUMN_PADDING
    const innerWidth = colWidth - 2 * COLUMN_PADDING
    const lines = new Map<number, string>()
    const label = view.titles?.[column] ?? HEAD[column][0]
    const color = HEAD[column][1]
    lines.set(2, paint(`${label} ${cards.length}${hidden ? ` (+${hidden})` : ''}`, innerWidth, color, true))
    shown.forEach((card, ri) => {
      const top = FIRST_CARD_ROW + ri * CARD_H
      const selected = card.id === view.cursor
      cardLines(card, innerWidth, selected, Boolean(view.cell), view.now).forEach((line, k) => lines.set(top + k, line))
      if (view.cell) {
        placements.push({
          id: GLASS_PLACEMENT + ci * 100 + ri, image: glassImageId(innerWidth, selected),
          row: top - 1, col: inner, cols: innerWidth, rows: GLASS_ROWS, z: GLASS_Z,
        })
      }
      if (hasSprite(innerWidth)) {
        placements.push({ id: ci * 100 + ri + 1, image: spriteImage(card, view.now, view.tick + ri + ci), row: top, col: inner + 1 })
      }
    })
    // each row is written once, padding and content together: herdr can show a large write half-applied,
    // so painting a blank fill first and the text over it flickered
    const left = ' '.repeat(COLUMN_PADDING)
    const right = ' '.repeat(colWidth - COLUMN_PADDING - innerWidth)
    for (let row = 2; row < rows; row++) {
      text += put(row, x, tinted(left + (lines.get(row) ?? ' '.repeat(innerWidth)) + right, COLUMN_TINT[column]))
    }
  })

  text += put(rows, 1, statusLine(view, cols))
  return { text, placements }
}
