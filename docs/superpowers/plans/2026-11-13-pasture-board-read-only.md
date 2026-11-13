# Pipeline Board (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-repo `bv` board tab with pasture's kanban, drawn from the pipeline's own
ledger. It is read-only: peek and details are available, but no pane is moved.

**Architecture:**
- Pasture's plugin-neutral kit is vendored into `src/kit/` and `test/kit/`. A pasture-side task first
  moves pasture's flicker-free frame writer into the kit.
- The board's logic is pure and unit-tested, in `src/board/`:
  - `model.ts`: columns and cards
  - `view.ts`: header, summary and keys
  - `scenes.ts`: the 12 approved phase scenes
- Thin I/O sits around that logic:
  - `data.ts`: reads the ledger and the holds
  - `ui.ts`: the TUI loop
  - `details.ts`: a popup
- `src/board.ts` keeps its record-and-rename duty and runs the UI instead of `bv`.

**Tech Stack:** bun and TypeScript (`bun test`, `tsc --noEmit`), the herdr socket API, and kitty
graphics through herdr.

**Spec:** `docs/superpowers/specs/2026-11-13-pasture-board-design.md`. This is plan 3 of 4. Plan 4
(staging) is out of scope here: there is no `enter`, `tab` or `z`, and no `placeholder` pane.

---

## Ground rules for every task

- **Two repos are involved:**
  - **Pasture** (`~/Documents/development/personal/herdr-pasture`), Task 1 only. Its working tree is
    the user's live plugin and statusline, so work in a git worktree:

    ```bash
    cd ~/Documents/development/personal/herdr-pasture
    PWT=$TMPDIR/pasture-frame   # or the session scratchpad
    git worktree add -q $PWT -b feat/kit-frame && ln -s $PWD/node_modules $PWT/node_modules
    ```

    Task 1's last step fast-forwards pasture's `main`.
  - **Pipeline** (`~/Documents/development/personal/herdr-plugin-pipeline`), Tasks 2–9, on branch
    `feat/pasture-board`. Its working tree is not installed anywhere (the installed plugin is a
    GitHub release), so work in it directly.
- **Never run `bv`.** Its licence forbids use by or for Anthropic.
- **No comments that restate the code.** Comment only a non-obvious why.
- **Every task ends green:** `bun test` passes with 0 fail, and `bunx tsc --noEmit` prints nothing.
- **Every commit message ends with:**

  ```
  Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs
  ```

## File map

| Path | Responsibility |
|---|---|
| pasture `src/kit/frame.ts` (new) | `FrameWriter`, `imagePng`, `CELL_QUERY` and `takeCellReply`: the full clear on the first draw and on resize, the text diff, transmitting each image once, and the kitty layer sync |
| `src/kit/`, `test/kit/` (vendored) | pasture's kit, a plain copy |
| `scripts/sync-kit.ts` (new) | copies pasture's kit over this repo's and prints the diff |
| `src/board/scenes.ts` (moved from `docs/superpowers/art/phase-scenes/`) | the 11 new scenes and `sceneFor(task)` |
| `src/board/model.ts` (new) | `humanOwes`, `runOwes`, and `buildBoard` → `Record<Column, CardView[]>` |
| `src/board/view.ts` (new) | `header`, `summary`, `KEYS`, `TITLES` |
| `src/board/data.ts` (new) | `runForSlug`, `loadHolds` |
| `src/board/details.ts` (new) | the task-details popup: `detailScreen` (pure) plus its `main` |
| `src/board/ui.ts` (new) | the board's TUI loop and `PIPELINE: Identity` |
| `src/board.ts` | records and renames the board, then runs the UI. bv is gone. |
| `src/lib/boards.ts` | `BoardRecord.cleared` (the Done cards the user cleared) |
| `herdr-plugin.toml` | `peek` and `details` popup panes; `min_herdr_version` 0.9.1 |

---

### Task 1 (pasture): move the frame writer into the kit

Pasture's `src/board.ts` holds:
- the full clear on the first draw and on resize
- the `lastText` diff
- the sent-image set
- `imagePng` (glass vs sprite ids)
- the `CSI 16 t` cell probe

The pipeline needs exactly the same, so all of it moves into `src/kit/frame.ts`.

**Files (pasture worktree `$PWT`):**
- Create: `src/kit/frame.ts`, `test/kit/frame.test.ts`
- Modify: `src/board.ts`

- [ ] **Step 1: Write the failing test** (`test/kit/frame.test.ts`)

```ts
import { expect, test } from 'bun:test'
import { CELL_QUERY, FrameWriter, imagePng, takeCellReply } from '../../src/kit/frame'
import { glassImageId } from '../../src/kit/glass'
import { imageId } from '../../src/kit/sprites'

const sprite = imageId('idle', 0, 'none', false)
const frame = (text: string, image = sprite) => ({ text, placements: [{ id: 1, image, row: 4, col: 3 }] })

test('the first write clears the screen, sends each image once and places it', () => {
  const writer = new FrameWriter()
  const out = writer.write(frame('A'))
  expect(out.startsWith('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2JA')).toBe(true)
  expect(out).toContain(`a=t,f=100,i=${sprite}`)
  expect(out).toContain(`a=p,i=${sprite},p=1`)
})

test('an unchanged frame writes nothing; changed text is overwritten in place, without a clear', () => {
  const writer = new FrameWriter()
  writer.write(frame('A'))
  expect(writer.write(frame('A'))).toBe('')
  const out = writer.write(frame('B'))
  expect(out.startsWith('B')).toBe(true)
  expect(out).not.toContain('\x1b[2J')
  expect(out).not.toContain('a=t,')
})

test('invalidate forces a full clear and re-sends the images', () => {
  const writer = new FrameWriter()
  writer.write(frame('A'))
  writer.invalidate()
  const out = writer.write(frame('A'))
  expect(out).toContain('\x1b[2J')
  expect(out).toContain(`a=t,f=100,i=${sprite}`)
})

test('a new cell size invalidates; the same size does not', () => {
  const writer = new FrameWriter()
  expect(writer.setCell({ width: 10, height: 20 })).toBe(true)
  writer.write(frame('A'))
  expect(writer.setCell({ width: 10, height: 20 })).toBe(false)
  expect(writer.write(frame('A'))).toBe('')
  expect(writer.setCell({ width: 11, height: 22 })).toBe(true)
  expect(writer.write(frame('A'))).toContain('\x1b[2J')
})

test('cell-size replies are taken out of terminal input', () => {
  expect(CELL_QUERY).toBe('\x1b[16t')
  expect(takeCellReply('j\x1b[6;20;10tk')).toEqual({ rest: 'jk', cell: { width: 10, height: 20 } })
  expect(takeCellReply('j')).toEqual({ rest: 'j', cell: null })
  expect(takeCellReply('\x1b[6;0;0t')).toEqual({ rest: '', cell: null })
})

test('imagePng draws glass at the cell size and sprites without one', () => {
  expect(imagePng(sprite, null).length).toBeGreaterThan(0)
  expect(imagePng(glassImageId(30, false), { width: 10, height: 20 }).length).toBeGreaterThan(0)
  expect(() => imagePng(glassImageId(30, false), null)).toThrow('cell size')
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/kit/frame.test.ts`
Expected: FAIL, because `src/kit/frame` does not exist.

