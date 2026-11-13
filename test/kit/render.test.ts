import { expect, test } from 'bun:test'
import { glassImageId, isGlassImage } from '../../src/kit/glass'
import { fit, formatAge, render, type View } from '../../src/kit/render'
import { imageId } from '../../src/kit/sprites'
import { cardView as card, views as board } from './fixtures'

const view = (over: Partial<View> = {}): View => ({
  board: board([]), cursor: null, header: [{ text: '✻ kit', color: '#cba6f7', bold: true }], summary: '0 cards', keys: 'hjkl move',
  message: null, now: 0, tick: 0, ...over,
})

const LAVENDER = '\x1b[38;2;180;190;254m'

function screen(text: string, rows: number): string[][] {
  const grid: string[][] = Array.from({ length: rows }, () => [])
  let row = 0
  let col = 0
  for (const m of text.matchAll(/\x1b\[(\d+);(\d+)H|\x1b\[[\d;]*m|([^\x1b])/gu)) {
    if (m[1]) [row, col] = [Number(m[1]) - 1, Number(m[2]) - 1]
    else if (m[3]) grid[row]![col++] = m[3]
  }
  return grid
}
const line = (grid: string[][], row: number, from = 0, to = 200) => Array.from({ length: to - from }, (_, i) => grid[row - 1]![from + i] ?? ' ').join('').trimEnd()

test('one sprite per visible card, just right of the selection bar', () => {
  const b = board([
    card({ id: 'a', column: 'needs', scene: 'blocked' }),
    card({ id: 'b', column: 'working', scene: 'working' }),
    card({ id: 'c', column: 'done', scene: 'done' }),
    card({ id: 'd', column: 'idle', scene: 'idle' }),
  ])
  const { placements } = render(view({ board: b, cursor: 'a' }), 140, 40)
  // one column of tinted padding on each side of a column's content
  expect(placements.map((p) => [p.row, p.col])).toEqual([[4, 3], [4, 38], [4, 73], [4, 108]])
  expect(placements.map((p) => p.image)).toEqual([
    imageId('blocked', 0, 'none', false),
    imageId('working', 1, 'none', false),
    imageId('done', 2, 'none', false),
    imageId('idle', 3, 'none', false),
  ])
})

test('a card that just entered Done plays the jump, then its column loop', () => {
  const b = board([card({ id: 'a', column: 'done', scene: 'done', accessory: 'cap', enteredAt: 10_000 })])
  const image = (now: number) => render(view({ board: b, now }), 140, 40).placements[0]!.image
  expect(image(10_800)).toBe(imageId('enterDone', 3, 'cap', false))
  expect(image(11_500)).toBe(imageId('done', 2, 'cap', false))
})

test('a card that just entered Needs you plays the hop', () => {
  const b = board([card({ id: 'a', column: 'needs', enteredAt: 0 })])
  expect(render(view({ board: b, now: 1499 }), 140, 40).placements[0]!.image).toBe(imageId('enterNeeds', 5, 'none', false))
})

test('cards are two text rows and a gap row: title and age, then space · tab and status', () => {
  const b = board([
    card({ id: 'a', title: 'first', since: 0, column: 'working' }),
    card({ id: 'b', title: 'second', since: 0, column: 'working', subtitle: 'General · api', badge: { text: '⚙ 2 bg', color: '#fab387' } }),
  ])
  const grid = screen(render(view({ board: b, now: 12 * 60_000 }), 140, 40).text, 40)
  const x = 35
  expect(line(grid, 4, x, x + 34)).toBe(`         first${' '.repeat(15)}12m`)
  expect(line(grid, 5, x, x + 34)).toBe(`         General · main${' '.repeat(3)}claude`)
  expect(line(grid, 6, x, x + 34)).toBe('')
  expect(line(grid, 7, x + 9, x + 34)).toStartWith('second')
  expect(line(grid, 8, x, x + 34)).toBe(`         General · api${' '.repeat(4)}⚙ 2 bg`)
  expect(render(view({ board: b }), 140, 40).placements.map((p) => p.row)).toEqual([4, 7])
})

const PEACH = '\x1b[38;2;250;179;135m'

test('row 1 shows the context percentage before the age, coloured by how full it is', () => {
  const row1 = (ctx: number | null) => {
    const { text } = render(view({ board: board([card({ id: 'a', title: 'first', since: 0, ctx })]), now: 12 * 60_000 }), 140, 40)
    return { line: line(screen(text, 40), 4, 105, 139), text }
  }
  expect(row1(null).line).toBe(`         first${' '.repeat(15)}12m`)
  expect(row1(42).line).toBe(`         first${' '.repeat(11)}42% 12m`)
  const colour = (ctx: number) => row1(ctx).text.match(new RegExp(`(\\x1b\\[38;2;[\\d;]+m)${ctx}%`))![1]
  expect(colour(49)).toBe('\x1b[38;2;108;112;134m')
  expect(colour(50)).toBe('\x1b[38;2;249;226;175m')
  expect(colour(70)).toBe(PEACH)
  expect(colour(85)).toBe('\x1b[38;2;243;139;168m')
})

test('Clawd sweats from 70% context', () => {
  const image = (ctx: number | null) => render(view({ board: board([card({ id: 'a', column: 'working', scene: 'working', ctx })]) }), 140, 40).placements[0]!.image
  expect(image(69)).toBe(imageId('working', 1, 'none', false))
  expect(image(70)).toBe(imageId('working', 1, 'none', true))
  expect(image(null)).toBe(imageId('working', 1, 'none', false))
})

test('a full context still fits a narrow card without touching the last column', () => {
  const b = board([card({ id: 'a', title: 'x'.repeat(40), since: 0, ctx: 100 })])
  for (const cols of [80, 81, 140]) {
    const grid = screen(render(view({ board: b, now: 3 * 86_400_000 }), cols, 40).text, 40)
    expect(grid.every((row) => row[cols - 1] === undefined)).toBe(true)
    expect(line(grid, 4)).toEndWith('100% 3d')
  }
})

test('narrow columns drop sprites and their gutter', () => {
  const b = board([card({ id: 'a', column: 'needs', title: 'first' })])
  const { text, placements } = render(view({ board: b }), 80, 40)
  expect(placements).toEqual([])
  expect(line(screen(text, 40), 4, 0, 19)).toStartWith('  first')
})

test('the column scrolls to keep the cursor visible', () => {
  const cards = ['a', 'b', 'c'].map((id) => card({ id, title: `title-${id}`, column: 'working' }))
  const { text, placements } = render(view({ board: board(cards), cursor: 'c' }), 140, 11)
  expect(text).toContain('title-b')
  expect(text).toContain('title-c')
  expect(text).not.toContain('title-a')
  expect(text).toContain('(+1)')
  expect(placements.map((p) => p.row)).toEqual([4, 7])
})

test('the selected card has a lavender bar on both rows', () => {
  const b = board([card({ id: 'a' }), card({ id: 'b' })])
  const { text } = render(view({ board: b, cursor: 'a' }), 140, 40)
  expect(text.split(LAVENDER + '▌').length - 1).toBe(2)
  const grid = screen(text, 40)
  expect([4, 5, 6, 7].map((r) => grid[r - 1]![106] ?? ' ')).toEqual(['▌', '▌', ' ', ' '])
})

test('nothing is drawn in the last screen column', () => {
  const long = 'x'.repeat(80)
  const b = board([card({ id: 'a', title: long, subtitle: long, column: 'idle' })])
  for (const cols of [140, 141, 142, 143]) {
    const grid = screen(render(view({ board: b, message: long.repeat(3) }), cols, 40).text, 40)
    expect(grid.every((row) => row[cols - 1] === undefined)).toBe(true)
  }
})

test('a message replaces the status summary', () => {
  expect(render(view({ message: 'herdr did not move the pane' }), 140, 40).text).toContain('herdr did not move the pane')
})

test('formatAge', () => {
  expect(formatAge(null, 0)).toBe('—')
  expect(formatAge(0, 30_000)).toBe('<1m')
  expect(formatAge(0, 12 * 60_000)).toBe('12m')
  expect(formatAge(0, 3 * 3_600_000)).toBe('3h')
  expect(formatAge(0, 49 * 3_600_000)).toBe('2d')
})

test('fit truncates with an ellipsis and pads', () => {
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('ab', 4)).toBe('ab  ')
  expect(fit('ab', 0)).toBe('')
})

test('the key hints include peek and are cut to fit before the last column', () => {
  const keys = 'hjkl move  enter stage  space peek  r rename  tab type  n new  x clear  X close  z zoom  0-9 spaces'
  expect(line(screen(render(view({ keys: 'hjkl move  space peek' }), 160, 40).text, 40), 40)).toContain('space peek')
  for (const cols of [60, 100, 140]) {
    const grid = screen(render(view({ keys }), cols, 40).text, 40)
    expect(grid[39]![cols - 1]).toBeUndefined()
  }
})

test('each column is tinted for its state, header to the bottom, with untinted gaps between', () => {
  const bgCode = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return `\x1b[48;2;${n >> 16};${(n >> 8) & 255};${n & 255}m`
  }
  const b = board([card({ id: 'a', column: 'needs' }), card({ id: 'i', column: 'idle' })])
  const { text } = render(view({ board: b, cursor: 'a' }), 140, 12)
  for (const tint of ['#2f2738', '#272a3e', '#292e37', '#181825']) expect(text).toContain(bgCode(tint))
  // colWidth = floor((140-4)/4) = 34: Needs you spans columns 1–34, Working starts at 36, and row 11 is the last tinted row
  expect(text).toContain(`\x1b[11;1H${bgCode('#2f2738')}`)
  expect(text).toContain(`\x1b[11;36H${bgCode('#272a3e')}`)
  expect(text).not.toContain('\x1b[2;35H')
})

