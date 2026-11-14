import { expect, test } from 'bun:test'
import { detailScreen } from '../src/board/details'

const text = (screen: string) =>
  screen
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(/\x1b\[[\d;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)

test('the header, then the detail from the top, scrolled by offset, never touching the last column', () => {
  const body = ['task: t1', 'run: r1', 'branch: b', 'phase: ci'].join('\n')
  const lines = text(detailScreen('hp-7 fix login', body, 60, 4, 0))
  expect(lines[0]).toContain('hp-7 fix login')
  expect(lines[0]).toContain('esc to close')
  expect(lines.slice(1)).toEqual(['task: t1', 'run: r1'])
  expect(text(detailScreen('t', body, 60, 4, 2)).slice(1)).toEqual(['branch: b', 'phase: ci'])
})
