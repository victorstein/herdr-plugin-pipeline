import { expect, test } from 'bun:test'
import { openPeek, peekScreen } from '../../src/kit/peek'
import { fakeHerdr } from './fake-herdr'

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
const lines = (grid: string[][]) => grid.map((row) => Array.from({ length: row.length }, (_, i) => row[i] ?? ' ').join('').trimEnd())

test('a header with title, space and tab, the hint on the right, then the latest lines', () => {
  const body = ['one', 'two', 'three', 'four', '', ''].join('\n')
  const grid = screen(peekScreen({ title: 'fix tests', where: 'General · api', body }, 60, 5), 5)
  expect(lines(grid)).toEqual([
    `fix tests · General · api${' '.repeat(8)}peek · live · esc to close`,
    'two',
    'three',
    'four',
    '',
  ])
})

test('long lines are cut and nothing touches the last column or row', () => {
  const grid = screen(peekScreen({ title: 'x'.repeat(80), where: 'w', body: 'y'.repeat(80) + '\n\tz' }, 40, 6), 6)
  expect(grid.every((row) => row[39] === undefined)).toBe(true)
  expect(grid[5]).toEqual([])
  expect(lines(grid)[0]).toEndWith('… peek · live · esc to close')
  expect(lines(grid)[1]).toBe('y'.repeat(38) + '…')
  expect(lines(grid)[2]).toBe('    z')
})

test('stale rows from a longer previous frame are blanked', () => {
  const grid = screen(peekScreen({ title: 't', where: 'w', body: 'only' }, 30, 5), 5)
  expect(grid[2]).toEqual(Array(29).fill(' '))
})


test('openPeek opens the plugin\'s own peek popup with what to show', async () => {
  const { herdr, calls } = fakeHerdr({ 'plugin.pane.open': () => ({}) })
  await openPeek(herdr, { pluginId: 'stein.example', placeholderEntrypoint: 'placeholder', peekEntrypoint: 'peek', stageName: 'example' },
    { terminalId: 't1', title: 'fix tests', where: 'General · api' })
  expect(calls).toEqual([{
    method: 'plugin.pane.open',
    params: {
      plugin_id: 'stein.example', entrypoint: 'peek', placement: 'popup', width: '70%', height: '60%', focus: true,
      env: { KIT_PEEK_TERMINAL: 't1', KIT_PEEK_TITLE: 'fix tests', KIT_PEEK_WHERE: 'General · api' },
    },
  }])
})