- [ ] **Step 3: Implement `src/kit/frame.ts`**

```ts
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
```

Check before writing it: if `src/kit/render.ts` imports nothing from `frame.ts`, there is no import
cycle. It doesn't.

- [ ] **Step 4: Run the test**

Run: `bun test test/kit/frame.test.ts`
Expected: PASS. If `KittyLayer.sync` emits something for an unchanged frame, the "writes nothing"
test fails. Read `src/kit/kitty.ts` and fix the expectation only if the kitty layer is right to emit
(it should not be).

- [ ] **Step 5: Use it in pasture's board**

In pasture's `src/board.ts`:
- Delete `const layer`, `const sentImages`, `let cell`, `let lastText`, `let needsClear`, the local
  `imagePng`, `askCellSize`, `CELL_REPLY` and `takeCellReply`. Drop the now-unused imports
  (`deleteAllImages`, `KittyLayer`, `missingImages`, `transmit`, `glassKey`, `glassPng`,
  `isGlassImage`, `type Cell`, `spriteKey`, `spritePng`, `SPRITE_COLS`).
- Add `import { CELL_QUERY, FrameWriter, takeCellReply } from './kit/frame'` and
  `const writer = new FrameWriter()`.
- In `draw()`, pass `cell: writer.cell` into the `render` view. Replace everything from
  `let screen = ''` down to `out(screen)` with:

  ```ts
    const screen = writer.write(frame)
    if (screen) out(screen)
  ```

- The stdin handler becomes:

  ```ts
  process.stdin.on('data', (data) => {
    const { rest, cell } = takeCellReply(data.toString())
    if (cell) writer.setCell(cell)
    if (rest) onKey(rest)
    else draw()
  })
  process.stdout.on('resize', () => {
    writer.invalidate()
    out(CELL_QUERY)
    draw()
  })
  ```

- Replace the startup `askCellSize()` with `out(CELL_QUERY)`.
- `quit()` keeps its own `deleteAllImages()` import, so keep that one import if `quit` uses it.

- [ ] **Step 6: Verify, commit, merge**

```bash
cd $PWT && bun test && bunx tsc --noEmit && git add -A src test && git commit -qm "Kit: the frame writer both boards share

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
cd ~/Documents/development/personal/herdr-pasture && git merge --ff-only feat/kit-frame && bun test | tail -2
git worktree remove $PWT --force && git branch -d feat/kit-frame
```

Then restart pasture's live board:
1. Kill `boardPid` from `~/.local/state/herdr/plugins/stein.pasture/state.json`.
2. Run `HERDR_PLUGIN_STATE_DIR=~/.local/state/herdr/plugins/stein.pasture bun run src/open.ts --no-focus`.
3. Read its pane with `herdr pane read <boardPaneId> --source visible`. Expect the chips row and the
   four column titles.

---

### Task 2: vendor the kit, with a sync script

**Files:**
- Create: `scripts/sync-kit.ts`, `src/kit/*`, `test/kit/*`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write the sync script** (`scripts/sync-kit.ts`)

```ts
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const from = process.env.PASTURE_DIR ?? join(process.env.HOME ?? '', 'Documents/development/personal/herdr-pasture')
const here = join(import.meta.dir, '..')
for (const dir of ['src/kit', 'test/kit']) {
  if (!existsSync(join(from, dir))) throw new Error(`no ${dir} in ${from}; set PASTURE_DIR`)
  // a plain replace, so a file deleted upstream does not linger here
  rmSync(join(here, dir), { recursive: true, force: true })
  cpSync(join(from, dir), join(here, dir), { recursive: true })
}
const diff = Bun.spawnSync(['git', '-C', here, 'status', '--short', '--', 'src/kit', 'test/kit'], { stdout: 'pipe' })
console.log(diff.stdout.toString() || 'kit unchanged')
```

- [ ] **Step 2: Typecheck scripts**

In `tsconfig.json`, set `"include": ["src", "test", "scripts"]`.

- [ ] **Step 3: Run it**

Run: `bun scripts/sync-kit.ts`
Expected: it lists `?? src/kit/` and `?? test/kit/`.

- [ ] **Step 4: Verify the vendored kit passes here**

Run: `bun test test/kit && bunx tsc --noEmit`
Expected: all kit tests pass, including `boundary.test.ts`, and there is no tsc output.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-kit.ts tsconfig.json src/kit test/kit && git commit -qm "Vendor pasture's board kit

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 3: the approved phase scenes

**Files:**
- Move: `docs/superpowers/art/phase-scenes/scenes.ts` → `src/board/scenes.ts`
- Create: `test/board-scenes.test.ts`

- [ ] **Step 1: Move it**

```bash
mkdir -p src/board && git mv docs/superpowers/art/phase-scenes/scenes.ts src/board/scenes.ts
```

Its imports already read `'../kit/sprites'` and `'../kit/palette'`. Change the README in
`docs/superpowers/art/phase-scenes/` to say the scenes now live in `src/board/scenes.ts`.

- [ ] **Step 2: Write the failing test** (`test/board-scenes.test.ts`)

```ts
import { expect, test } from 'bun:test'
import { PIPELINE_SCENES, sceneFor } from '../src/board/scenes'
import { drawFrame, framesOf, scenes } from '../src/kit/sprites'
import type { TaskPhase } from '../src/lib/phases'

const WORKING: [TaskPhase, string][] = [
  ['research', 'research'], ['spec', 'spec'], ['spec-review', 'spec-review'], ['plan', 'plan'],
  ['plan-review', 'plan-review'], ['implement', 'working'], ['pr-review', 'pr-review'],
  ['pr-review-intent', 'pr-review'], ['pr-review-quality', 'pr-review'], ['ci', 'ci'],
  ['land-queue', 'land-queue'], ['sync', 'sync'], ['merge', 'merge'], ['close', 'close'], ['teardown', 'close'],
]

test('every working phase has its scene, including the retired review variants and teardown', () => {
  for (const [phase, scene] of WORKING) expect(sceneFor({ phase, decision_from: null })).toBe(scene)
})

test('a task waiting on the orchestrator keeps the scene of what it was doing', () => {
  expect(sceneFor({ phase: 'blocked-on-decision', decision_from: 'plan' })).toBe('plan')
  expect(sceneFor({ phase: 'blocked-on-decision', decision_from: null })).toBe('working')
})

test('the 11 new scenes are registered with 4 frames each', () => {
  expect(PIPELINE_SCENES).toHaveLength(11)
  for (const name of PIPELINE_SCENES) {
    expect(scenes()).toContain(name)
    expect(framesOf(name)).toBe(4)
  }
})

const HAT = [0xf9, 0xe2, 0xaf]

test('every loop frame shows the hard hat', () => {
  for (const name of PIPELINE_SCENES) {
    for (let f = 0; f < 4; f++) {
      const px = drawFrame(name, f, 'hardhat', false)
      let hat = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] === HAT[0] && px[i + 1] === HAT[1] && px[i + 2] === HAT[2]) hat++
      expect({ name, f, hat: hat >= 20 }).toEqual({ name, f, hat: true })
    }
  }
})
```

