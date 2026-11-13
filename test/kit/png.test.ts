import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { crc32, encodePng, enlarge } from '../../src/kit/png'

test('crc32 matches the PNG IEND constant', () => {
  expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082)
})

test('encodePng round-trips its pixels', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0])
  const png = encodePng(rgba, 2, 2)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(png.buffer, png.byteOffset)
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([2, 2])
  const idatLength = view.getUint32(33)
  const raw = inflateSync(png.subarray(41, 41 + idatLength))
  expect([...raw]).toEqual([0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8)])
})

test('enlarge repeats each pixel k by k', () => {
  const big = enlarge(new Uint8Array([9, 8, 7, 255]), 1, 1, 2)
  expect([...big]).toEqual([9, 8, 7, 255, 9, 8, 7, 255, 9, 8, 7, 255, 9, 8, 7, 255])
})
