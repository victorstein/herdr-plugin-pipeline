import type { Task, TaskPhase } from '../lib/types'
import { C, clawd, registerScene, type Eyes, type Look, type Rect, type RGB } from '../kit/sprites'
import { MOCHA } from '../kit/palette'

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

const P = {
  paper: hex('#f5e0dc'),
  paperDark: hex('#d9b8b2'),
  ink: hex(MOCHA.surface2),
  green: hex(MOCHA.green),
  cork: hex('#c98a5b'),
  corkDark: hex('#94603d'),
  board: hex('#6e4a33'),
  box: hex(MOCHA.peach),
  boxDark: hex('#c98a5b'),
  boxLight: hex('#fcd2b0'),
  tape: hex(MOCHA.text),
  brass: hex(MOCHA.yellow),
  brassDark: hex('#d9b86a'),
  belt: hex(MOCHA.surface1),
  rail: hex(MOCHA.overlay1),
  ghost: hex('#8a5546'),
  ghostHat: hex('#a89670'),
}

function desk(R: Rect): void {
  R(0, 22, 40, 1, C.desk)
  R(2, 23, 2, 1, C.desk)
  R(36, 23, 2, 1, C.desk)
}

// drawn after clawd, so the eyes are drawn again on top of the lenses
function glasses(R: Rect, ox: number, oy: number, eyes: Eyes): void {
  const ey = eyes === 'down' || eyes === 'closed' ? oy + 4 : oy + 3
  for (const x of [ox + 4, ox + 18]) {
    R(x - 2, ey - 1, 6, 5, C.eye)
    R(x - 1, ey, 4, 3, C.sky)
    if (eyes === 'down') R(x, oy + 4, 2, 3, C.eye)
    if (eyes === 'open') R(x, oy + 3, 2, 3, C.eye)
  }
  R(ox + 7, ey, 9, 1, C.eye)
}

// clawd draws its eyes in fixed spots; this paints them over and looks up and to the right
function lookUpRight(R: Rect, ox: number, oy: number): void {
  for (const x of [ox + 4, ox + 18]) {
    R(x, oy + 3, 2, 3, C.body)
    R(x + 1, oy + 2, 2, 3, C.eye)
  }
}

function tick(R: Rect, x: number, y: number, c: RGB = P.green): void {
  R(x, y + 1, 1, 1, c)
  R(x + 1, y + 2, 1, 1, c)
  R(x + 2, y + 1, 1, 1, c)
  R(x + 3, y, 1, 1, c)
}

function bigTick(R: Rect, x: number, y: number, c: RGB = P.green): void {
  R(x, y + 2, 2, 2, c)
  R(x + 2, y + 3, 2, 2, c)
  R(x + 4, y + 1, 2, 2, c)
  R(x + 6, y, 2, 1, c)
}

function bigCross(R: Rect, x: number, y: number, c: RGB = C.red): void {
  R(x, y, 2, 2, c)
  R(x + 4, y, 2, 2, c)
  R(x + 2, y + 2, 2, 2, c)
  R(x, y + 4, 2, 2, c)
  R(x + 4, y + 4, 2, 2, c)
}

// the dark outline keeps the peach box from fusing with Clawd's orange body
function box(R: Rect, x: number, y: number, w: number, h: number): void {
  R(x - 1, y - 1, w + 2, h + 2, C.shadow)
  R(x, y, w, h, P.box)
  R(x, y, w, 1, P.boxLight)
  R(x + w - 1, y + 1, 1, h - 1, P.boxDark)
  R(x, y + h - 1, w, 1, P.boxDark)
}

// kept below the eye row (y 12–14) so a seated Clawd's face stays visible
function scroll(R: Rect, lines: number[]): void {
  R(11, 16, 18, 6, P.paper)
  R(11, 21, 18, 1, P.paperDark)
  R(9, 15, 3, 7, P.paperDark)
  R(28, 15, 3, 7, P.paperDark)
  R(10, 14, 1, 1, P.corkDark)
  R(29, 14, 1, 1, P.corkDark)
  lines.forEach((w, i) => w > 0 && R(13, 17 + i * 2, w, 1, P.ink))
}

