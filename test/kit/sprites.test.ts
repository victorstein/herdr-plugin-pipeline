import { describe, expect, test } from 'bun:test'
import { ACCESSORIES, clawd, drawFrame, framesOf, imageId, registerScene, scenes, spriteKey, spritePng, type Accessory } from '../../src/kit/sprites'

const pixel = (px: Uint8Array, x: number, y: number) => '#' + [...px.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)].map((b) => b.toString(16).padStart(2, '0')).join('')

test('every registered scene, frame, accessory and sweat gets its own image id, and the id decodes back', () => {
  const ids = new Set<number>()
  let count = 0
  for (const scene of scenes()) {
    for (let frame = 0; frame < framesOf(scene); frame++) {
      for (const accessory of ACCESSORIES) {
        for (const sweat of [false, true]) {
          const id = imageId(scene, frame, accessory, sweat)
          ids.add(id)
          count++
          expect(spriteKey(id)).toEqual([scene, frame, accessory, sweat])
        }
      }
    }
  }
  expect(ids.size).toBe(count)
})

test('the built-in scenes keep the ids they had before the registry', () => {
  expect(scenes().slice(0, 6)).toEqual(['blocked', 'working', 'done', 'idle', 'enterDone', 'enterNeeds'])
  expect(imageId('blocked', 0, 'none', false)).toBe(1000)
  expect(imageId('enterNeeds', 5, 'hardhat', true)).toBe(1000 + ((5 * 8 + 5) * 8 + 6) * 2 + 1)
})

describe('registerScene', () => {
  test('a plugin scene gets ids after the built-ins and draws with the exported primitives', () => {
    if (!scenes().includes('test-wave')) registerScene('test-wave', 2, (R, f, look) => clawd(R, 8, 9, 'open', f ? 'wave2' : 'wave1', 'stand', look))
    expect(framesOf('test-wave')).toBe(2)
    expect(spriteKey(imageId('test-wave', 1, 'cap', false))).toEqual(['test-wave', 1, 'cap', false])
    expect(spritePng('test-wave', 1, 'cap', false).length).toBeGreaterThan(0)
  })
  test('a name can be registered once', () => {
    expect(() => registerScene('working', 4, () => {})).toThrow('already registered')
  })
  test('a scene has 1 to 8 frames, because a frame takes 3 bits of the id', () => {
    expect(() => registerScene('too-long', 9, () => {})).toThrow('1 to 8 frames')
  })
  test('an unknown scene is an error, not image 1000', () => {
    expect(() => imageId('nope', 0, 'none', false)).toThrow('unknown scene nope')
  })
  test('a frame the scene does not have is an error, not the next scene\'s image', () => {
    expect(() => imageId('working', 4, 'none', false)).toThrow('has no frame 4')
  })
})

test('frames are 320x192 PNGs, made once', () => {
  const png = spritePng('idle', 3, 'cap', true)
  const view = new DataView(png.buffer, png.byteOffset)
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([320, 192])
  expect(spritePng('idle', 3, 'cap', true)).toBe(png)
})

test('blocked Clawd has open eyes where the logo puts them', () => {
  expect(pixel(drawFrame('blocked', 0, 'none', false), 10, 12)).toBe('#11111b')
})

test('working Clawd sits behind a laptop low enough for a hat', () => {
  const px = drawFrame('working', 0, 'hardhat', false)
  expect(pixel(px, 14, 15)).toBe('#6c7086')
  expect(pixel(px, 12, 3)).toBe('#f9e2af')
})

describe('accessories are bold blocks on the blocked Clawd (body at 6,9)', () => {
  const at = (accessory: Accessory, x: number, y: number) => pixel(drawFrame('blocked', 0, accessory, false), x, y)

  test('glasses: crust frame around a sky lens, eye on top', () => {
    expect(at('glasses', 8, 11)).toBe('#11111b')
    expect(at('glasses', 9, 12)).toBe('#89dceb')
    expect(at('glasses', 10, 12)).toBe('#11111b')
  })
  test('headset: lavender band and ear cup, red mic tip', () => {
    expect(at('headset', 11, 6)).toBe('#b4befe')
    expect(at('headset', 4, 11)).toBe('#b4befe')
    expect(at('headset', 12, 16)).toBe('#f38ba8')
  })
  test('beanie: teal knit dome with a yellow pompom and stripe over a ribbed cuff', () => {
    expect(at('beanie', 17, 2)).toBe('#f9e2af')
    expect(at('beanie', 16, 6)).toBe('#f9e2af')
    expect(at('beanie', 14, 7)).toBe('#94e2d5')
    expect(at('beanie', 8, 9)).toBe('#5fb3a6')
  })
  test('cap: blue crown with a darker brim to the right', () => {
    expect(at('cap', 11, 7)).toBe('#89b4fa')
    expect(at('cap', 25, 8)).toBe('#5b7fc9')
  })
  test('bow: pink loops around a darker knot', () => {
    expect(at('bow', 22, 7)).toBe('#f5c2e7')
    expect(at('bow', 24, 7)).toBe('#d68fbf')
  })
  test('hard hat: yellow dome with a peach stripe', () => {
    expect(at('hardhat', 12, 4)).toBe('#f9e2af')
    expect(at('hardhat', 17, 5)).toBe('#fab387')
  })
  test('none leaves the space above the head empty', () => {
    expect(at('none', 11, 6)).toBe('#000000')
  })
})

test.each([
  ['blocked', 0, 16, 1],
  ['blocked', 1, 16, 0],
  ['working', 0, 18, 0],
  ['idle', 0, 18, 4],
  ['done', 0, 18, 1],
] as const)('the beanie pompom tip is inside the frame in %s frame %d', (scene, frame, x, y) => {
  expect(pixel(drawFrame(scene, frame, 'beanie', false), x, y)).toBe('#f9e2af')
})

test('sweat adds sky drops beside the body', () => {
  const dry = drawFrame('working', 0, 'none', false)
  const wet = drawFrame('working', 0, 'none', true)
  expect(pixel(dry, 6, 9)).not.toBe('#89dceb')
  expect(pixel(wet, 6, 9)).toBe('#89dceb')
})

test('the transitions have six distinct frames', () => {
  for (const scene of ['enterDone', 'enterNeeds'] as const) {
    const frames = new Set(Array.from({ length: 6 }, (_, f) => Buffer.from(drawFrame(scene, f, 'beanie', false)).toString('base64')))
    expect(frames.size).toBe(6)
  }
})