The hat check counts yellow pixels. Some props are also yellow, such as the research lens rim, so
the threshold is the hat's own width at minimum.

Run: `bun test test/board-scenes.test.ts`
Expected: FAIL, because `sceneFor` does not exist yet.

- [ ] **Step 3: Add `sceneFor` to `src/board/scenes.ts`**

Add `import type { Task, TaskPhase } from '../lib/types'` at the top. If `TaskPhase` is exported from
`../lib/phases` rather than `../lib/types`, import it from there. Then add:

```ts
const PHASE_SCENE: Partial<Record<TaskPhase, string>> = {
  research: 'research', spec: 'spec', 'spec-review': 'spec-review', plan: 'plan', 'plan-review': 'plan-review',
  implement: 'working', 'pr-review': 'pr-review', 'pr-review-intent': 'pr-review', 'pr-review-quality': 'pr-review',
  ci: 'ci', 'land-queue': 'land-queue', sync: 'sync', merge: 'merge', close: 'close', teardown: 'close',
}

export function sceneFor(task: Pick<Task, 'phase' | 'decision_from'>): string {
  return PHASE_SCENE[task.phase] ?? (task.decision_from ? PHASE_SCENE[task.decision_from] : undefined) ?? 'working'
}
```

- [ ] **Step 4: Run it**

Run: `bun test test/board-scenes.test.ts && bunx tsc --noEmit`
Expected: PASS and no tsc output.

- [ ] **Step 5: Commit**

```bash
git add -A src/board test/board-scenes.test.ts docs/superpowers/art && git commit -qm "Board: the approved phase scenes

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 4: columns and cards (`src/board/model.ts`)

**Files:**
- Create: `src/board/model.ts`, `test/board-model.test.ts`

The column rules and the badge order are the spec's §Columns and §Cards; read them first.

**Needs you means the human must act.** It is not `waitsOnYou`: that predicate is the orchestrator's
"YOUR move".

- [ ] **Step 1: Write the failing tests** (`test/board-model.test.ts`)

Build tasks the way the existing tests do. Read `test/before-merge.test.ts` and
`test/helpers/`, and reuse their run and task builders, such as `newRun` from `src/lib/ledger`, plus
the task fixture helper the tests already use. Where no helper fits, write a `task(over)` factory in
this file over the `Task` fields in `src/lib/types.ts`.

Cover, each as its own `test(...)`:

```ts
import { expect, test } from 'bun:test'
import { buildBoard, humanOwes, runOwes, type BoardInput } from '../src/board/model'
// plus the fixture helpers chosen above

// input(run, over) builds a BoardInput: holds {}, livePanes = every task's pane_id and the run's
// orchestrator_pane, ctx empty, orchestratorsMove () => false, cleared empty, then `over`
```

1. **A routine per-task `merge`** with no owed check is in Working. When `orchestratorsMove` returns
   true, its badge text is `orchestrator's move`.
2. **A per-task `merge` that `heldForTheHuman` holds** (a before-merge check owed to the human) is in
   Needs you, and its badge text is the check's text. Build it the way
   `test/before-merge.test.ts` builds a held merge.
3. **`escalated` → Needs you**, badge `escalated`.
4. **An unanswered escalated decision → Needs you**, badge `answer decision <id>`.
5. **`failed`, `orphaned` and `blocked-on-failure` → Needs you**, badge equal to the phase.
6. **A `stuck_input` hold** on the worker's pane → Needs you, badge `input box has text`.
7. **A `usage_limit` hold with `until: null`** → Needs you, badge `usage limit`. With a number
   `until` → Idle, badge equal to the hold's `reset`, or `usage limit` when `reset` is missing.
8. **`done` → Done.** A done task in `cleared` is not on the board.
9. **`queued` → Idle.** With an unmet dependency, the badge is `deps: <bead of the dependency>`.
10. **`blocked-on-files` → Idle**, badge `files: <bead of a holder>` (`fileHolders(run, task)[0]`).
11. **A worker phase with `pane_id` null, or a pane not in `livePanes`** → Idle, badge `no agent`.
12. **Working badge priority:**
    - `ci` pending → `ci ●`, fail → `ci ✗`, pass → `ci ✓`
    - else `PR #N`
    - else the tier (`light` / `standard` / `heavy`)
13. **The card's other fields:**
    - `id` = `task_id`
    - `title` = `<bead> <brief.title>`
    - `subtitle` = the phase
    - `since` = `phase_entered_at`
    - `accessory` = `'hardhat'`
    - `scene` = `sceneFor(task)` in Working, `'blocked'` in Needs you, `'done'` in Done, `'idle'` in Idle
    - `ctx` from `input.ctx` by the task's `pane_id`
    - `enteredAt` = `phase_entered_at` in Done and Needs you, `null` elsewhere
14. **Run cards** lead Needs you, with id `run:<run_id>`:
    - a run in `escalated` → badge `run escalated`
    - a single-PR run whose `owedInRun` is non-empty → badge = the first check's text
    - a driven run whose `orchestrator_pane` is null or not in `livePanes` → badge
      `orchestrator is not running`
    - `runOwes` returns null for a healthy run.
15. **Each column is newest-first by `since`**, with the run card always first in Needs you.

Run: `bun test test/board-model.test.ts`
Expected: FAIL, because `src/board/model` does not exist.

- [ ] **Step 2: Implement `src/board/model.ts`**

