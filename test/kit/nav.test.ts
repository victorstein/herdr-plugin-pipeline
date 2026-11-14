import { expect, test } from 'bun:test'
import { locate, moveCursor } from '../../src/kit/nav'
import { ids } from './fixtures'

const b = ids({ needs: ['n1'], working: ['w1', 'w2'], idle: ['i1'] })

test('up and down stay in the column and clamp', () => {
  expect(moveCursor(b, 'w1', 'down')).toBe('w2')
  expect(moveCursor(b, 'w2', 'down')).toBe('w2')
  expect(moveCursor(b, 'w2', 'up')).toBe('w1')
})

test('left and right skip empty columns and keep the row when they can', () => {
  expect(moveCursor(b, 'w2', 'right')).toBe('i1')
  expect(moveCursor(b, 'n1', 'right')).toBe('w1')
  expect(moveCursor(b, 'n1', 'left')).toBe('n1')
})

test('a cursor on a card that is gone lands on the first card', () => {
  expect(moveCursor(b, 'gone', 'down')).toBe('n1')
  expect(moveCursor(ids({}), null, 'down')).toBeNull()
})

test('locate finds a card by id', () => {
  expect(locate(b, 'w2')).toEqual({ col: 1, row: 1 })
  expect(locate(b, null)).toBeNull()
})
