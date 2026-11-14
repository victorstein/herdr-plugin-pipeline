import { MOCHA } from './palette'
import { encodePng, enlarge } from './png'

export type Scene = string

export const ACCESSORIES = ['none', 'glasses', 'headset', 'beanie', 'cap', 'bow', 'hardhat'] as const
export type Accessory = (typeof ACCESSORIES)[number]

const W = 40
const H = 24
// Pre-enlarged so the terminal never smooths a small image stretched over the cell box.
const SCALE = 8

export type RGB = readonly [number, number, number]
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

export const C = {
  body: hex('#d97757'),
  light: hex('#ea9a7c'),
  dark: hex('#b0533a'),
  eye: hex(MOCHA.crust),
  desk: hex(MOCHA.surface1),
  laptop: hex(MOCHA.surface2),
  lid: hex(MOCHA.overlay0),
  steam: hex(MOCHA.overlay1),
  lavender: hex(MOCHA.lavender),
  mauve: hex(MOCHA.mauve),
  pink: hex(MOCHA.pink),
  pinkDark: hex('#d68fbf'),
  bubble: hex(MOCHA.text),
  red: hex(MOCHA.red),
  blue: hex(MOCHA.blue),
  blueDark: hex('#5b7fc9'),
  yellow: hex(MOCHA.yellow),
  yellowDark: hex('#d9b86a'),
  peach: hex(MOCHA.peach),
  sky: hex('#89dceb'),
  teal: hex('#94e2d5'),
  tealDark: hex('#5fb3a6'),
  mugRim: hex('#fcd2b0'),
  shadow: hex('#151521'),
  confetti: [MOCHA.yellow, MOCHA.green, MOCHA.blue, MOCHA.pink, MOCHA.mauve, MOCHA.peach].map(hex),
}

const BEANIE = [
  '..........ssss..........',
  '.........ssssss.........',
  '.........ssssss.........',
  '..........oooo..........',
  '.....nnnnnnnnnnnnoo.....',
  '...pppppppppppppppppp...',
  '..nnnnnnnnnnnnnnnnnnoo..',
  '.nnnnnnnnnnnnnnnnnnnnoo.',
  'qqrqqrqqrqqrqqrqqrqqrqqr',
  'qqrqqrqqrqqrqqrqqrqqrqqr',
]
const BEANIE_TOP = -8
const BEANIE_INK: Record<string, RGB> = { n: C.teal, q: C.teal, o: C.tealDark, r: C.tealDark, s: C.yellow, p: C.yellow }

export type Rect = (x: number, y: number, w: number, h: number, c: RGB) => void
export type Eyes = 'open' | 'down' | 'closed' | 'happy'
export type Arms = 'stub' | 'rest' | 'wave1' | 'wave2' | 'up'
export interface Look {
  accessory: Accessory
  sweat: boolean
  frame: number
}

function accessory(R: Rect, ox: number, oy: number, eyes: Eyes, kind: Accessory): void {
  if (kind === 'glasses') {
    const ey = eyes === 'down' || eyes === 'closed' ? oy + 4 : oy + 3
    for (const x of [ox + 4, ox + 18]) {
      R(x - 2, ey - 1, 6, 5, C.eye)
      R(x - 1, ey, 4, 3, C.sky)
    }
    R(ox + 7, ey, 9, 1, C.eye)
  }
  if (kind === 'headset') {
    R(ox + 1, oy - 3, 22, 2, C.lavender)
    R(ox - 1, oy - 2, 2, 1, C.lavender)
    R(ox + 23, oy - 2, 2, 1, C.lavender)
    R(ox - 3, oy - 1, 3, 7, C.lavender)
    R(ox + 24, oy - 1, 3, 7, C.lavender)
    R(ox, oy + 7, 6, 1, C.laptop)
    R(ox + 6, oy + 6, 2, 2, C.red)
  }
  if (kind === 'beanie') {
    BEANIE.forEach((row, dy) => [...row].forEach((ink, dx) => {
      const c = BEANIE_INK[ink]
      if (c) R(ox + dx, oy + BEANIE_TOP + dy, 1, 1, c)
    }))
  }
  if (kind === 'cap') {
    R(ox + 3, oy - 3, 18, 3, C.blue)
    R(ox + 11, oy - 4, 2, 1, C.blueDark)
    R(ox + 18, oy - 1, 9, 1, C.blueDark)
  }
  if (kind === 'bow') {
    R(ox + 15, oy - 3, 3, 3, C.pink)
    R(ox + 20, oy - 3, 3, 3, C.pink)
    R(ox + 18, oy - 2, 2, 2, C.pinkDark)
  }
  if (kind === 'hardhat') {
    R(ox + 4, oy - 5, 16, 2, C.yellow)
    R(ox + 2, oy - 3, 20, 2, C.yellow)
    R(ox, oy - 1, 24, 1, C.yellowDark)
    R(ox + 11, oy - 5, 2, 4, C.peach)
  }
}

