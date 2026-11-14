Tier: light

# herdr-pl-1 spec review, pass 0

Spec: `docs/superpowers/specs/2026-11-14-herdr-pl-1-design.md`
Against: `hpipe brief --task t1`, `docs/superpowers/research/2026-11-14-herdr-pl-1-research.md`

## What I checked

- **Every code citation in the spec matches current code** on `feat-board-arrow-keys` (951929f):
  - `NAV` is at `src/board/ui.ts:28-31` and is not exported.
  - The `data` handler is at `ui.ts:191-196`, with `if (rest) onKey(rest)` at `:194`.
  - `onKey` is at `ui.ts:161-178`; it dispatches keys at `:164-176` and calls `draw()` at `:177`.
  - `quit` is at `ui.ts:156-159` and the `uncaughtException` handler at `ui.ts:186`.
  - `takeCellReply` is at `src/kit/frame.ts:16-23`. The `lastText` comparison is at `frame.ts:53`.
  - `Direction` is at `src/kit/nav.ts:8`, `KEYS` at `src/board/view.ts:9`, and the test that pins it at `test/board-view.test.ts:58`.
  - `KEYS` is used only by `view.ts`, `ui.ts:19/118` and that test, so nothing else pins the hint text.
- **The splitter regex does what the spec says.** I ran it under bun 1.3.14 (`/\x1b\[[0-?]*[ -\/]*[@-~]|\x1bO[A-Za-z]|[\s\S]/gu`, `c.match(KEY) ?? []`):
  - The brief's four acceptance cases come out right: `"\x1bOD\x1bOC"` → 2 keys, `"\x1b[A"` → 1, `"hj"` → 2, `"\x1b"` → 1.
  - The measured herdr chunk splits into `["\u001bOD","\u001bOC","\u001bOA","\u001bOB","\n","\t"]`.
  - `"\x1b[1;5A"` stays one key, and `''` → `[]`.
  - `"\x1bx"` → `["\u001b","x"]` (A1), `"\x1bO"` → `["\u001b","O"]` (A2) and `"\x1b["` → `["\u001b","["]` (A3).
  - `"😀a"` → `["😀","a"]` (A6), and `"\x1b\x1b[A"` → `["\u001b","\u001b[A"]`.
- **The regex compiles under this repo's settings.** `bunx tsc --noEmit --strict --target ESNext` on a file holding the regex and `match(...) ?? []` typed as `string[]` passes. `tsconfig.json` targets ESNext, so the `u` flag and `\/` inside the class are valid.
- **The kit boundary holds.** `keys.ts` only imports `type Direction` from `../kit/nav`, and no file under `src/kit/` or `test/kit/` changes. `takeCellReply` stays first on the raw chunk.
- **The non-goals are tracked.** `hpipe discoveries --task t1` lists `t1/x1 unfiled — Details popup quits on SS3 arrow keys`, which matches `src/board/details.ts:35-40`.
- **The assumptions hold:**
  - A1 and A2 follow the brief's own token list.
  - A3: a cut-off CSI decays into unbound keys; it never causes a wrong action, since `[`, digits and `;` are unbound in `onKey`.
  - A4: extra draws cost little, because `writer.write` returns `''` when the text is unchanged (`frame.ts:53`, `ui.ts:121-122`).
  - A5: `process.exit` in `quit` is the intended behaviour.
  - A8: `paint(view.keys, room, …)` truncates by code points (`src/kit/render.ts`, the `view.keys` line). An ambiguous-wide terminal can therefore draw up to 4 columns more than the kit measured. The hint text is mandated by the brief, so this is an accepted limit.
- **Scope matches the brief.** All four brief items and every acceptance bullet map to Goals, Architecture and Testing. The tier stays `light`, which is right: one surface, no change to `phases.ts`, the ledger or prompts.

## Findings

### MINOR 1 — the live check can pass or fail independently of the change

- **Claim (Testing strategy):** "open the board in a herdr 0.9.1 pane, run `herdr pane send-keys <pane> down down right`, and see the cursor move three times."
- **Problem:** `moveCursor` clamps and skips empty columns, so whether the cursor visibly moves depends on the board's contents.
  - `down` clamps at the last row (`src/kit/nav.ts:31`).
  - `right` skips empty columns and returns the same id when nothing lies to the right (`nav.ts:34-39`).
  - On a board with fewer than 3 cards in the cursor's column, or with no non-empty column to its right, the cursor cannot move "three times" even with a correct fix. A tester who sees only one or two moves cannot tell a wiring bug from board shape.
  - The check also tests only the multi-key path. It never shows that a lone SS3 arrow sent by itself is accepted.
- **Evidence:** the `nav.ts:26-40` body quoted above.
- **Fix:** state the precondition, then check both paths:
  1. Start with the cursor on a column that holds at least 3 cards and has a non-empty column to its right, or pick a sequence that fits the run on screen.
  2. Send a single `herdr pane send-keys <pane> down` and confirm one move. This covers SS3 alone.
  3. Send `down down right` in one call and confirm each key's move. This covers the multi-key chunk.
  4. Note that the same sequence did nothing before the change.

VERDICT: CLEAR
