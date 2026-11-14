import type { Direction } from '../kit/nav'

export const NAV: Record<string, Direction> = {
  h: 'left', l: 'right', j: 'down', k: 'up',
  '\x1b[D': 'left', '\x1b[C': 'right', '\x1b[B': 'down', '\x1b[A': 'up',
  // herdr forwards arrows to a pane as SS3. Measured on herdr 0.9.1.
  '\x1bOD': 'left', '\x1bOC': 'right', '\x1bOB': 'down', '\x1bOA': 'up',
}

// a complete CSI sequence (ECMA-48), SS3 plus one letter, or one code point
const KEY = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1bO[A-Za-z]|[\s\S]/gu

// herdr and a held key both deliver several keys in one stdin chunk
export function splitKeys(chunk: string): string[] {
  return chunk.match(KEY) ?? []
}