test('content is padded one column inside its tinted column', () => {
  const b = board([card({ id: 'a', column: 'needs', title: 'padded' })])
  const grid = screen(render(view({ board: b, cursor: 'a' }), 140, 12).text, 12)
  expect(grid[1]![0]).toBe(' ')
  expect(grid[1]![1]).toBe('●')
  expect(grid[3]![0]).toBe(' ')
  expect(grid[3]![1]).toBe('▌')
  expect(grid[3]![33]).toBe(' ')
})

test('a blank tinted row separates each column title from its cards', () => {
  const b = board([card({ id: 'a', column: 'needs', title: 'gap' })])
  const grid = screen(render(view({ board: b }), 140, 12).text, 12)
  expect(line(grid, 2, 0, 34)).toStartWith(' ● Needs you')
  expect(line(grid, 3, 0, 34)).toBe('')
  expect(line(grid, 4, 0, 34)).toContain('gap')
})

test('every screen row segment is written exactly once, so no cell flickers through a blank', () => {
  const b = board([card({ id: 'a', column: 'needs' }), card({ id: 'b', column: 'working' }), card({ id: 'c', column: 'working' })])
  const { text } = render(view({ board: b, cursor: 'a', header: [{ text: '✻ kit', color: '#cba6f7' }, { text: '1 General 3', color: '#7f849c' }] }), 140, 14)
  const positions = [...text.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((m) => `${m[1]};${m[2]}`)
  expect(new Set(positions).size).toBe(positions.length)
  const grid = screen(text, 14)
  expect(grid[0]!.length).toBe(139)
  expect(grid[13]!.length).toBe(139)
})

const cell = { width: 10, height: 20 }

test('with a known cell size each card gets a glass panel under its text, centred on its two rows', () => {
  const b = board([card({ id: 'a', column: 'needs' }), card({ id: 'b', column: 'needs' })])
  const glass = render(view({ board: b, cursor: 'b', cell }), 140, 40).placements.filter((p) => isGlassImage(p.image))
  expect(glass).toEqual([
    { id: 50_000, image: glassImageId(32, false), row: 3, col: 2, cols: 32, rows: 4, z: -1 },
    { id: 50_001, image: glassImageId(32, true), row: 6, col: 2, cols: 32, rows: 4, z: -1 },
  ])
})

test('on glass the selection is the heavier frost, not the bar', () => {
  const b = board([card({ id: 'a' })])
  expect(render(view({ board: b, cursor: 'a', cell }), 140, 40).text).not.toContain(LAVENDER + '▌')
  expect(render(view({ board: b, cursor: 'a' }), 140, 40).text).toContain(LAVENDER + '▌')
})

test('without a cell size there is no glass', () => {
  const b = board([card({ id: 'a' })])
  expect(render(view({ board: b }), 140, 40).placements.some((p) => isGlassImage(p.image))).toBe(false)
})

test('a rename prompt replaces the status line', () => {
  const grid = screen(render(view({ prompt: 'rename: auth▏', message: 'ignored' }), 140, 40).text, 40)
  expect(line(grid, 40)).toBe('rename: auth▏')
})

test('the header spans are joined two spaces apart and cut before the last column', () => {
  const header = [{ text: '✻ brand', color: '#cba6f7', bold: true }, { text: 'one', color: '#7f849c' }, { text: 'x'.repeat(200), color: '#7f849c' }]
  const grid = screen(render(view({ header }), 60, 10).text, 10)
  expect(line(grid, 1)).toBe('✻ brand  one')
  expect(grid[0]!.length).toBe(59)
})

test('the status line shows the summary then the key hints', () => {
  expect(line(screen(render(view({ summary: '3 cards', keys: 'q quit' }), 80, 10).text, 10), 10)).toBe('3 cards  q quit')
})

test('an emoji in the summary counts as one column', () => {
  expect(line(screen(render(view({ summary: '🐑 3 cards', keys: 'q quit' }), 80, 10).text, 10), 10)).toBe('🐑 3 cards  q quit')
})

test('column titles can be renamed per plugin', () => {
  const grid = screen(render(view({ titles: { idle: '○ Idle/queued' } }), 140, 10).text, 10)
  expect(line(grid, 2, 105, 139)).toStartWith(' ○ Idle/queued 0')
})

test('the loop frame wraps at the scene\'s own frame count', () => {
  const b = board([card({ id: 'a', column: 'working', scene: 'working' })])
  expect(render(view({ board: b, tick: 6 }), 140, 40).placements[0]!.image).toBe(imageId('working', 3, 'none', false))
})