```ts
import type { Column } from '../kit/nav'
import { MOCHA } from '../kit/palette'
import type { CardView, Span } from '../kit/render'
import { heldForTheHuman, owedAt, owedInRun } from '../lib/before-merge'
import { escalatedUnanswered } from '../lib/decisions'
import type { PaneHold } from '../lib/delivery-health'
import { fileHolders, TERMINAL_BAD } from '../lib/gating'
import { runIsDriven } from '../lib/ledger'
import { modeOf, taskRow, tierOf } from '../lib/phases'
import type { Run, Task } from '../lib/types'
import { sceneFor } from './scenes'

export interface BoardInput {
  run: Run
  holds: Record<string, PaneHold>
  livePanes: ReadonlySet<string>
  ctx: ReadonlyMap<string, number>
  /** Only consulted for tasks whose row's actor is the orchestrator; it runs status.ts's waitsOnYou. */
  orchestratorsMove: (task: Task) => boolean
  cleared: ReadonlySet<string>
}

const red = (text: string): Span => ({ text, color: MOCHA.red, bold: true })
const quiet = (text: string): Span => ({ text, color: MOCHA.overlay0 })
const CI: Partial<Record<string, Span>> = {
  pending: { text: 'ci ●', color: MOCHA.yellow },
  fail: { text: 'ci ✗', color: MOCHA.red },
  pass: { text: 'ci ✓', color: MOCHA.green },
}
const COLUMN_SCENE: Record<Exclude<Column, 'working'>, string> = { needs: 'blocked', done: 'done', idle: 'idle' }

/** What the human owes on this task: the hpipe:awaiting-human label's rules, plus failures and the holds only a human clears. */
export function humanOwes(run: Run, task: Task, holds: Record<string, PaneHold>): string | null {
  if (heldForTheHuman(run, task)) return owedAt(run, task)[0]?.check.check ?? 'a check before merge'
  if (task.phase === 'escalated') return 'escalated'
  const open = escalatedUnanswered(task)
  if (open) return `answer decision ${open.id}`
  if (TERMINAL_BAD.has(task.phase)) return task.phase
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code === 'stuck_input') return 'input box has text'
  if (hold?.code === 'usage_limit' && (hold.until ?? null) === null) return 'usage limit'
  return null
}

export function runOwes(run: Run, livePanes: ReadonlySet<string>): string | null {
  if (run.phase === 'escalated') return 'run escalated'
  const owed = modeOf(run) === 'single-pr' ? owedInRun(run)[0] : undefined
  if (owed) return owed.check.check
  if (runIsDriven(run) && (run.orchestrator_pane === null || !livePanes.has(run.orchestrator_pane))) return 'orchestrator is not running'
  return null
}

function placed(input: BoardInput, task: Task): { column: Column; badge: Span } {
  const { run, holds, livePanes } = input
  const owes = humanOwes(run, task, holds)
  if (owes) return { column: 'needs', badge: red(owes) }
  const progress = CI[task.ci ?? ''] ?? (task.pr !== null ? quiet(`PR #${task.pr}`) : null)
  if (task.phase === 'done') return { column: 'done', badge: progress ?? quiet(tierOf(task)) }
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code === 'usage_limit') return { column: 'idle', badge: quiet(hold.reset ?? 'usage limit') }
  const unmet = run.tasks.find((t) => task.depends_on.includes(t.task_id) && t.phase !== 'done')
  if (task.phase === 'queued') return { column: 'idle', badge: quiet(unmet ? `deps: ${unmet.bead}` : tierOf(task)) }
  if (task.phase === 'blocked-on-files') return { column: 'idle', badge: quiet(`files: ${fileHolders(run, task)[0]?.bead ?? 'held'}`) }
  const actor = taskRow(task.phase).actor
  if (actor === 'worker' && (task.pane_id === null || !livePanes.has(task.pane_id))) return { column: 'idle', badge: quiet('no agent') }
  const move = actor === 'orchestrator' && input.orchestratorsMove(task) ? quiet("orchestrator's move") : null
  return { column: 'working', badge: progress ?? move ?? quiet(tierOf(task)) }
}

export function buildBoard(input: BoardInput): Record<Column, CardView[]> {
  const board: Record<Column, CardView[]> = { needs: [], working: [], done: [], idle: [] }
  for (const task of input.run.tasks) {
    if (task.phase === 'done' && input.cleared.has(task.task_id)) continue
    const { column, badge } = placed(input, task)
    board[column].push({
      id: task.task_id,
      column,
      title: `${task.bead} ${task.brief.title}`,
      subtitle: task.phase,
      badge,
      since: task.phase_entered_at,
      ctx: task.pane_id === null ? null : input.ctx.get(task.pane_id) ?? null,
      scene: column === 'working' ? sceneFor(task) : COLUMN_SCENE[column],
      accessory: 'hardhat',
      enteredAt: column === 'done' || column === 'needs' ? task.phase_entered_at : null,
    })
  }
  for (const list of Object.values(board)) list.sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
  const owes = runOwes(input.run, input.livePanes)
  if (owes) {
    board.needs.unshift({
      id: `run:${input.run.run_id}`, column: 'needs', title: input.run.title, subtitle: `run · ${input.run.phase}`,
      badge: red(owes), since: input.run.phase_entered_at, ctx: null, scene: 'blocked', accessory: 'hardhat', enteredAt: null,
    })
  }
  return board
}
```

Verify these names against the code before using them: `OwedCheck.check.check` is the check's text
(`src/lib/before-merge.ts` `HeldCheck`, `src/lib/types.ts` `BeforeMergeCheck.check`), and `tierOf` and
`fileHolders` exist. If a test fixture needs `holds[pane].until` to be absent instead of null, the
`(hold.until ?? null) === null` check covers both.

- [ ] **Step 3: Run it**

Run: `bun test test/board-model.test.ts && bunx tsc --noEmit`
Expected: PASS and no tsc output.

- [ ] **Step 4: Commit**

```bash
git add src/board/model.ts test/board-model.test.ts && git commit -qm "Board: columns and cards from the ledger

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 5: header, summary and keys (`src/board/view.ts`)

**Files:**
- Create: `src/board/view.ts`, `test/board-view.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { header, KEYS, summary, TITLES } from '../src/board/view'
// run fixtures as in Task 4

test('the header names the run, its phase and mode, then the batch PR and the landing slot', () => {
  // per-task run 'rsvp export' in execute, a task holding the landing slot (bead hp-7) and one more queued for it
  // expect texts: ['rsvp export', 'execute', 'per-task', 'landing hp-7 +1', 'orchestrator ✓']
})

test('a gone orchestrator is the second span, so a narrow header keeps it', () => {
  // expect header(run, false)[1] to be { text: 'orchestrator gone', color: MOCHA.red, bold: true }
})

test('a single-PR run shows its batch PR and CI', () => {
  // run.batch = { …, pr: 12, ci: 'pending' } → a span 'PR #12 ci ●'
})

test('no run says so', () => {
  expect(header(null, true).map((s) => s.text)).toEqual(['no run in this repo'])
})

test('the summary counts cards per column; titles rename Idle; keys list only plan-3 keys', () => {
  // summary(board) === '5 tasks · 1 need you · 2 working · 1 done'
  expect(TITLES).toEqual({ idle: '○ Idle/queued' })
  expect(KEYS).toBe('hjkl move  space peek  o orchestrator  d details  x clear')
})
```

Write the bodies concretely using the fixtures from Task 4. The comments give the exact
expectations.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/board-view.test.ts`
Expected: FAIL, because `src/board/view` does not exist.

- [ ] **Step 3: Implement it**

```ts
import { COLUMNS, type Column } from '../kit/nav'
import { MOCHA } from '../kit/palette'
import type { CardView, Span } from '../kit/render'
import { landingQueue, landingSlotHolder } from '../lib/gating'
import { modeName, modeOf } from '../lib/phases'
import type { Run } from '../lib/types'

