import { encodePng } from './png'

export interface Cell {
  width: number
  height: number
}

// the panel reaches half a row above and below a card's two text rows; the image spans whole rows (the one above
// to the gap row below) and is stretched to fit them, because herdr's reported cell size runs about 10% small and
// its pixel offsets shrink a stretched image
export const GLASS_ROWS = 4

const GLASS_BASE = 100_000
const FROST = [205, 214, 244]
const FROST_SELECTED = [192, 202, 250]

export const glassImageId = (cols: number, selected: boolean) => GLASS_BASE + cols * 2 + (selected ? 1 : 0)
export const isGlassImage = (id: number) => id >= GLASS_BASE
export const glassKey = (id: number): [number, boolean] => [Math.floor((id - GLASS_BASE) / 2), (id - GLASS_BASE) % 2 === 1]

export function glassPixels(cols: number, selected: boolean, cell: Cell): Uint8Array {
  const w = cols * cell.width
  const h = GLASS_ROWS * cell.height
  const px = new Uint8Array(w * h * 4)
  // a card has a row of height to spare: a thin inset keeps stacked panels apart and gives the rest to padding
  const inset = Math.max(1, Math.round(cell.height / 10))
  const r = Math.max(3, Math.round(cell.height * 0.35))
  const half = Math.round(cell.height / 2)
  const [x0, y0, x1, y1] = [1, half + inset, w - 2, h - 1 - half - inset]
  const [top, bottom, highlight, edgeAlpha] = selected ? [0.24, 0.17, 0.42, 0.3] : [0.11, 0.06, 0.28, 0.2]
  const color = selected ? FROST_SELECTED : FROST
  // a fixed seed keeps the grain identical between transmits
  let seed = 7
  const grain = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.03
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r)
      const cy = Math.min(Math.max(y, y0 + r), y1 - r)
      const edge = r - Math.hypot(x - cx, y - cy)
      if (edge < 0) continue
      let a = top - (top - bottom) * ((y - y0) / (y1 - y0)) + grain()
      if (edge < 1.2) a = edgeAlpha
      else if (y <= y0 + 1) a = highlight
      const i = (y * w + x) * 4
      px.set([color[0]!, color[1]!, color[2]!, Math.round(Math.min(1, Math.max(0, a)) * 255)], i)
    }
  }
  return px
}

export const glassPng = (cols: number, selected: boolean, cell: Cell) =>
  encodePng(glassPixels(cols, selected, cell), cols * cell.width, GLASS_ROWS * cell.height)