const sitting = (R: Rect, look: Look, eyes: Eyes = 'down') => clawd(R, 8, 8, eyes, 'stub', null, look)

const SCENES: Record<string, (R: Rect, f: number, look: Look) => void> = {
  research(R, f, look) {
    sitting(R, look)
    R(10, 15, 21, 7, C.blueDark)
    R(11, 15, 9, 5, P.paper)
    R(21, 15, 9, 5, P.paper)
    R(20, 15, 1, 7, C.shadow)
    for (const x of [12, 22]) for (const [dy, w] of [[1, 6], [3, 7]] as const) R(x, 15 + dy, w, 1, P.ink)
    // the lens sits off the page so it breaks the silhouette instead of reading as a monocle
    const [cx, cy] = ([[31, 15], [33, 14], [35, 15], [33, 16]] as const)[f]!
    const round = (x: number, y: number, size: number, c: RGB) => {
      R(x + 1, y, size - 2, size, c)
      R(x, y + 1, size, size - 2, c)
    }
    round(cx - 3, cy - 3, 7, C.eye)
    round(cx - 2, cy - 2, 5, P.brass)
    R(cx - 1, cy - 1, 3, 3, P.paper)
    R(cx - 1, cy, 3, 1, P.ink)
    R(cx + 3, cy + 3, 2, 2, P.corkDark)
    R(cx + 4, cy + 5, 3, 2, C.dark)
    R(9, 18, 3, 2, C.body)
    desk(R)
  },
  spec(R, f, look) {
    sitting(R, look)
    const lines = [[6, 0], [11, 0], [15, 4], [15, 9]][f]!
    scroll(R, lines)
    const row = lines[1]! > 0 ? 1 : 0
    const tx = 13 + lines[row]!
    const ty = 17 + row * 2
    R(tx, ty, 1, 1, C.eye)
    R(tx + 1, ty - 1, 1, 1, C.lid)
    R(tx + 2, ty - 4, 3, 3, C.bubble)
    R(tx + 3, ty - 7, 3, 3, C.bubble)
    R(tx + 5, ty - 9, 2, 2, C.bubble)
    for (let k = 0; k < 4; k++) R(tx + 2 + k, ty - 2 - k * 2, 1, 1, C.lavender)
    R(tx + 2, ty, 3, 2, C.dark)
    R(9, 18, 3, 2, C.body)
    desk(R)
  },
  'spec-review'(R, f, look) {
    sitting(R, look)
    glasses(R, 8, 8, 'down')
    scroll(R, [12, 14])
    // a verdict is always up, because frame 0 is the one a glance usually catches
    const pop = f === 1 || f === 2 ? -1 : 0
    if (f === 2) bigCross(R, 32, 1 + pop)
    else bigTick(R, 31, 2 + pop)
    R(9, 18, 3, 2, C.body)
    R(29, 18, 3, 2, C.dark)
    desk(R)
  },
  plan(R, f, look) {
    R(27, 2, 13, 15, P.corkDark)
    R(28, 3, 11, 13, P.cork)
    clawd(R, 1, 9, 'open', 'stub', 'stand', look)
    lookUpRight(R, 1, 9)
    const card = (x: number, y: number, c: RGB) => {
      R(x, y, 4, 3, c)
      R(x + 1, y - 1, 2, 1, C.red)
    }
    card(29, 5, C.yellow)
    card(34, 5, C.blue)
    R(33, 6, 1, 1, C.lavender)
    if (f >= 1) R(31, 8, 1, 3, C.lavender)
    const pinned: [number, number] = [29, 11]
    if (f >= 2) card(pinned[0], pinned[1], C.pink)
    if (f >= 3) R(34, 9, 1, 3, C.lavender)
    const hand: [number, number] = f === 0 ? [30, 13] : f === 1 ? [29, 12] : [30, 13]
    R(25, 13, 2, 3, C.dark)
    R(26, hand[1] + 1, 2, 2, C.dark)
    if (f < 2) card(hand[0] - 1, hand[1] - 2, C.pink)
    R(hand[0], hand[1], 3, 2, C.dark)
  },
  'plan-review'(R, f, look) {
    sitting(R, look)
    glasses(R, 8, 8, 'down')
    R(11, 15, 18, 7, C.shadow)
    R(12, 16, 16, 6, P.board)
    R(14, 17, 12, 4, P.paper)
    R(17, 15, 6, 2, C.eye)
    R(18, 15, 4, 1, C.lid)
    for (let i = 0; i < 2; i++) {
      const y = 17 + i * 2
      R(15, y, 2, 1, i <= f - 1 || f === 3 ? P.green : P.paperDark)
      R(18, y, [6, 5][i]!, 1, P.ink)
    }
    if (f >= 2) bigTick(R, 31, f === 2 ? 1 : 2)
    R(10, 18, 3, 2, C.body)
    R(27, 18, 3, 2, C.dark)
    desk(R)
  },
  'pr-review'(R, f, look) {
    sitting(R, look)
    glasses(R, 8, 8, 'down')
    R(11, 15, 18, 7, P.paper)
    const rows: [RGB | null, number][] = [[null, 10], [C.red, 12], [C.red, 9], [P.green, 13], [P.green, 11], [null, 8]]
    const scanned = [0, 2, 4, 3][f]!
    rows.forEach(([c, w], i) => {
      const y = 16 + i
      if (i >= 5) return
      if (c) R(12, y, 1, 1, c)
      R(14, y, w, 1, c ?? P.ink)
      if (i === scanned) {
        R(9, y, 2, 1, C.lavender)
        R(29, y, 2, 1, C.lavender)
        R(14 + w, y, 1, 1, C.lavender)
      }
    })
    R(9, 19, 3, 2, C.body)
    R(29, 19, 3, 2, C.dark)
    desk(R)
  },
  ci(R, f, look) {
    clawd(R, 1, 9, f === 3 ? 'closed' : 'open', 'rest', 'stand', look)
    if (f !== 3) lookUpRight(R, 1, 9)
    R(27, 3, 12, 5, C.lid)
    R(28, 4, 10, 3, C.shadow)
    R(28, 4, [3, 5, 8, 10][f]!, 3, P.green)
    const gear = (cx: number, cy: number, turn: number, c: RGB) => {
      R(cx - 2, cy - 2, 5, 5, c)
      R(cx, cy, 1, 1, C.eye)
      const teeth = turn % 2 ? [[-3, -3], [3, -3], [-3, 3], [3, 3]] : [[0, -3], [0, 3], [-3, 0], [3, 0]]
      for (const [dx, dy] of teeth) R(cx + dx!, cy + dy!, 1, 1, c)
    }
    gear(31, 13, f, C.lavender)
    gear(36, 18, f + 1, C.lid)
  },
  'land-queue'(R, f, look) {
    const bob = f % 2 ? -1 : 0
    R(0, 22, 40, 1, C.desk)
    // the one ahead in line, cut by the edge, inching forward
    const gx = 31 + [0, 0, 1, 1][f]!
    R(gx + 2, 5, 12, 2, P.ghostHat)
    R(gx, 7, 14, 1, P.ghostHat)
    R(gx, 8, 14, 11, P.ghost)
    for (const x of [2, 6]) R(gx + x, 19, 2, 3, P.ghost)
    clawd(R, 1, 7 + bob, f === 2 ? 'closed' : 'open', 'stub', 'stand', look)
    box(R, 7, 12 + bob, 12, 9)
    R(5, 15 + bob, 3, 2, C.body)
    R(18, 15 + bob, 3, 2, C.dark)
    R(27, 12, 2, 10, C.lid)
    R(26, 11, 4, 1, C.lavender)
    R(26, 21, 4, 1, C.lid)
    const sag = [1, 2, 1, 0][f]!
    for (let x = 29; x < 40; x++) {
      const mid = 1 - Math.abs(x - 34) / 6
      R(x, 13 + Math.round(sag * mid), 1, 1, C.red)
    }
  },
  sync(R, f, look) {
    clawd(R, 1, 9, 'open', 'rest', 'stand', look)
    lookUpRight(R, 1, 9)
    box(R, 27, 14, 11, 8)
    const at = (a: number, r: number): [number, number] => [Math.round(32 + Math.cos(a) * r * 1.4), Math.round(7 + Math.sin(a) * r)]
    const arrow = (angle: number, c: RGB) => {
      for (let k = 0; k < 9; k++) {
        const [x, y] = at(angle - k * 0.28, 5)
        R(x, y, 2, 1, c)
      }
      const [hx, hy] = at(angle + 0.25, 5)
      const [ix, iy] = at(angle, 3.5)
      const [ox, oy] = at(angle, 6.5)
      R(hx, hy, 2, 2, c)
      R(ix, iy, 1, 1, c)
      R(ox, oy, 1, 1, c)
    }
    const turn = (f * Math.PI) / 2
    arrow(turn, C.blue)
    arrow(turn + Math.PI, P.green)
  },
  merge(R, f, look) {
    clawd(R, 0, 6, 'down', 'stub', 'stand', look)
    // two belts of the same value meeting in a Y, so the join reads as a merge
    for (let i = 0; i < 9; i++) {
      R(39 - i, 8 + i, 1, 4, P.belt)
      R(39 - i, 8 + i, 1, 1, P.rail)
      R(39 - i, 11 + i, 1, 1, P.rail)
    }
    R(12, 18, 28, 4, P.belt)
    R(12, 18, 28, 1, P.rail)
    R(12, 21, 28, 1, P.rail)
    for (let x = 12 + (f % 4); x < 40; x += 4) R(x, 20, 2, 1, C.lid)
    const x = [15, 18, 21, 24][f]!
    box(R, x, 12, 7, 6)
    const incoming = [[35, 6], [33, 8], [31, 10], [33, 15]][f]!
    box(R, incoming[0]!, incoming[1]!, 4, 3)
    R(23, 13, 2, 2, C.dark)
    R(x - 2, 14, 2, 2, C.dark)
    R(33, 1, 1, 2, C.lavender)
    R(37, 1, 1, 2, C.lavender)
    R(34, 3, 1, 1, C.lavender)
    R(36, 3, 1, 1, C.lavender)
    R(35, 4, 1, 2, C.lavender)
  },
  close(R, f, look) {
    clawd(R, 8, 6, f === 3 ? 'happy' : 'down', 'stub', null, look)
    box(R, 11, 13, 18, 9)
    R(11, 13, 8, 1, P.boxLight)
    R(21, 13, 8, 1, P.boxLight)
    const len = [3, 5, 7, 9][f]!
    R(19, 13, 2, len, P.tape)
    if (f < 3) {
      const ry = Math.min(12 + len, 16)
      R(21, ry, 5, 5, P.tape)
      R(22, ry + 1, 3, 3, C.lid)
      R(23, ry + 2, 1, 1, C.shadow)
      R(26, ry + 1, 3, 2, C.dark)
    } else bigTick(R, 31, 1)
    R(9, 16, 3, 2, C.body)
    desk(R)
  },
}

export const PIPELINE_SCENES = Object.keys(SCENES)

for (const [name, draw] of Object.entries(SCENES)) registerScene(name, 4, draw)

const PHASE_SCENE: Partial<Record<TaskPhase, string>> = {
  research: 'research', spec: 'spec', 'spec-review': 'spec-review', plan: 'plan', 'plan-review': 'plan-review',
  implement: 'working', 'pr-review': 'pr-review', 'pr-review-intent': 'pr-review', 'pr-review-quality': 'pr-review',
  ci: 'ci', 'land-queue': 'land-queue', sync: 'sync', merge: 'merge', close: 'close', teardown: 'close',
}

export function sceneFor(task: Pick<Task, 'phase' | 'decision_from'>): string {
  return PHASE_SCENE[task.phase] ?? (task.decision_from ? PHASE_SCENE[task.decision_from] : undefined) ?? 'working'
}