export const KEYS = 'hjkl move  space peek  o orchestrator  d details  x clear'
export const TITLES: Partial<Record<Column, string>> = { idle: '○ Idle/queued' }
const CI_GLYPH: Partial<Record<string, string>> = { pending: '●', fail: '✗', pass: '✓' }

// the kit drops later spans first when the header runs out of room, so a dead orchestrator goes early
export function header(run: Run | null, orchestratorLive: boolean): Span[] {
  if (!run) return [{ text: 'no run in this repo', color: MOCHA.overlay1 }]
  const spans: Span[] = [{ text: run.title, color: MOCHA.lavender, bold: true }]
  if (!orchestratorLive) spans.push({ text: 'orchestrator gone', color: MOCHA.red, bold: true })
  spans.push({ text: run.phase, color: MOCHA.blue }, { text: modeName(modeOf(run)), color: MOCHA.overlay1 })
  if (run.batch?.pr) spans.push({ text: `PR #${run.batch.pr}${run.batch.ci && CI_GLYPH[run.batch.ci] ? ` ci ${CI_GLYPH[run.batch.ci]}` : ''}`, color: MOCHA.overlay1 })
  const holder = landingSlotHolder(run.tasks)
  if (holder) {
    const waiting = landingQueue(run.tasks).filter((t) => t !== holder).length
    spans.push({ text: `landing ${holder.bead}${waiting ? ` +${waiting}` : ''}`, color: MOCHA.peach })
  }
  if (orchestratorLive) spans.push({ text: 'orchestrator ✓', color: MOCHA.green })
  return spans
}

export function summary(board: Record<Column, CardView[]>): string {
  const tasks = COLUMNS.flatMap((c) => board[c]).filter((c) => !c.id.startsWith('run:')).length
  const needs = board.needs.filter((c) => !c.id.startsWith('run:')).length
  return `${tasks} tasks · ${needs} need you · ${board.working.length} working · ${board.done.length} done`
}
```

`modeName` exists in `src/lib/phases.ts`. Check what it returns for each mode, and make the test
expect that, e.g. `per-task`. Check whether `landingQueue` includes the holder, and adjust the
`waiting` count so the test reads holder + others.

- [ ] **Step 4: Run it**

Run: `bun test test/board-view.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board/view.ts test/board-view.test.ts && git commit -qm "Board: header, summary and keys

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 6: reading the board's data (`src/board/data.ts`), and Done clears in the registry

**Files:**
- Create: `src/board/data.ts`, `test/board-data.test.ts`
- Modify: `src/lib/boards.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearedFor, recordCleared, runForSlug } from '../src/board/data'
import { beadsSlug } from '../src/lib/beads-project'
import { readBoards, updateBoards } from '../src/lib/boards'
import { newRun, saveRun } from '../src/lib/ledger'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-data-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const run = (repo: string, title: string, phase: 'execute' | 'done', at: number) => {
  const r = newRun({ session: 'personal', socketPath: '/s', repoKey: repo, repoRoot: repo, title })
  r.phase = phase
  r.phase_entered_at = at
  return r
}

test('the board shows its repo\'s unfinished run, else its newest finished one, else nothing', async () => {
  await saveRun(dir, run('/code/a', 'old', 'done', 1))
  await saveRun(dir, run('/code/a', 'newer done', 'done', 5))
  await saveRun(dir, run('/code/b', 'other repo', 'execute', 9))
  expect((await runForSlug(dir, 'personal', beadsSlug('/code/a')))?.title).toBe('newer done')
  await saveRun(dir, run('/code/a', 'live', 'execute', 3))
  expect((await runForSlug(dir, 'personal', beadsSlug('/code/a')))?.title).toBe('live')
  expect(await runForSlug(dir, 'personal', beadsSlug('/code/none'))).toBeNull()
})

test('cleared Done cards are kept per board and forgotten when the run changes', async () => {
  const slug = beadsSlug('/code/a')
  await updateBoards(dir, 'personal', (b) => { b[slug] = { pane_id: 'w9:p4', shell_pid: 1, opened_at_ms: 1 } })
  await recordCleared(dir, 'personal', slug, 'r1', 't1')
  await recordCleared(dir, 'personal', slug, 'r1', 't2')
  expect([...clearedFor(await readBoards(dir, 'personal'), slug, 'r1')]).toEqual(['t1', 't2'])
  expect([...clearedFor(await readBoards(dir, 'personal'), slug, 'r2')]).toEqual([])
  await recordCleared(dir, 'personal', slug, 'r2', 't9')
  expect((await readBoards(dir, 'personal'))[slug]?.cleared).toEqual({ run_id: 'r2', tasks: ['t9'] })
})
```

If `saveRun` needs fields `newRun` doesn't set, or keys the file by something else, follow how
`test/ledger.test.ts` saves runs.

Run: `bun test test/board-data.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `src/lib/boards.ts`, add an optional field to `BoardRecord`. `sameBoard` keeps comparing only the
three identity fields:

```ts
  /** Done cards the user cleared with `x`; only for the run they were cleared in. */
  cleared?: { run_id: string; tasks: string[] }
```

`src/board/data.ts`:

```ts
import { beadsSlug } from '../lib/beads-project'
import { type BoardRegistry, updateBoards } from '../lib/boards'
import { type PaneHold, readPaneHolds } from '../lib/delivery-health'
import { isCurrentSchemaRun, listRuns, runPhaseState } from '../lib/ledger'
import { supervisorState } from '../lib/pidfile'
import type { Run, SessionKey } from '../lib/types'

const newest = (runs: Run[]) => [...runs].sort((a, b) => b.phase_entered_at - a.phase_entered_at)[0] ?? null

// a run in no phase row, or of another schema, would make the board's row lookups throw
export async function runForSlug(stateDir: string, session: SessionKey, slug: string): Promise<Run | null> {
  const runs = (await listRuns(stateDir, session))
    .filter((r) => isCurrentSchemaRun(r) && runPhaseState(r) !== 'unreadable' && beadsSlug(r.repo_key) === slug)
  return newest(runs.filter((r) => runPhaseState(r) === 'live')) ?? newest(runs)
}

export async function loadHolds(stateDir: string, session: SessionKey): Promise<Record<string, PaneHold>> {
  const supervisor = await supervisorState(stateDir, session)
  return readPaneHolds(stateDir, session, supervisor.state === 'live' ? supervisor.info.pid : undefined)
}

export function clearedFor(boards: BoardRegistry, slug: string, runId: string): Set<string> {
  const cleared = boards[slug]?.cleared
  return new Set(cleared?.run_id === runId ? cleared.tasks : [])
}