// Body proportions follow the terminal logo, whose quadrant pixels are about twice as tall as wide.
export function clawd(R: Rect, ox: number, oy: number, eyes: Eyes, arms: Arms, legs: 'stand' | 'tuck' | null, look: Look, h = 12): void {
  const segment = (x: number, y: number, c: RGB = C.body) => R(x, y, 2, 3, c)
  if (arms === 'stub') { R(ox - 2, oy + 6, 2, 3, C.body); R(ox + 24, oy + 6, 2, 3, C.dark) }
  if (arms === 'rest') { R(ox - 3, oy + h - 4, 3, 3, C.body); R(ox + 24, oy + h - 4, 3, 3, C.dark) }
  if (arms === 'wave1' || arms === 'up') { segment(ox - 2, oy + 4); segment(ox - 4, oy + 1); segment(ox - 5, oy - 2) }
  if (arms === 'wave2') { segment(ox - 2, oy + 3); segment(ox - 3, oy); segment(ox - 3, oy - 3) }
  if (arms === 'wave1' || arms === 'wave2') R(ox + 24, oy + 6, 4, 3, C.dark)
  if (arms === 'up') { segment(ox + 24, oy + 4, C.dark); segment(ox + 26, oy + 1, C.dark); segment(ox + 27, oy - 2, C.dark) }
  R(ox, oy, 24, h, C.body)
  R(ox, oy, 24, 1, C.light)
  R(ox, oy + h - 1, 24, 1, C.dark)
  R(ox + 23, oy + 1, 1, h - 1, C.dark)
  // eyes go over the accessory so glasses lenses frame them
  accessory(R, ox, oy, eyes, look.accessory)
  for (const x of [ox + 4, ox + 18]) {
    if (eyes === 'open') R(x, oy + 3, 2, 3, C.eye)
    if (eyes === 'down') R(x, oy + 4, 2, 3, C.eye)
    if (eyes === 'closed') R(x - 1, oy + 5, 4, 1, C.eye)
    if (eyes === 'happy') { R(x - 1, oy + 5, 1, 1, C.eye); R(x, oy + 4, 2, 1, C.eye); R(x + 2, oy + 5, 1, 1, C.eye) }
  }
  for (const x of [2, 6, 16, 20]) {
    if (legs === 'stand') R(ox + x, oy + h, 2, 3, x > 10 ? C.dark : C.body)
    if (legs === 'tuck') R(ox + x, oy + h, 2, 1, C.dark)
  }
  if (look.sweat) {
    const drip = look.frame % 3
    R(ox - 2, oy + 1 + drip, 1, 2, C.sky)
    R(ox + 25, oy + 2 + ((drip + 1) % 3), 1, 2, C.sky)
  }
}

export function zee(R: Rect, x: number, y: number, c: RGB): void {
  R(x, y, 4, 1, c)
  R(x + 2, y + 1, 1, 1, c)
  R(x + 1, y + 2, 1, 1, c)
  R(x, y + 3, 4, 1, c)
}

export function bubble(R: Rect, x: number, y: number, fill: RGB, mark: RGB): void {
  R(x + 1, y, 9, 9, fill)
  R(x, y + 1, 11, 7, fill)
  R(x + 3, y + 9, 2, 1, fill)
  R(x + 4, y + 2, 2, 4, mark)
  R(x + 4, y + 7, 2, 1, mark)
}

export type Draw = (R: Rect, frame: number, look: Look) => void

