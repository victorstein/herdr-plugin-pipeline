export type Column = 'needs' | 'working' | 'done' | 'idle'
export const COLUMNS: Column[] = ['needs', 'working', 'done', 'idle']

export interface Identified {
  id: string
}
export type Board<T extends Identified = Identified> = Record<Column, T[]>
export type Direction = 'left' | 'right' | 'up' | 'down'

export function locate(board: Board, id: string | null): { col: number; row: number } | null {
  for (let col = 0; col < COLUMNS.length; col++) {
    const row = board[COLUMNS[col]!].findIndex((c) => c.id === id)
    if (row >= 0) return { col, row }
  }
  return null
}

function firstCard(board: Board): string | null {
  for (const column of COLUMNS) {
    const first = board[column][0]
    if (first) return first.id
  }
  return null
}

export function moveCursor(board: Board, id: string | null, direction: Direction): string | null {
  const at = locate(board, id)
  if (!at) return firstCard(board)
  if (direction === 'up' || direction === 'down') {
    const list = board[COLUMNS[at.col]!]
    const row = Math.max(0, Math.min(list.length - 1, at.row + (direction === 'down' ? 1 : -1)))
    return list[row]!.id
  }
  const step = direction === 'right' ? 1 : -1
  for (let col = at.col + step; col >= 0 && col < COLUMNS.length; col += step) {
    const list = board[COLUMNS[col]!]
    if (list.length) return list[Math.min(at.row, list.length - 1)]!.id
  }
  return id
}