export async function recordCleared(stateDir: string, session: SessionKey, slug: string, runId: string, taskId: string): Promise<void> {
  await updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board) return
    const tasks = board.cleared?.run_id === runId ? board.cleared.tasks : []
    if (!tasks.includes(taskId)) board.cleared = { run_id: runId, tasks: [...tasks, taskId] }
  })
}
```

If `runPhaseState(r) === 'live'` is not what "unfinished" means for a parked `escalated` run, read
`src/lib/phases.ts` `RUN_ROWS` and choose so an escalated run counts as unfinished. That is
`phase !== 'done'`, as in `supervisor/boards.ts:78`.

- [ ] **Step 3: Run it, then commit**

Run: `bun test test/board-data.test.ts test/board.test.ts && bunx tsc --noEmit`
Expected: PASS. The existing board tests still pass, because `cleared` is optional.

```bash
git add src/board/data.ts src/lib/boards.ts test/board-data.test.ts && git commit -qm "Board: the run, holds and Done clears it reads

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 7: the details popup (`src/board/details.ts`)

**Files:**
- Create: `src/board/details.ts`, `test/board-details.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { detailScreen } from '../src/board/details'

const text = (screen: string) => screen.replace(/\x1b\[[\d;]*[A-Za-z]/g, '\n').split('\n').filter(Boolean)

test('the header, then the detail from the top, scrolled by offset, never touching the last column', () => {
  const body = ['task: t1', 'run: r1', 'branch: b', 'phase: ci'].join('\n')
  const lines = text(detailScreen('hp-7 fix login', body, 40, 4, 0))
  expect(lines[0]).toContain('hp-7 fix login')
  expect(lines[0]).toContain('esc to close')
  expect(lines.slice(1)).toEqual(['task: t1', 'run: r1'])
  expect(text(detailScreen('t', body, 40, 4, 2)).slice(1)).toEqual(['branch: b', 'phase: ci'])
})
```