const BUILT_IN: Record<string, Draw> = {
  working(R, f, look) {
    clawd(R, 8, 8, f === 3 ? 'closed' : 'down', 'stub', null, look)
    R(14, 15, 12, 6, C.laptop)
    R(14, 15, 12, 1, C.lid)
    R(19, 17, 2, 2, f % 2 ? C.lavender : C.blue)
    R(12, 21, 16, 1, C.steam)
    R(10, f % 2 ? 19 : 20, 3, 2, C.body)
    R(27, f % 2 ? 20 : 19, 3, 2, C.dark)
    R(0, 22, 40, 1, C.desk)
    R(2, 23, 2, 1, C.desk)
    R(36, 23, 2, 1, C.desk)
    R(33, 18, 4, 4, C.peach)
    R(33, 18, 4, 1, C.mugRim)
    R(37, 19, 1, 2, C.peach)
    const steam = f % 2 ? [[35, 16], [34, 15], [35, 13]] : [[34, 16], [35, 15], [34, 14]]
    for (const [x, y] of steam) R(x!, y!, 1, 1, C.steam)
  },
  blocked(R, f, look) {
    const up = f % 2 ? -1 : 0
    R(8, 23, 20, 1, C.shadow)
    clawd(R, 6, 9 + up, f === 2 ? 'closed' : 'open', f % 2 ? 'wave2' : 'wave1', 'stand', look)
    bubble(R, 28, up, C.bubble, C.red)
  },
  done(R, f, look) {
    const lift = [0, 3, 1, 0][f]!
    R(9 + lift, 23, 22 - lift * 2, 1, C.shadow)
    for (let i = 0; i < 12; i++) {
      const x = (i * 11 + 3) % 40
      const y = (((i * 5) % 10) + f * 2) % 12
      if (x > 2 && x < 37 && y > 5 - lift) continue
      R(x, y, i % 3 ? 1 : 2, 1, C.confetti[i % C.confetti.length]!)
    }
    clawd(R, 8, 9 - lift, 'happy', 'up', lift ? 'tuck' : 'stand', look)
  },
  idle(R, f, look) {
    const breathe = f === 1 || f === 2
    R(9, 22, 22, 1, C.shadow)
    clawd(R, 8, breathe ? 11 : 12, 'closed', 'rest', null, look, breathe ? 11 : 10)
    zee(R, 33, 8 - f, f < 2 ? C.mauve : C.lavender)
    if (f > 1) zee(R, 35, 3 - (f - 2), C.mauve)
  },
  enterDone(R, f, look) {
    const lift = [0, 3, 6, 3, 1, 0][f]!
    R(9 + lift, 23, 22 - lift * 2, 1, C.shadow)
    clawd(R, 8, 9 - lift, 'happy', 'up', lift ? 'tuck' : 'stand', look)
    const radius = 4 + f * 3.2
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2
      R(Math.round(20 + Math.cos(angle) * radius * 1.7), Math.round(10 + Math.sin(angle) * radius), 2, 1, C.confetti[i % C.confetti.length]!)
    }
  },
  enterNeeds(R, f, look) {
    // the hop hangs at the top for two frames, which also keeps every frame distinct
    const up = [0, -2, -3, -3, -1, 0][f]!
    const flash = f % 2 === 0
    const oy = 9 + up
    R(8, 23, 20, 1, C.shadow)
    if (flash) {
      R(4, oy - 2, 28, 1, C.red)
      R(4, oy + 14, 28, 1, C.red)
      R(4, oy - 2, 1, 17, C.red)
      R(31, oy - 2, 1, 17, C.red)
    }
    clawd(R, 6, oy, 'open', f % 2 ? 'wave2' : 'wave1', 'stand', look)
    bubble(R, f % 2 ? 29 : 27, 0, flash ? C.red : C.bubble, flash ? C.bubble : C.red)
  },
}

interface Registered {
  name: string
  frames: number
  draw: Draw
}

const registry: Registered[] = []

export function registerScene(name: string, frames: number, draw: Draw): void {
  if (registry.some((s) => s.name === name)) throw new Error(`scene ${name} is already registered`)
  // a frame takes 3 bits of the image id
  if (!Number.isInteger(frames) || frames < 1 || frames > 8) throw new Error(`scene ${name} needs 1 to 8 frames`)
  registry.push({ name, frames, draw })
}

// registration order fixes the image ids, so the built-ins go first and in their original order
for (const [name, frames] of [['blocked', 4], ['working', 4], ['done', 4], ['idle', 4], ['enterDone', 6], ['enterNeeds', 6]] as const) {
  registerScene(name, frames, BUILT_IN[name]!)
}

export const scenes = () => registry.map((s) => s.name)

function sceneIndex(name: string): number {
  const index = registry.findIndex((s) => s.name === name)
  if (index < 0) throw new Error(`unknown scene ${name}`)
  return index
}

export const framesOf = (name: string) => registry[sceneIndex(name)]!.frames

export type SpriteKey = [scene: Scene, frame: number, accessory: Accessory, sweat: boolean]

export function imageId(scene: Scene, frame: number, accessory: Accessory, sweat: boolean): number {
  if (!Number.isInteger(frame) || frame < 0 || frame >= framesOf(scene)) throw new Error(`scene ${scene} has no frame ${frame}`)
  return 1000 + ((sceneIndex(scene) * 8 + frame) * 8 + ACCESSORIES.indexOf(accessory)) * 2 + (sweat ? 1 : 0)
}

export function spriteKey(id: number): SpriteKey {
  const n = id - 1000
  return [registry[n >> 7]!.name, (n >> 4) & 7, ACCESSORIES[(n >> 1) & 7]!, (n & 1) === 1]
}

export function drawFrame(scene: Scene, frame: number, accessory: Accessory, sweat: boolean): Uint8Array {
  const px = new Uint8Array(W * H * 4)
  const R: Rect = (x, y, w, h, c) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
        const i = (yy * W + xx) * 4
        px[i] = c[0]
        px[i + 1] = c[1]
        px[i + 2] = c[2]
        px[i + 3] = 255
      }
    }
  }
  registry[sceneIndex(scene)]!.draw(R, frame, { accessory, sweat, frame })
  return px
}

const pngs = new Map<number, Uint8Array>()

export function spritePng(scene: Scene, frame: number, accessory: Accessory, sweat: boolean): Uint8Array {
  const id = imageId(scene, frame, accessory, sweat)
  let png = pngs.get(id)
  if (!png) {
    png = encodePng(enlarge(drawFrame(scene, frame, accessory, sweat), W, H, SCALE), W * SCALE, H * SCALE)
    pngs.set(id, png)
  }
  return png
}
