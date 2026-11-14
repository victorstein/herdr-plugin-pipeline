# herdr-pl-1 design — board arrow keys and multi-key input

Research: `docs/superpowers/research/2026-11-14-herdr-pl-1-research.md`.

## Problem

The pipeline board does not move its cursor with the arrow keys under herdr.

- The key table `NAV` (`src/board/ui.ts:28-31`) holds `h/j/k/l` and the CSI arrows
  `\x1b[A/B/C/D` only. herdr 0.9.1 forwards arrows to a pane as SS3, `\x1bOA/B/C/D` (the brief's
  measurement with `herdr pane send-keys`), so `NAV[key]` misses.
- The stdin handler (`src/board/ui.ts:191-196`) passes everything left after `takeCellReply` to
  `onKey` as one string. `onKey` (`src/board/ui.ts:161-178`) compares that string by equality
  against single keys, so a chunk carrying two or more keys (a held arrow, a paste, herdr's batched
  `send-keys`) matches nothing.

## Goal

1. Each of CSI `\x1b[A/B/C/D`, SS3 `\x1bOA/B/C/D` and `k/j/l/h` moves the cursor up/down/right/left.
2. Every key in a stdin chunk is handled, in order, by its own `onKey` call.
3. The keys hint reads `←↓↑→/hjkl move  space peek  o orchestrator  d details  x clear`.

## Non-goals

- `enter`, `tab`, `z`, staging (a separate task). `\n` stays an unbound key.
- The details popup (`src/board/details.ts:35-40`) has the same bug; filed as discovery `t1/x1`.
- herdr-pasture's copy of the board, and anything under `src/kit/` or `test/kit/`
  (`scripts/sync-kit.ts:6-11` overwrites them).
- Escape sequences split across two `data` chunks (see A3).

## Architecture

One new pure module, `src/board/keys.ts`, modelled on `src/board/view.ts` (constants and pure
functions, no I/O, imported by `ui.ts` at `src/board/ui.ts:19`). It exports:

```ts
export const NAV: Record<string, Direction>        // Direction from src/kit/nav.ts:8
export function splitKeys(chunk: string): string[]
```

`NAV` moves out of `ui.ts` unchanged except for four added SS3 entries:

```ts
h: 'left', l: 'right', j: 'down', k: 'up',
'\x1b[D': 'left', '\x1b[C': 'right', '\x1b[B': 'down', '\x1b[A': 'up',
'\x1bOD': 'left', '\x1bOC': 'right', '\x1bOB': 'down', '\x1bOA': 'up',
```

`splitKeys` is one global regex match, `chunk.match(KEY) ?? []`, with

```
KEY = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1bO[A-Za-z]|[\s\S]/gu
```

- `\x1b\[[0-?]*[ -\/]*[@-~]` — a complete CSI sequence: parameter bytes `0x30-0x3F`, intermediate
  bytes `0x20-0x2F`, one final byte `0x40-0x7E` (ECMA-48).
- `\x1bO[A-Za-z]` — SS3 plus one letter, as the brief specifies.
- `[\s\S]` with the `u` flag — anything else, one code point at a time. A lone `\x1b` lands here.

`src/board/ui.ts` changes:
- delete the local `NAV` (`ui.ts:28-31`), import `NAV, splitKeys` from `./keys`;
- in the `data` handler, `if (rest) onKey(rest)` becomes `if (rest) for (const key of splitKeys(rest)) onKey(key)`.

`src/board/view.ts:9` — `KEYS` gets the new text; `test/board-view.test.ts:58` pins it.

## Data and control flow

stdin chunk → `takeCellReply(data.toString())` (unchanged, still first, still on the raw chunk —
`src/kit/frame.ts:16-23`) → `rest` → `splitKeys(rest)` → for each key, `onKey(key)` → `NAV[key]` /
`' '` / `o` / `d` / `x` / `q` / `\x03` exactly as today (`ui.ts:164-176`) → `draw()`.

Example: `"\x1bOD\x1bOC\x1bOA\x1bOB\n\t"` → `['\x1bOD','\x1bOC','\x1bOA','\x1bOB','\n','\t']` →
left, right, up, down, then two unbound keys that only redraw.

