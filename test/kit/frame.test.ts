import { expect, test } from 'bun:test'
import { CELL_QUERY, FrameWriter, imagePng, takeCellReply } from '../../src/kit/frame'
import { glassImageId } from '../../src/kit/glass'
import { imageId } from '../../src/kit/sprites'

const sprite = imageId('idle', 0, 'none', false)
const frame = (text: string, image = sprite) => ({ text, placements: [{ id: 1, image, row: 4, col: 3 }] })

test('the first write clears the screen, sends each image once and places it', () => {
  const writer = new FrameWriter()
  const out = writer.write(frame('A'))
  expect(out.startsWith('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2JA')).toBe(true)
  expect(out).toContain(`a=t,f=100,i=${sprite}`)
  expect(out).toContain(`a=p,i=${sprite},p=1`)
})

test('an unchanged frame writes nothing; changed text is overwritten in place, without a clear', () => {
  const writer = new FrameWriter()
  writer.write(frame('A'))
  expect(writer.write(frame('A'))).toBe('')
  const out = writer.write(frame('B'))
  expect(out.startsWith('B')).toBe(true)
  expect(out).not.toContain('\x1b[2J')
  expect(out).not.toContain('a=t,')
})

test('invalidate forces a full clear and re-sends the images', () => {
  const writer = new FrameWriter()
  writer.write(frame('A'))
  writer.invalidate()
  const out = writer.write(frame('A'))
  expect(out).toContain('\x1b[2J')
  expect(out).toContain(`a=t,f=100,i=${sprite}`)
})

test('a new cell size invalidates; the same size does not', () => {
  const writer = new FrameWriter()
  expect(writer.setCell({ width: 10, height: 20 })).toBe(true)
  writer.write(frame('A'))
  expect(writer.setCell({ width: 10, height: 20 })).toBe(false)
  expect(writer.write(frame('A'))).toBe('')
  expect(writer.setCell({ width: 11, height: 22 })).toBe(true)
  expect(writer.write(frame('A'))).toContain('\x1b[2J')
})

test('cell-size replies are taken out of terminal input', () => {
  expect(CELL_QUERY).toBe('\x1b[16t')
  expect(takeCellReply('j\x1b[6;20;10tk')).toEqual({ rest: 'jk', cell: { width: 10, height: 20 } })
  expect(takeCellReply('j')).toEqual({ rest: 'j', cell: null })
  expect(takeCellReply('\x1b[6;0;0t')).toEqual({ rest: '', cell: null })
})

test('imagePng draws glass at the cell size and sprites without one', () => {
  expect(imagePng(sprite, null).length).toBeGreaterThan(0)
  expect(imagePng(glassImageId(30, false), { width: 10, height: 20 }).length).toBeGreaterThan(0)
  expect(() => imagePng(glassImageId(30, false), null)).toThrow('cell size')
})
