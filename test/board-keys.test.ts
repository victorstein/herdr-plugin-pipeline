import { expect, test } from 'bun:test'
import { NAV, splitKeys } from '../src/board/keys'

test('splitKeys cuts a chunk into single keys', () => {
  expect(splitKeys('\x1bOD\x1bOC')).toEqual(['\x1bOD', '\x1bOC'])
  expect(splitKeys('\x1b[A')).toEqual(['\x1b[A'])
  expect(splitKeys('hj')).toEqual(['h', 'j'])
  expect(splitKeys('\x1b')).toEqual(['\x1b'])
})

test('splitKeys splits the chunk herdr 0.9.1 sends for send-keys left right up down enter tab', () => {
  expect(splitKeys('\u001bOD\u001bOC\u001bOA\u001bOB\n\t')).toEqual(['\x1bOD', '\x1bOC', '\x1bOA', '\x1bOB', '\n', '\t'])
})

test('splitKeys keeps a parameterised CSI whole and returns nothing for an empty chunk', () => {
  expect(splitKeys('\x1b[1;5A')).toEqual(['\x1b[1;5A'])
  expect(splitKeys('')).toEqual([])
})

test('splitKeys splits an alt-chord and keeps a non-BMP character whole', () => {
  expect(splitKeys('\x1bx')).toEqual(['\x1b', 'x'])
  expect(splitKeys('😀a')).toEqual(['😀', 'a'])
})

test('NAV maps the CSI arrow, the SS3 arrow and hjkl to the same direction', () => {
  const groups = { up: ['\x1b[A', '\x1bOA', 'k'], down: ['\x1b[B', '\x1bOB', 'j'], right: ['\x1b[C', '\x1bOC', 'l'], left: ['\x1b[D', '\x1bOD', 'h'] }
  for (const [direction, keys] of Object.entries(groups)) for (const key of keys) expect(NAV[key]).toBe(direction as never)
})
