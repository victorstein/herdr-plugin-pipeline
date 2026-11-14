import { glassKey, glassPng, isGlassImage, type Cell } from './glass'
import { deleteAllImages, KittyLayer, missingImages, transmit, type Placement } from './kitty'
import { SPRITE_COLS } from './render'
import { spriteKey, spritePng } from './sprites'

export function imagePng(id: number, cell: Cell | null): Uint8Array {
  if (!isGlassImage(id)) return spritePng(...spriteKey(id))
  if (!cell) throw new Error('a glass panel needs the cell size')
  return glassPng(...glassKey(id), cell)
}

// glass panels are drawn at the terminal's pixel size, which only CSI 16 t reports
export const CELL_QUERY = '\x1b[16t'
const CELL_REPLY = /\x1b\[6;(\d+);(\d+)t/g

export function takeCellReply(data: string): { rest: string; cell: Cell | null } {
  let cell: Cell | null = null
  const rest = data.replace(CELL_REPLY, (_all, height: string, width: string) => {
    if (Number(width) > 0 && Number(height) > 0) cell = { width: Number(width), height: Number(height) }
    return ''
  })
  return { rest, cell }
}

export class FrameWriter {
  private readonly layer = new KittyLayer(SPRITE_COLS)
  private readonly sent = new Set<number>()
  private lastText = ''
  private needsClear = true
  cell: Cell | null = null

  invalidate(): void {
    this.needsClear = true
  }

  setCell(cell: Cell): boolean {
    if (cell.width === this.cell?.width && cell.height === this.cell?.height) return false
    this.cell = cell
    this.needsClear = true
    return true
  }

  write(frame: { text: string; placements: Placement[] }): string {
    let screen = ''
    let textRedrawn = false
    if (this.needsClear) {
      // herdr's pane emulator drops kitty image data on a full clear, so every image must be sent again after one
      screen += deleteAllImages() + '\x1b[2J' + frame.text
      this.layer.reset()
      this.sent.clear()
      this.needsClear = false
      this.lastText = frame.text
    } else if (frame.text !== this.lastText) {
      // the renderer writes every board cell exactly once, so overwriting in place needs no erase; clearing first
      // flashed the tinted board on every cursor move
      screen += frame.text
      textRedrawn = true
      this.lastText = frame.text
    }
    const missing = missingImages(frame.placements, this.sent)
    for (const id of missing) this.sent.add(id)
    return screen + missing.map((id) => transmit(id, imagePng(id, this.cell))).join('') + this.layer.sync(frame.placements, textRedrawn)
  }
}