## Assumptions (each a decision the review should attack)

- **A1 — alt-chords are split.** `\x1bx` (alt+x) becomes `['\x1b', 'x']`, so `x` acts as a plain
  `x`. The brief lists the token kinds as CSI, SS3, lone `\x1b`, one character, with no alt-chord
  kind. The board binds no alt keys today, so the only effect is that alt+x behaves like x.
- **A2 — SS3 takes letters only.** `\x1bO` followed by a non-letter splits as `\x1b`, `O`, ….
  Brief: "`\x1bO` + one letter". The keypad SS3 forms that use other finals are not bound.
- **A3 — no buffering across chunks.** A CSI cut off at the end of a chunk (`\x1b[` with no final
  byte) splits into `\x1b`, `[`, … and the rest of it arrives as ordinary characters in the next
  chunk. In raw mode a terminal writes a key's sequence in one write, and the measured herdr chunk
  carried six keys intact; buffering would add state and a timeout for a case not observed.
  A stray `[` or digit is unbound, so the cost is a lost arrow, not a wrong action.
- **A4 — keys run in order, each with its own draw.** `onKey` already ends in `draw()`
  (`ui.ts:177`); a six-key chunk draws six times. `FrameWriter.write` re-emits text only when it
  differs from the last frame (`src/kit/frame.ts:53`), and `ui.ts:121-122` writes nothing when it
  returns empty, so the extra draws are cheap. Not
  coalesced, to keep `onKey` unchanged.
- **A5 — `q` or `^C` mid-chunk quits immediately.** `quit()` calls `process.exit` (`ui.ts:156-159`),
  so keys after it in the chunk are dropped. That is the intended meaning of quit.
- **A6 — code points, not UTF-16 units.** The `u` flag keeps a non-BMP character as one key. No
  key is bound to one; this only avoids handing `onKey` half a surrogate pair.
- **A7 — `NAV` lives in `keys.ts`.** The brief asks for the table and the splitter together in a
  board module; `ui.ts` keeps the per-key action dispatch.
- **A8 — hint width.** `←↓↑→` are counted as one column each by the kit (`src/kit/render.ts:113`,
  `[...text].length`). They are East Asian Width "Ambiguous"; on a terminal set to draw ambiguous
  characters wide, the keys line overflows by four columns. Accepted; the hint text is mandated.

## Error handling

`splitKeys` cannot throw: `[\s\S]` matches any code point, so every input splits completely, and
`''` yields `[]` (`match` returns `null`, mapped to `[]`). `ui.ts` already guards `rest` before
calling it. `onKey` errors keep going through the existing `uncaughtException` handler
(`ui.ts:186`), which shows them in the status line.

## Testing strategy

TDD, failing test first. New `test/board-keys.test.ts`, modelled on `test/board-view.test.ts`
(`bun:test`, `expect().toEqual/toBe`):

- `splitKeys('\x1bOD\x1bOC')` → `['\x1bOD', '\x1bOC']`
- `splitKeys('\x1b[A')` → `['\x1b[A']`
- `splitKeys('hj')` → `['h', 'j']`
- `splitKeys('\x1b')` → `['\x1b']`
- the measured herdr chunk `"\u001bOD\u001bOC\u001bOA\u001bOB\n\t"` → six keys
- a parameterised CSI (`'\x1b[1;5A'`) stays one key; `''` → `[]`
- `NAV`: for each direction, the CSI arrow, the SS3 arrow and its `hjkl` letter all map to it.

`test/board-view.test.ts:58` updated to the new `KEYS` text.

`runBoardUi` has no unit test today (only `src/board.ts:34` calls it, behind an injected `runUi`),
and this change does not add a harness for it. The one-line wiring is checked by reading the diff
and by a live check: open the board in a herdr 0.9.1 pane, run
`herdr pane send-keys <pane> down down right`, and see the cursor move three times.

Gate: `bunx tsc --noEmit` and `bun test` green.

## Format and compatibility

No change to `phases.ts`, `schema_version`, the ledger or any prompt.