Run: `bun test test/board-details.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
import { MOCHA } from '../kit/palette'
import { fit, spread } from '../kit/render'
import { listRuns } from '../lib/ledger'
import { sessionKey } from '../lib/session'
import { formatTaskDetail } from '../lib/status'

const HINT = 'details · jk scroll · esc to close'
const put = (row: number, s: string) => `\x1b[${row};1H${s}`

// the last row and column stay empty: a glyph there makes the terminal scroll the popup
export function detailScreen(title: string, body: string, cols: number, rows: number, offset: number): string {
  const width = cols - 1
  const shown = body.split('\n').slice(offset, offset + Math.max(0, rows - 2))
  let text = put(1, spread({ text: title, color: MOCHA.peach, bold: true }, [{ text: HINT, color: MOCHA.overlay0 }], width))
  for (let i = 0; i < rows - 2; i++) text += put(i + 2, fit((shown[i] ?? '').replace(/[\x00-\x1f\x7f]/g, ''), width))
  return text
}

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? ''
  const run = (await listRuns(stateDir, sessionKey(process.env))).find((r) => r.run_id === process.env.HPIPE_DETAIL_RUN)
  const task = run?.tasks.find((t) => t.task_id === process.env.HPIPE_DETAIL_TASK)
  const title = task ? `${task.bead} ${task.brief.title}` : 'details'
  const body = run && task ? formatTaskDetail(run, task) : 'that task is gone'
  let offset = 0
  const lines = body.split('\n').length
  const draw = () => process.stdout.write('\x1b[2J' + detailScreen(title, body, process.stdout.columns ?? 80, process.stdout.rows ?? 24, offset))
  const quit = () => {
    process.stdout.write('\x1b[2J\x1b[?25h')
    process.exit(0)
  }
  // herdr closes a popup only when its process exits
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', (data) => {
    const key = data.toString()
    if (key === 'j' || key === '\x1b[B') offset = Math.min(Math.max(0, lines - 1), offset + 1)
    else if (key === 'k' || key === '\x1b[A') offset = Math.max(0, offset - 1)
    else return quit()
    draw()
  })
  process.stdin.on('end', quit)
  process.on('SIGHUP', quit)
  process.stdout.on('resize', draw)
  process.stdout.write('\x1b[?25l')
  draw()
}

if (import.meta.main) await main()
```

- [ ] **Step 3: Run it, then commit**

Run: `bun test test/board-details.test.ts && bunx tsc --noEmit`
Expected: PASS.

```bash
git add src/board/details.ts test/board-details.test.ts && git commit -qm "Board: the task details popup

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 8: the board UI, with bv removed from the board pane

**Files:**
- Create: `src/board/ui.ts`
- Modify: `src/board.ts`, `test/board.test.ts`, `herdr-plugin.toml`, `README.md`

- [ ] **Step 1: Rewrite the board-pane tests**

In `test/board.test.ts`:
- **Keep every `syncBoards`, `openBoard` and "Open board" test unchanged.**
- **Delete the bv-specific tests:**
  - "runs bv on the export"
  - "no bv installed exits 1 with the install hint"
  - "waits while the export is missing or empty"
  - "bv quitting at once on an empty export…"
  - "brings the store's history up to date…"
  - "a history the board cannot record still lets bv start"
  - "bv exiting after a long session…"
- **Rewrite the remaining board-pane tests** against the new deps: `env`, `parentPid`, `now`,
  `renamePane`, `updateBoards`, `error`, and `runUi`. `runUi` receives
  `{ stateDir, session, slug }` and returns a number:
  - "the board pane records its pane and shell, renames itself, then runs the board UI for its slug": `runUi` is called once with the slug and the record is written.
  - "the board pane keeps the opened_at_ms the supervisor recorded".
  - "a board pane that cannot record itself stays unrenamed and still runs the UI".
  - "a board pane without HERDR_PANE_ID says so and still runs the UI".
  - "a board pane missing its slug exits 1 without running the UI".
- **Remove the `BV_INSTALL_HINT` import.**

Run: `bun test test/board.test.ts`
Expected: FAIL, because `BoardPaneDeps` still has the bv fields and no `runUi`.

- [ ] **Step 2: Slim down `src/board.ts`**

```ts
import { boardLabel, updateBoards } from './lib/boards'
import { Herdr } from './lib/herdr'
import { sessionKey } from './lib/session'
import type { SessionKey } from './lib/types'

export interface BoardUiOptions {
  stateDir: string
  session: SessionKey
  slug: string
}

export interface BoardPaneDeps {
  env: Record<string, string | undefined>
  /** The pane's shell: it is exec'd into the user's shell when the board exits, keeping its pid. */
  parentPid: number
  now: () => number
  /** The pane and the tab it opened in. */
  renamePane: (paneId: string, label: string) => Promise<unknown>
  updateBoards: typeof updateBoards
  runUi: (options: BoardUiOptions) => Promise<number>
  error: (message: string) => void
}

const processDeps = (): BoardPaneDeps => ({
  env: process.env,
  parentPid: process.ppid,
  now: Date.now,
  renamePane: async (paneId, label) => {
    const herdr = new Herdr()
    await herdr.paneRename(paneId, label)
    await herdr.renameTabOf(paneId, label)
  },
  updateBoards,
  runUi: async (options) => (await import('./board/ui')).runBoardUi(options),
  error: console.error,
})

/**
 * Records the board, then renames it — in that order, because the supervisor
 * closes a renamed board that no record names as a ghost. A board that cannot
 * record itself keeps its plain label and still runs: the human gets a board,
 * and the supervisor's grace rule settles the record.
 */
export async function runBoardPane(deps: BoardPaneDeps = processDeps()): Promise<number> {
  const stateDir = deps.env.HERDR_PLUGIN_STATE_DIR
  const slug = deps.env.HPIPE_BEADS_SLUG
  const paneId = deps.env.HERDR_PANE_ID
  if (!stateDir || !slug) {
    deps.error('[pipeline] the board needs HERDR_PLUGIN_STATE_DIR and HPIPE_BEADS_SLUG')
    return 1
  }
  if (!paneId) {
    deps.error('[pipeline] no HERDR_PANE_ID, so this board cannot record itself for the supervisor')
  } else {
    try {
      await deps.updateBoards(stateDir, sessionKey(deps.env), (boards) => {
        boards[slug] = { ...boards[slug], pane_id: paneId, shell_pid: deps.parentPid, opened_at_ms: boards[slug]?.opened_at_ms ?? deps.now() }
      })
      await deps.renamePane(paneId, boardLabel(slug))
    } catch (error) {
      deps.error(`[pipeline] this board could not record itself for the supervisor: ${error}`)
    }
  }
  return deps.runUi({ stateDir, session: sessionKey(deps.env), slug })
}

if (import.meta.main) process.exit(await runBoardPane())
```

The `...boards[slug]` spread keeps a `cleared` list across a board restart. The old code replaced the
record whole.

Run: `bun test test/board.test.ts && bunx tsc --noEmit`
Expected: the board tests pass. tsc fails only because `./board/ui` is missing, which the next step
adds.

- [ ] **Step 3: Write `src/board/ui.ts`**

This is I/O glue. It follows pasture's `src/board.ts` (read it for the patterns) with the pipeline's
data:

```ts
import { CELL_QUERY, FrameWriter, takeCellReply } from '../kit/frame'
import { createClient, readSnapshot, subscribe, type Subscription } from '../kit/herdr'
import { deleteAllImages } from '../kit/kitty'
import { COLUMNS, moveCursor, type Column, type Direction } from '../kit/nav'
import { openPeek } from '../kit/peek'
import { render, type CardView } from '../kit/render'
import type { Identity } from '../kit/stage'
import { createThrottle } from '../kit/throttle'
import type { Snapshot } from '../kit/types'
import type { BoardUiOptions } from '../board'
import { readBoards } from '../lib/boards'
import { readDispatchLocks } from '../lib/dispatch-lock'
import { taskRow } from '../lib/phases'
import { waitsOnYou } from '../lib/status'
import type { Run } from '../lib/types'
import { clearedFor, loadHolds, recordCleared, runForSlug } from './data'
import { buildBoard } from './model'
import './scenes'
import { header, KEYS, summary, TITLES } from './view'

export const PIPELINE: Identity = { pluginId: 'stein.pipeline', placeholderEntrypoint: 'placeholder', peekEntrypoint: 'peek', stageName: 'pipeline' }

const EMPTY: Record<Column, CardView[]> = { needs: [], working: [], done: [], idle: [] }
const LIFECYCLE = [
  'pane.created', 'pane.closed', 'pane.moved', 'pane.exited', 'pane.updated', 'pane.agent_detected',
  'tab.closed', 'workspace.closed', 'workspace.focused',
]
const NAV: Record<string, Direction> = {
  h: 'left', l: 'right', j: 'down', k: 'up',
  '\x1b[D': 'left', '\x1b[C': 'right', '\x1b[B': 'down', '\x1b[A': 'up',
}

export function runBoardUi({ stateDir, session, slug }: BoardUiOptions): Promise<number> {
  const herdr = createClient()
  const writer = new FrameWriter()
  const out = (s: string) => process.stdout.write(s)
  let snap: Snapshot | null = null
  let run: Run | null = null
  let board = EMPTY
  let orchestratorLive = true
  let cursor: string | null = null
  let message: string | null = null
  let tick = 0

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
  let chain: Promise<void> = Promise.resolve()
  const serial = (job: () => Promise<void>) => (chain = chain.then(job).catch((e) => { message = errorText(e) }))

  async function refresh(): Promise<void> {
    const current = await readSnapshot(herdr)
    snap = current
    run = await runForSlug(stateDir, session, slug)
    if (!run) {
      board = EMPTY
      return
    }
    const found = run
    const holds = await loadHolds(stateDir, session)
    const dispatches = await readDispatchLocks(stateDir, [found.repo_key])
    const livePanes = new Set(current.panes.map((p) => p.pane_id))
    const ctx = new Map<string, number>()
    for (const p of current.panes) {
      const value = Number.parseFloat(p.tokens?.ctx ?? '')
      if (Number.isFinite(value)) ctx.set(p.pane_id, Math.round(value))
    }
    orchestratorLive = found.orchestrator_pane !== null && livePanes.has(found.orchestrator_pane)
    board = buildBoard({
      run: found, holds, livePanes, ctx,
      orchestratorsMove: (task) => waitsOnYou(found, task, Date.now(), holds, dispatches),
      cleared: clearedFor(await readBoards(stateDir, session), slug, found.run_id),
    })
    ensureSubscription(current)
  }

  let refreshQueued = false
  function queueRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    void serial(async () => {
      refreshQueued = false
      await refresh()
    }).then(draw)
  }
  // herdr emits events in bursts, and each refresh reads the ledger and a snapshot
  const requestRefresh = createThrottle(queueRefresh, 400)

  let unsubscribe: (() => void) | null = null
  let subscribedPanes = ''
  // agent_status_changed subscriptions need a pane id each, and pane ids change on every move
  function ensureSubscription(current: Snapshot): void {
    const panes = current.agents.filter((a) => a.agent).map((a) => a.pane_id).sort()
    const key = panes.join(',')
    if (unsubscribe && key === subscribedPanes) return
    unsubscribe?.()
    subscribedPanes = key
    const subs: Subscription[] = [...LIFECYCLE.map((type) => ({ type })), ...panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }))]
    unsubscribe = subscribe(subs, requestRefresh, () => {
      unsubscribe = null
      setTimeout(requestRefresh, 1000)
    })
  }

  const cards = () => COLUMNS.flatMap((c) => board[c])
  const selected = () => cards().find((c) => c.id === cursor) ?? null

  function draw(): void {
    if (!selected()) cursor = moveCursor(board, null, 'down')
    const frame = render(
      { board, cursor, header: header(run, orchestratorLive), summary: summary(board), keys: KEYS, titles: TITLES, message, now: Date.now(), tick, cell: writer.cell },
      process.stdout.columns ?? 120, process.stdout.rows ?? 40,
    )
    const screen = writer.write(frame)
    if (screen) out(screen)
  }

  async function peekWorker(card: CardView): Promise<void> {
    const task = run?.tasks.find((t) => t.task_id === card.id)
    const pane = task?.pane_id ? snap?.panes.find((p) => p.pane_id === task.pane_id) : undefined
    if (!task || !pane) {
      message = 'no worker to peek at'
      return
    }
    await openPeek(herdr, PIPELINE, { terminalId: pane.terminal_id, title: card.title, where: `${run!.title} · ${task.phase}` })
  }

  async function peekOrchestrator(): Promise<void> {
    const pane = run?.orchestrator_pane ? snap?.panes.find((p) => p.pane_id === run!.orchestrator_pane) : undefined
    if (!run || !pane) {
      message = 'orchestrator is not running'
      return
    }
    await openPeek(herdr, PIPELINE, { terminalId: pane.terminal_id, title: 'orchestrator', where: run.title })
  }

  async function openDetails(card: CardView): Promise<void> {
    if (!run || card.id.startsWith('run:')) return
    await herdr.call('plugin.pane.open', {
      plugin_id: PIPELINE.pluginId, entrypoint: 'details', placement: 'popup', width: '80%', height: '70%', focus: true,
      env: { HPIPE_DETAIL_RUN: run.run_id, HPIPE_DETAIL_TASK: card.id },
    })
  }

  function quit(): never {
    out(deleteAllImages() + '\x1b[2J\x1b[?25h')
    process.exit(0)
  }

  function onKey(key: string): void {
    const card = selected()
    message = null
    if (key === '\x03' || key === 'q') quit()
    const direction = NAV[key]
    if (direction) cursor = moveCursor(board, cursor, direction)
    else if (key === ' ' && card) void serial(() => peekWorker(card)).then(draw)
    else if (key === 'o') void serial(peekOrchestrator).then(draw)
    else if (key === 'd' && card) void serial(() => openDetails(card))
    else if (key === 'x' && card?.column === 'done' && run) {
      const runId = run.run_id
      void serial(() => recordCleared(stateDir, session, slug, runId, card.id)).then(requestRefresh)
    }
    draw()
  }

  // a closed pty must end the process, or a headless board keeps running
  process.stdin.on('end', quit)
  process.stdin.on('error', quit)
  process.stdout.on('error', () => process.exit(0))
  process.on('SIGHUP', quit)
  // a dead board leaves the user without one, so errors are shown in the status line instead
  process.on('uncaughtException', (e) => { message = errorText(e); try { draw() } catch {} })
  process.on('unhandledRejection', (e) => { message = errorText(e); try { draw() } catch {} })

  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', (data) => {
    const { rest, cell } = takeCellReply(data.toString())
    if (cell) writer.setCell(cell)
    if (rest) onKey(rest)
    else draw()
  })
  process.stdout.on('resize', () => {
    writer.invalidate()
    out(CELL_QUERY)
    draw()
  })
  out('\x1b[?25l' + CELL_QUERY)
  requestRefresh()
  // the ledger changes without any herdr event
  setInterval(requestRefresh, 2000)
  setInterval(() => {
    tick++
    draw()
  }, 250)
  return new Promise<number>(() => {})
}
```

Two adaptations against the real code:
- If `taskRow` ends up unused, drop its import.
- `waitsOnYou`'s argument order is `(run, task, now, holds, dispatches)` (`src/lib/status.ts:380`).

The `return new Promise(() => {})` is deliberate: the board runs until `quit()` exits the process.

- [ ] **Step 4: Register the popups and raise the herdr floor**

`herdr-plugin.toml`:
- `min_herdr_version = "0.9.1"`. The kit is verified on 0.9.1.
- Add:

  ```toml
  [[panes]]
  id = "peek"
  title = "Peek"
  placement = "popup"
  width = "70%"
  height = "60%"
  command = ["bun", "run", "src/kit/peek.ts"]

  [[panes]]
  id = "details"
  title = "Task details"
  placement = "popup"
  width = "80%"
  height = "70%"
  command = ["bun", "run", "src/board/details.ts"]
  ```

- [ ] **Step 5: Update the README**

- Line 32: the requirement becomes `bv` only for `hpipe next`, and herdr becomes 0.9.1+.
- Line 55: "reopen the repo's board tab".
- §"The board" (around line 459): describe the new board in place of bv:
  - the four columns, with Needs you meaning what you owe
  - run cards
  - the phase animations
  - keys: `hjkl`, `space` peek, `o` orchestrator, `d` details, `x` clear
  - read-only
- Keep the history and licence paragraphs, reworded so they name `hpipe next` rather than the board.
- The "Never install `br`" warning stays, scoped to `hpipe next`.

- [ ] **Step 6: Verify and commit**

Run: `bun test && bunx tsc --noEmit && grep -n "runBv\|recordHistory\|bvBin" src/board.ts src/board/*.ts`
Expected: all tests pass, no tsc output, and the grep prints nothing.

```bash
git add -A src herdr-plugin.toml README.md test/board.test.ts && git commit -qm "Board: pasture's kanban in place of bv

Claude-Session: https://claude.ai/code/session_01F3fK9crsjyHWqkitgk6oUs"
```

---

### Task 9: live check against a copy of the real ledger

The board records itself in the board registry and renames its pane. So it never runs against the
real state dir; the supervisor would take it for its own board.

- [ ] **Step 1: Copy the state, then pick a slug**

```bash
REAL=$(ls -d ~/.local/state/herdr/plugins/stein.pipeline* 2>/dev/null | head -1)
COPY=$TMPDIR/pipeline-state-copy && rm -rf $COPY && cp -R "$REAL" $COPY
ls $COPY/runs/*/ | head; ls $COPY/beads/
```

If the state dir lives elsewhere, find it from a running supervisor's env (`herdr pane process-info`
on the supervisor pane), or from `hpipe status`.

- [ ] **Step 2: Run the board read-only in a throwaway workspace**

```bash
R=$(herdr workspace create --label board-check --no-focus); WS=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['root_pane']['workspace_id'])")
herdr pane run $WS:p1 "HERDR_PLUGIN_STATE_DIR=$COPY HPIPE_BEADS_SLUG=<slug> HERDR_SESSION=boardcheck bun run $PWD/src/board.ts"
sleep 4; herdr pane read $WS:p1 --source visible | head -12
```

Expected: the header names the slug's run, or says `no run in this repo`. The four columns are
tinted, with Idle titled `○ Idle/queued`, and the summary line ends with the plan-3 key hints. With
`HERDR_SESSION=boardcheck` the board reads `runs/boardcheck/`. If the copied runs live under another
session key, set `HERDR_SESSION` to that key instead. Read `src/lib/session.ts`.

- [ ] **Step 3: Ask the user to look**

Ask the user to look at the `board-check` workspace and check:
- the cards
- the phase animations
- `space` (peek) on a card whose worker is live
- `d` (details)
- `o` (orchestrator peek)

Then close it with `herdr workspace close $WS`.

- [ ] **Step 4: Report**

There is no commit. Report what the live check showed. Release (a version bump through
release-please, and installing the new release) is a separate step for the user.
