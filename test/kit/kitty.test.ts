import { expect, test } from 'bun:test'
import { KittyLayer, deleteAllImages, missingImages, transmit } from '../../src/kit/kitty'

const place = (image: number, id = 1, row = 4, col = 2) => `\x1b[${row};${col}H\x1b_Ga=p,i=${image},p=${id},c=6,C=1,q=2\x1b\\`
const remove = (image: number, id = 1) => `\x1b_Ga=d,d=i,i=${image},p=${id},q=2\x1b\\`

test('places new sprites and leaves unchanged ones alone', () => {
  const layer = new KittyLayer(6)
  expect(layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])).toBe(place(100))
  expect(layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])).toBe('')
})

test('a new frame deletes the old placement first', () => {
  const layer = new KittyLayer(6)
  layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])
  expect(layer.sync([{ id: 1, image: 101, row: 4, col: 2 }])).toBe(remove(100) + place(101))
})

test('sprites that disappear are deleted', () => {
  const layer = new KittyLayer(6)
  layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])
  expect(layer.sync([])).toBe(remove(100))
})

test('reset forgets placements a full clear already removed', () => {
  const layer = new KittyLayer(6)
  layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])
  layer.reset()
  expect(layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])).toBe(place(100))
})

test('transmit splits base64 into 4096-byte chunks', () => {
  const sent = transmit(7, new Uint8Array(4000))
  expect(sent.match(/\x1b_G/g)!.length).toBe(2)
  expect(sent.startsWith('\x1b_Ga=t,f=100,i=7,q=2,m=1;')).toBe(true)
  expect(sent).toContain('\x1b_Gm=0;')
  expect(deleteAllImages()).toBe('\x1b_Ga=d,d=A,q=2\x1b\\')
})

test('only images not yet sent since the last clear are transmitted, once each', () => {
  const at = (image: number, id: number) => ({ id, image, row: 1, col: 1 })
  expect(missingImages([at(1000, 1), at(1002, 2), at(1000, 3), at(1004, 4)], new Set([1002]))).toEqual([1000, 1004])
  expect(missingImages([at(1000, 1)], new Set([1000]))).toEqual([])
})

test('replacing all placements after a text redraw re-places them without deleting', () => {
  const layer = new KittyLayer(6)
  layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])
  const out = layer.sync([{ id: 1, image: 100, row: 4, col: 2 }], true)
  expect(out).toContain('a=p,i=100,p=1')
  expect(out).not.toContain('a=d')
})

test('moving a sprite that keeps its image moves it in place, without a delete', () => {
  const layer = new KittyLayer(6)
  layer.sync([{ id: 1, image: 100, row: 4, col: 2 }])
  const out = layer.sync([{ id: 1, image: 100, row: 6, col: 2 }])
  expect(out).toContain('\x1b[6;2H')
  expect(out).not.toContain('a=d')
})
