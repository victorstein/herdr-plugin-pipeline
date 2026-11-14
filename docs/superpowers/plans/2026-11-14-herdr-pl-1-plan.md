# herdr-pl-1 plan — board arrow keys and multi-key input

Spec: `docs/superpowers/specs/2026-11-14-herdr-pl-1-design.md` (cleared review pass 0).

FILES: src/board/keys.ts, test/board-keys.test.ts, src/board/ui.ts, src/board/view.ts, test/board-view.test.ts

Rules for every step:
- Work in `/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/feat-board-arrow-keys` on branch
  `feat/board-arrow-keys`. Commit, never push.
- Never edit anything under `src/kit/` or `test/kit/` (overwritten by `scripts/sync-kit.ts`).
- Re-read each file before you edit it: a sibling task may have changed it since this plan was written.
- Comments carry a non-obvious "why" only. Do not add comments that restate the code.
- Commit messages are conventional and end with the session line:
  `Claude-Session: https://claude.ai/code/session_01F3fK9f8iHgvzjABybycxgZ`

## Step 1 — failing tests for the splitter and key table

Create `test/board-keys.test.ts` (modelled on `test/board-view.test.ts`):

```ts
import { expect, test } from 'bun:test'
import { NAV, splitKeys } from '../src/board/keys'

test('splitKeys cuts a chunk into single keys', () => {
  expect(splitKeys('\x1bOD\x1bOC')).toEqual(['\x1bOD', '\x1bOC'])
  expect(splitKeys('\x1b[A')).toEqual(['\x1b[A'])
  expect(splitKeys('hj')).toEqual(['h', 'j'])
  expect(splitKeys('\x1b')).toEqual(['\x1b'])
})

test('splitKeys splits the chunk herdr 0.9.1 sends for send-keys left right up down enter tab', () => {
  expect(splitKeys('\u001bOD\u001bOC\u001bOA\u001bOB\n\t')).toEqual(['\x1bOD', '\x1bOC', '\x1bOA', '\x1bOB', '\n', '\t'])
})

test('splitKeys keeps a parameterised CSI whole and returns nothing for an empty chunk', () => {
  expect(splitKeys('\x1b[1;5A')).toEqual(['\x1b[1;5A'])
  expect(splitKeys('')).toEqual([])
})

test('splitKeys splits an alt-chord and keeps a non-BMP character whole', () => {
  expect(splitKeys('\x1bx')).toEqual(['\x1b', 'x'])
  expect(splitKeys('😀a')).toEqual(['😀', 'a'])
})

test('NAV maps the CSI arrow, the SS3 arrow and hjkl to the same direction', () => {
  const groups = { up: ['\x1b[A', '\x1bOA', 'k'], down: ['\x1b[B', '\x1bOB', 'j'], right: ['\x1b[C', '\x1bOC', 'l'], left: ['\x1b[D', '\x1bOD', 'h'] }
  for (const [direction, keys] of Object.entries(groups)) for (const key of keys) expect(NAV[key]).toBe(direction as never)
})
```

Run: `bun test test/board-keys.test.ts` — expect failure (module `../src/board/keys` not found).

## Step 2 — the module

Create `src/board/keys.ts`:

```ts
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
```

Run: `bun test test/board-keys.test.ts` — all 5 pass. Run `bunx tsc --noEmit` — clean.

Commit: `feat(board): key splitter and table with SS3 arrows`

## Step 3 — wire the board UI to it

Edit `src/board/ui.ts`:

1. Delete the local table (currently lines 28-31):
   ```ts
   const NAV: Record<string, Direction> = {
     h: 'left', l: 'right', j: 'down', k: 'up',
     '\x1b[D': 'left', '\x1b[C': 'right', '\x1b[B': 'down', '\x1b[A': 'up',
   }
   ```
2. Change the nav import (line 4) from
   `import { COLUMNS, moveCursor, type Column, type Direction } from '../kit/nav'` to
   `import { COLUMNS, moveCursor, type Column } from '../kit/nav'`
   (`Direction` is now unused in `ui.ts`; check with `grep -n Direction src/board/ui.ts` before
   removing it — keep it if anything else still uses it).
3. Add, next to the other `./` imports (after `import { buildBoard } from './model'`):
   `import { NAV, splitKeys } from './keys'`
4. In the stdin `data` handler, replace
   `    if (rest) onKey(rest)` with
   `    if (rest) for (const key of splitKeys(rest)) onKey(key)`
   Leave `takeCellReply` first and the `else draw()` branch as they are.

There is no unit harness for `runBoardUi`; the spec accepts that. Run `bunx tsc --noEmit` and
`bun test` — both green.

Commit: `fix(board): handle each key of a stdin chunk on its own`

## Step 4 — keys hint (test first)

Edit `test/board-view.test.ts`: change
`  expect(KEYS).toBe('hjkl move  space peek  o orchestrator  d details  x clear')` to
`  expect(KEYS).toBe('←↓↑→/hjkl move  space peek  o orchestrator  d details  x clear')`

Run: `bun test test/board-view.test.ts` — expect 1 failure on `KEYS`.

Edit `src/board/view.ts` line 9 to:
`export const KEYS = '←↓↑→/hjkl move  space peek  o orchestrator  d details  x clear'`

Run: `bun test test/board-view.test.ts` — passes.

Commit: `feat(board): show arrow keys in the keys hint`

## Step 5 — full gate

Run `bunx tsc --noEmit` and `bun test`. Both must be green; report the counts. Confirm
`git status --short -- src/kit test/kit` prints nothing.

## After implementation (orchestrating worker, not the subagent)

Live check from the spec, on a herdr 0.9.1 board whose cursor starts on a column with at least three
cards beside a non-empty column to its right:
1. `herdr pane send-keys <pane> down` — the cursor moves down one card.
2. `herdr pane send-keys <pane> down right` — it moves down once more, then right.
