import { expect, test } from 'bun:test'
import { glassImageId, glassKey, glassPixels, isGlassImage } from '../../src/kit/glass'
import { imageId } from '../../src/kit/sprites'

const cell = { width: 10, height: 20 }
const alpha = (px: Uint8Array, w: number, x: number, y: number) => px[(y * w + x) * 4 + 3]!

test('glass ids round-trip and never collide with sprite ids', () => {
  for (const [cols, selected] of [[30, false], [30, true], [7, true]] as const) {
    const id = glassImageId(cols, selected)
    expect(isGlassImage(id)).toBe(true)
    expect(glassKey(id)).toEqual([cols, selected])
  }
  expect(isGlassImage(imageId('enterNeeds', 5, 'hardhat', true))).toBe(false)
})

test('a panel spans the card with rounded corners and a transparent gap above and below', () => {
  const w = 30 * cell.width
  const px = glassPixels(30, false, cell)
  expect(px.length).toBe(w * 4 * cell.height * 4)
  expect(alpha(px, w, w / 2, cell.height / 2)).toBe(0)
  expect(alpha(px, w, w / 2, 3.5 * cell.height - 1)).toBe(0)
  expect(alpha(px, w, w / 2, cell.height / 2 + 4)).toBeGreaterThan(0)
  expect(alpha(px, w, w / 2, 2 * cell.height)).toBeGreaterThan(0)
  expect(alpha(px, w, 1, cell.height / 2 + 3)).toBe(0)
})

test('the selected panel is frosted more heavily instead of outlined', () => {
  const w = 30 * cell.width
  const middle = (selected: boolean) => alpha(glassPixels(30, selected, cell), w, w / 2, 2 * cell.height)
  expect(middle(true)).toBeGreaterThan(middle(false) * 1.5)
})
