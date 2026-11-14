# herdr-pl-1 research — board arrow keys and multi-key input

## Installed versions

| Tool | Command | Output |
|---|---|---|
| bun | `bun --version` | `1.3.14` |
| TypeScript | `bunx tsc --version` | `Version 5.9.3` |
| herdr | `herdr --version` | `herdr 0.9.1` |

`package.json` has no runtime dependencies (devDependencies: `@types/bun`, `typescript ^5.6.0`).

## Who owns the behaviour

- `src/board/ui.ts:28-31` — `NAV`, the key → `Direction` table. Holds `h/l/j/k` and only the CSI
  arrows `\x1b[D/C/B/A`. No SS3 (`\x1bO…`) entries.
- `src/board/ui.ts:189-196` — the stdin handler. Each `data` chunk goes through `takeCellReply`
  (`src/kit/frame.ts:16-23`, which strips every `\x1b[6;H;Wt` cell-size reply via the global regex
  at `src/kit/frame.ts:14`), and whatever is left, `rest`, is passed **whole** to `onKey`.
- `src/board/ui.ts:161-178` — `onKey(key)`. Compares `key` by equality: `NAV[key]`, `key === ' '`,
  `'o'`, `'d'`, `'x'`, `'q'`, `'\x03'`. A chunk of two keys therefore matches nothing and only
  redraws.
- `src/kit/nav.ts:8` — `type Direction = 'left' | 'right' | 'up' | 'down'`; `moveCursor`
  (`src/kit/nav.ts:26`) takes one direction.
- `src/board/view.ts:9` — `KEYS = 'hjkl move  space peek  o orchestrator  d details  x clear'`,
  pinned by `test/board-view.test.ts:58`. Rendered by `src/kit/render.ts:171`.

The brief's line numbers for `onKey` (`196-201`) are stale; the current ones are above.

## Current control flow

stdin (raw mode, `ui.ts:189`) → `data` → `takeCellReply(data.toString())` → if a cell reply was
found, `writer.setCell` → if `rest` non-empty, `onKey(rest)`, else `draw()` → `onKey` looks `rest`
up as a single key → `moveCursor` / peek / details / clear → `draw()`.

So with herdr's input `"\u001bOD\u001bOC\u001bOA\u001bOB\n\t"` (the brief's measurement on herdr
0.9.1 via `herdr pane send-keys`; not re-run here) `onKey` receives the whole string, `NAV` misses,
and nothing moves. A single SS3 arrow `"\x1bOD"` also misses because `NAV` has no SS3 entries.

## Kit boundary

`scripts/sync-kit.ts:6-11` deletes and re-copies `src/kit` and `test/kit` from herdr-pasture, so
any edit under `src/kit/` is overwritten on the next sync. The splitter and key table must live in
`src/board/`, as the brief says. `takeCellReply` stays the first step on the raw chunk.

## Nearest existing example

A pure module beside the board with its own flat test file: `src/board/view.ts` (exports constants
and pure functions, no I/O) tested by `test/board-view.test.ts` (`bun:test`, `expect(...).toBe`).
Test files for `src/board/*` follow `test/board-<module>.test.ts` (`board-data`, `board-details`,
`board-model`, `board-scenes`, `board-view`), so the new module is `src/board/keys.ts` with
`test/board-keys.test.ts`. `bun test test/board-view.test.ts` passes today: 6 tests, 0 fail.

No existing code in `src/` or `test/` splits escape sequences; `grep -rln 'x1b\[A\|x1bO' src test`
finds only `src/board/ui.ts` and `src/board/details.ts`, both plain equality checks.

## Render width of the new hint

`src/kit/render.ts` measures text by code points (`[...text].length`, lines 75, 113, 155, 168).
`←↓↑→` are one code point each, so the hint counts as 4 columns for them. They are East Asian
Width "Ambiguous"; a terminal configured for double-width ambiguous characters would draw them
wider than the kit measures. Accepted as a known limit, not addressed here.

## Out of scope, found while reading

`src/board/details.ts:35-40` (the details popup) has the same CSI-only arrow check, and its `else`
branch calls `quit()` on any other input — so an SS3 arrow from herdr closes the popup instead of
scrolling. Filed as a discovery, not fixed in this PR.

## Tier

Stays `light`: one surface, no `phases.ts`/`schema_version`/ledger change, no contract with another
surface, no migration. The change is a new pure module plus a two-line rewire in `ui.ts` and one
string in `view.ts`.
