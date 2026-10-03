import { join } from 'node:path'
import { readJson, withFileLock, writeJson } from './store'

/**
 * `pane_id: null` is a board the supervisor has asked herdr for and not yet
 * heard back about; `shell_pid: null` is one whose `board.ts` has not recorded
 * itself yet. `shell_pid` is how a herdr restart's plain shell, which keeps the
 * label, is told from the board that was there.
 */
export interface BoardRecord {
  pane_id: string | null
  shell_pid: number | null
  opened_at_ms: number
}

export type BoardRegistry = Record<string, BoardRecord>

export const BOARD_PANE_TITLE = 'Board'
/** Longer than `board.ts` takes to start and record itself; a board still booting past this never came up. */
export const BOARD_OPEN_GRACE_MS = 30_000
/** A slug is `<repo>-<hash6>`, so its last seven characters are the dash and the hash. */
const SLUG_HASH_SUFFIX = 7

const boardsPath = (stateDir: string, session: string): string => join(stateDir, `boards.${session}.json`)

export function boardLabel(slug: string): string {
  return `${BOARD_PANE_TITLE}: ${slug.slice(0, -SLUG_HASH_SUFFIX)} ${slug.slice(-(SLUG_HASH_SUFFIX - 1))}`
}

export function isBoardLabel(label: string | null | undefined): boolean {
  return label === BOARD_PANE_TITLE || (label ?? '').startsWith(`${BOARD_PANE_TITLE}: `)
}

export async function readBoards(stateDir: string, session: string): Promise<BoardRegistry> {
  return (await readJson<BoardRegistry>(boardsPath(stateDir, session))) ?? {}
}

/** The supervisor and each board's own process both write here, so every change is read-modify-written under a lock. */
export async function updateBoards(
  stateDir: string, session: string, change: (boards: BoardRegistry) => void,
): Promise<void> {
  const path = boardsPath(stateDir, session)
  await withFileLock(path, async () => {
    const boards = (await readJson<BoardRegistry>(path)) ?? {}
    change(boards)
    await writeJson(path, boards)
  })
}
