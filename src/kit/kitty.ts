export interface Placement {
  id: number
  image: number
  row: number
  col: number
  cols?: number
  rows?: number
  z?: number
}

const apc = (body: string) => `\x1b_G${body}\x1b\\`
const CHUNK = 4096

export function transmit(id: number, png: Uint8Array): string {
  const b64 = Buffer.from(png).toString('base64')
  let out = ''
  for (let i = 0; i < b64.length; i += CHUNK) {
    const more = i + CHUNK < b64.length ? 1 : 0
    out += apc(`${i === 0 ? `a=t,f=100,i=${id},q=2,` : ''}m=${more};${b64.slice(i, i + CHUNK)}`)
  }
  return out
}

export const missingImages = (placements: Placement[], sent: ReadonlySet<number>) => [...new Set(placements.map((p) => p.image))].filter((id) => !sent.has(id))

export const deleteAllImages = () => apc('a=d,d=A,q=2')

export class KittyLayer {
  private shown = new Map<number, Placement>()

  constructor(private readonly cols: number) {}

  reset(): void {
    this.shown.clear()
  }

  // replaceAll re-places even unchanged sprites, for after text was redrawn over them in place
  sync(next: Placement[], replaceAll = false): string {
    let out = ''
    const wanted = new Set(next.map((p) => p.id))
    for (const [id, p] of this.shown) {
      if (wanted.has(id)) continue
      out += apc(`a=d,d=i,i=${p.image},p=${id},q=2`)
      this.shown.delete(id)
    }
    for (const p of next) {
      const prev = this.shown.get(p.id)
      if (!replaceAll && prev && prev.image === p.image && prev.row === p.row && prev.col === p.col) continue
      // placement ids are scoped per image, so a different frame's placement must be deleted explicitly;
      // the same image and id is simply replaced in place
      if (prev && prev.image !== p.image) out += apc(`a=d,d=i,i=${prev.image},p=${p.id},q=2`)
      const keys = [`a=p,i=${p.image},p=${p.id}`, `c=${p.cols ?? this.cols}`, p.rows ? `r=${p.rows}` : '', p.z ? `z=${p.z}` : '', 'C=1,q=2']
      out += `\x1b[${p.row};${p.col}H` + apc(keys.filter(Boolean).join(','))
      this.shown.set(p.id, p)
    }
    return out
  }
}
