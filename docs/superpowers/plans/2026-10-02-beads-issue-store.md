# Beads as the Issue Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GitHub Issues with one embedded Beads (`bd` ≥ 1.3.1) database per project, kept in the plugin's state dir and written only by hpipe, with a desired-state reconciler in the supervisor, a per-project `bv` board tab, and `hpipe next` triage.
**Architecture:** A `Bd` wrapper (`src/lib/bd.ts`) is the only thing that spawns `bd`: per-call pid-file lock, 30 s kill, `--json --actor hpipe`, export after writes. Only `create`, the adoption `show` and the dispatch `claim` run synchronously in the CLI; everything else is derived by the pure `desiredBead()` (`src/lib/bead-desired.ts`) from the ledger and converged by `syncBeads()` (`src/supervisor/beads-sync.ts`) once per tick after the advance loop. The ledger moves to `schema_version: 3`: `Task.issue` becomes `Task.bead` plus a captured `brief`, and the close row advances on `bead_closed_at_ms`, which only the reconciler sets.
**Tech Stack:** Bun + TypeScript (no runtime dependencies), `bun test`, `tsc --noEmit` via `bun run typecheck`, the `bd` 1.3.1 and `bv` 0.25.2 CLIs, `herdr` 0.9.x, `gh` for PRs/CI/merge only, Markdown prompt templates rendered by `src/lib/render.ts`.
**Spec:** `docs/superpowers/specs/2026-10-02-beads-issue-store-design.md` (pass 3, approved). Read it first; this plan does not re-argue it.

---

**On-disk format change.** Task 5 moves the ledger to `schema_version: 3`. The supervisor already
skips runs whose schema it does not know (`src/supervisor/main.ts:50-52,200-203`); after Task 5
`runForRepo` skips them too, so a leftover v2 run never blocks `hpipe start`. v2 runs are not
migrated (spec header).

**Self-hosting hazard.** Never link `src/cli.ts` onto your PATH and never run the checkout's
`src/cli.ts` against live state. Every test runs against temp dirs; the argv tests pin
`HERDR_PLUGIN_STATE_DIR`, `HERDR_SESSION`, `BD_BIN` and `BV_BIN` exactly as `test/cli-argv.test.ts`
does after Task 4. No test may spawn the real `bd` or `bv`.

**bv's licence.** bv ships under MIT plus a rider that withholds all rights from, and forbids making it
available to or for, Anthropic and anyone acting for its benefit, and counts executing it as use
(`bv/LICENSE`). An agent implementing this plan never installs or executes a real `bv`: every test uses
a fake, and the spike and smoke steps that run the real binary are marked **(human)** and are performed
by the user, who has read the rider.

**Code style (put this in every implementer subagent's prompt).** Code must be self-documenting
through names. Do not add comments that restate what the code does. A comment earns its place only
for a non-obvious *why* — a constraint, a gotcha, a workaround, a decision that would otherwise look
arbitrary. Keep this repo's existing doc-comment habit for exported functions whose contract is not
obvious from the signature. Match the surrounding code's idioms: `retryingOnStale` commands, `fail()`
/ `ok()` results, DI through default parameters, `makeFakeBin` fakes.

**Every step:** run the named test file, then before each commit the whole suite and the typecheck:

```bash
bun test && bun run typecheck
```

Both must be green before every commit. **Line numbers** in each task's **Files** list are as of
`f23b0df` (this spec's branch tip; `src/` is identical to `main` at `31e6b2d`), before any task runs;
once an earlier task has edited a file, find the spot by the quoted anchor text instead. Work on a
feature branch, `feat/beads-issue-store`, never on `main`. Commit with exactly the `git commit` command
each task gives (every message ends with the `Claude-Session:` trailer). PR title (squash-merged,
parsed by release-please — see the repo's `conventional-pr-titles` skill):
`feat!: replace GitHub Issues with Beads as the issue store` — the `!` because v2 runs stop advancing.

FILES: src/cli.ts, src/startup.ts, src/board.ts
FILES: src/lib/beads-project.ts, src/lib/bd.ts, src/lib/spawn.ts, src/lib/tools.ts, src/lib/held.ts
FILES: src/lib/beads-setup.ts, src/lib/bead-desired.ts, src/lib/bead-claim.ts, src/lib/bead-view.ts
FILES: src/lib/next.ts, src/lib/bv.ts, src/lib/boards.ts
FILES: src/lib/types.ts, src/lib/ledger.ts, src/lib/decisions.ts, src/lib/gating.ts, src/lib/gh.ts
FILES: src/lib/tiers.ts, src/lib/verdict-path.ts, src/lib/worker-prompt.ts, src/lib/status.ts
FILES: src/lib/awaiting.ts, src/lib/machine.ts, src/lib/phases.ts, src/lib/herdr.ts
FILES: src/supervisor/main.ts, src/supervisor/tasks.ts, src/supervisor/tick.ts, src/supervisor/deliver.ts
FILES: src/supervisor/stall.ts, src/supervisor/beads-sync.ts, src/supervisor/boards.ts
FILES: src/actions/beads-setup.ts, src/actions/board.ts, src/actions/status.ts
FILES: prompts/, herdr-plugin.toml, README.md, skills/herdr-pipeline/SKILL.md
FILES: test/, docs/superpowers/research/2026-10-02-beads-spikes.md

## Resolutions and deviations

Each is forced by the code or by a spec gap; none changes the design.

1. **Task order differs from the spec's section order.** `held.ts` (Task 3) reads run files
   structurally, so it lands before the schema switch; `bead-desired.ts` (Task 6) needs
   `Task.bead` and `Decision.escalated_at`, so it lands after it (Task 5). Setup (Task 4) touches no
   `Task` field and lands before the switch.
2. **The close row's machine signal and the rewind's clearing of `bead_closed_at_ms` land in Task 5,
   not Task 9.** `issueView(task.issue)` cannot compile once `issue` is gone, so the close signal
   must switch in the same commit; the rewind line it replaces (`issue_closed_at_entry = false`,
   `src/cli.ts:760`) becomes `bead_closed_at_ms = null` there. Task 9 does the rest of §8's close
   row (no actor, no prompt, `probeTarget`, stall variants, `hpipe close`).
3. **`Bd.comment(id, text)` and `Bd.close(id, reason, {force})` take text**, write it to a temp file
   inside the store dir, and pass `--file` / `--reason-file` — the exact bd argv of spec §2's table.
   `Bd.create` does the same for `--body-file`, as §2 already says.
4. **`hpipe escalate` takes `--recommend <text>`** and stores it in a new
   `Decision.orchestrator_recommendation: string | null`. §5 requires the question comment to carry
   "worker's and orchestrator's recommendations"; the ledger had nowhere to hold the latter.
5. **`bv`'s `top_pick` has `unblocks` (a count), not `unblocks_ids`** (bv `pkg/analysis/triage.go:111-117,1877-1883`;
   spec §4 and its Evidence row say `top_pick{reasons, unblocks_ids}`). `hpipe next` prints the
   unblocked IDs from the track recommendation with the top pick's ID, which carries `unblocks_ids`
   (`triage.go:133`).
6. **One threshold, `BEAD_SYNC_ALERT_FAILURES = 5`, compared with `>=`,** for both the status line
   (§5 "more than 5") and the close stall clause (§8 "`failures < 5`" vs otherwise). A converged write
   clears `bead_sync.last_error` (failures stays monotone), so "out of sync" means
   `failures >= 5 && last_error !== null`.
7. **The setup action's prefix override is `HPIPE_BEADS_PREFIX`.** herdr actions take no input
   (`herdr plugin action invoke --help` has no input option); `hpipe start --prefix` is unchanged.
8. **Adoption refuses any open dependent**, of any edge type, as §4 says literally — stricter than
   bd's open-children guard, never weaker.
9. **The dispatch pre-claim reset is `update -s open --assignee ""`**, not just `-s open`: `--claim`
   only takes an unassigned `open` bead (§4 "assigned-but-`open`").
10. **`desiredBead`'s release row uses the held predicate** (§3: "the reconciler's release rule …
    use[s] this one predicate"), so a task rewound to `done` without a merge releases its bead.
11. **The board record carries `opened_at_ms`** and a `pane_id: null` placeholder written before
    `herdr plugin pane open`, so the next tick does not open a second board while `board.ts` boots;
    a placeholder older than 30 s counts as a dead board.
12. **`isCurrentSchemaRun` moves to `src/lib/ledger.ts`** beside a new `SCHEMA_VERSION = 3`, because
    `runForRepo` needs it and `src/lib/` must not import `src/supervisor/`.
13. **`hpipe bead show` and `hpipe next` always resolve the repo from the cwd** (they address a
    store, not a run).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/beads-project.ts` | Create | slug, default/normalised prefix, store paths, spawn env, `project.json`, prefix ownership, durability scan |
| `src/lib/spawn.ts` | Create | `runBounded`: one spawn with a kill timer, never throws |
| `src/lib/tools.ts` | Create | `bd`/`bv` binaries, version checks, `tools:` line |
| `src/lib/bd.ts` | Create | `Bd`: argv, env/cwd, lock, export, every §2 method, `readExport` |
| `src/lib/held.ts` | Create | the held predicate across every session's run files |
| `src/lib/beads-setup.ts` | Create | the setup flow: prefix checks, git guard, init, `project.json` |
| `src/lib/bead-desired.ts` | Create | `desiredBead()`, label namespaces, comment markers, sync alert threshold |
| `src/lib/bead-claim.ts` | Create | `claimForDispatch`: reset then claim |
| `src/lib/bead-view.ts` | Create | `formatBeadDetail` for `hpipe bead show` |
| `src/lib/next.ts` | Create | bv triage types and `formatNext` |
| `src/lib/bv.ts` | Create | `bvSpawnEnv`, `bvTriage` |
| `src/lib/boards.ts` | Create | `boards.<session>.json`, board labels |
| `src/supervisor/beads-sync.ts` | Create | `callsFor`, `syncBeads`, its ledger effects |
| `src/supervisor/boards.ts` | Create | per-slug board lifecycle, `openBoard` |
| `src/board.ts` | Create | the board pane's process: rename, record, run bv |
| `src/actions/beads-setup.ts`, `src/actions/board.ts` | Create | the two new herdr actions |
| `src/lib/types.ts` | Modify | `Task.bead`, `brief`, `bead_closed_at_ms`, `bead_sync`, `discoveries`; `Decision.escalated_at`, `orchestrator_recommendation` |
| `src/lib/ledger.ts` | Modify | `SCHEMA_VERSION`, `isCurrentSchemaRun`, `runForRepo` skips other schemas |
| `src/cli.ts` | Modify | `start --prefix`, `task --bead/--title`, dispatch claim, `escalate`, `close`, `bead show`, `next`, `discover`, `discoveries`, status tools line |
| `src/supervisor/main.ts` | Modify | reconciler and board upkeep after the advance loop |
| others in FILES | Modify | as each task states |

---

### Task 0: Verification spikes (spec §11)

Manual. Nothing here is committed except the research note. Each spike either confirms the design
or names the task that changes.

**Files:**
- Create: `docs/superpowers/research/2026-10-02-beads-spikes.md`

- [ ] **Step 1: Check the installed versions**

Run:

```bash
bd version; herdr --version; command -v bv && bv --version
```

Expected: `bd version 1.3.1` or newer. **If `bd` is older (this machine had 1.0.4), stop and ask the
user before running `brew upgrade beads`** — do not upgrade on your own. If `bv` is missing, do not
install it: ask the user to run `brew install dicklesworthstone/tap/bv` themselves after reading its
licence (see the header note). Record every version in the note.

- [ ] **Step 2: Spike 1 — bd as actor `hpipe` against a scratch store**

Run, from a fresh shell (the variables matter; `SPIKE` must not be inside any git work tree):

```bash
SPIKE=$(mktemp -d)
mkdir -p "$SPIKE/beads/spike"
cd "$SPIKE/beads/spike"
export BEADS_DIR="$SPIKE/beads/spike/.beads" GIT_CEILING_DIRECTORIES="$SPIKE/beads"
B='bd --json --actor hpipe'
$B init --prefix spike --skip-agents --skip-hooks --non-interactive; echo "init=$?"
$B config set issue_id_mode counter; echo "config=$?"
printf 'Body line one.\n' > body.md
$B create --title "Spike one" --body-file body.md --acceptance "it works" -l alpha -l beta; echo "create1=$?"
$B create --title "Spike two" --body-file body.md; echo "create2=$?"
$B show spike-1 --include-comments --include-dependents; echo "show=$?"
$B update spike-1 --claim; echo "claim=$?"
$B update spike-1 -s blocked --assignee hpipe --add-label 'hpipe:run=r1' --add-label phase:plan --remove-label alpha; echo "fold=$?"
$B update spike-1 -s in_progress; echo "unblock=$?"
$B update spike-1 --assignee "" -s open; echo "release=$?"
$B update spike-1 --claim; echo "reclaim=$?"
$B dep add spike-2 spike-1 --type blocks; echo "dep=$?"
printf 'Question for the human.\n\n[hpipe t1/d1/asked]\n' > comment.md
$B comment spike-1 --file comment.md; echo "comment=$?"
printf 'merged in PR #1 (abc1234)\n' > reason.md
$B close spike-1 --reason-file reason.md; echo "close=$?"
$B reopen spike-1; echo "reopen=$?"
$B update spike-1 --claim; echo "claim-after-reopen=$?"
$B close spike-1 --reason-file reason.md; echo "close-again=$?"
$B update spike-2 --claim; echo "claim2=$?"
bd --json --actor someone-else close spike-2 --reason-file reason.md; echo "foreign-close=$?"
$B export -o "$BEADS_DIR/issues.jsonl"; echo "export=$?"
cat "$BEADS_DIR/issues.jsonl"
```

Expected: every `=0` except `foreign-close`, which bd refuses with an "assignee is \"hpipe\", actor
is \"someone-else\"" error (record the text verbatim — it is what `hpipe close` will relay). In
`issues.jsonl`: one line per bead with `"_type":"issue"`,
spike-1's `labels` holding `beta`, `hpipe:run=r1`, `phase:plan`, its `comments[].text` holding the
marker, and spike-2's `dependencies` holding `{"depends_on_id":"spike-1","type":"blocks"}`. Record:
the exact `show` JSON shape (an array; the `dependencies`/`dependents` entries' `dependency_type`
and `status` keys), the `create` JSON (`id`), the stderr warning line text bd prints outside git
(the plan filters lines containing `beads.role`), and every exit code.

- [ ] **Step 3: Spike 2 — the board with `phase:` labels (human)**

Ask the user to run, in the same shell:

```bash
bd --json --actor hpipe update spike-2 -s deferred
bv --db "$BEADS_DIR/issues.jsonl"
```

and to press `b` for the kanban, then report: are `phase:` / `hpipe:` labels legible on a card; does
`deferred` (a status outside open / in_progress / blocked / closed) get a column? Record the answers.
The design depends on neither (§4 uses only the four built-in statuses); a "no" to the first goes in
the README's board paragraph in Task 14.

- [ ] **Step 4: Spike 3 — herdr plugin pane `--env`/`--cwd` and `pane rename`**

Run (a throwaway plugin so nothing of `stein.pipeline` starts):

```bash
PROBE=$(mktemp -d)
cat > "$PROBE/herdr-plugin.toml" <<'TOML'
id = "stein.spike"
name = "Spike"
version = "0.0.1"
min_herdr_version = "0.9.0"
description = "Probes plugin pane env and cwd"
platforms = ["macos", "linux"]

[[panes]]
id = "probe"
title = "Board"
placement = "tab"
command = ["sh", "-c", "echo PROBE=$HPIPE_PROBE PANE=$HERDR_PANE_ID CWD=$(pwd); exec \"${SHELL:-/bin/sh}\""]
TOML
herdr plugin link "$PROBE"
WS=$(herdr workspace create --label beads-spike --no-focus | sed -n 's/.*"workspace_id":"\([^"]*\)".*/\1/p')
herdr pane list --workspace "$WS"
herdr plugin pane open --plugin stein.spike --entrypoint probe --placement tab --no-focus \
  --workspace "$WS" --cwd "$SPIKE" --env HPIPE_PROBE=yes
herdr pane list --workspace "$WS"
```

Take the new pane's id from the second `pane list`, then:

```bash
herdr pane read <new-pane-id> --source recent --lines 20 --format text
herdr pane rename <new-pane-id> "Board: spike abc123"
herdr pane list --workspace "$WS"
herdr pane process-info --pane <new-pane-id>
herdr plugin pane open --plugin stein.spike --entrypoint probe --placement tab --no-focus --workspace "$WS"
```

Expected: the read shows `PROBE=yes PANE=<that id> CWD=<$SPIKE>`; after the rename `pane list`
shows the label `Board: spike abc123`; `process-info` prints a `shell_pid`. Record the JSON the
`plugin pane open` call prints (whether it names the new pane). Clean up: close every pane in `$WS`
with `herdr pane close <id>` (closing the last destroys the workspace), then
`herdr plugin unlink stein.spike` and `rm -rf "$PROBE" "$SPIKE"`.

- [ ] **Step 5: Write the research note**

Create `docs/superpowers/research/2026-10-02-beads-spikes.md` with: the versions (Step 1); for each
spike, the commands as run, the outputs that matter, and PASS / FAIL. Then a section
**"What changes if a spike failed"**, filled in from this table for every FAIL:

| Spike result | Change |
|---|---|
| bd < 1.3.1 and the user declines the upgrade | Stop: the close guards §8 relies on do not exist. Tell the user |
| `update --assignee "" -s open` refused on an `in_progress` claim | Stop and bring it to the user: §5's release row has no fallback (`unclaim` is not idempotent, spec Evidence) |
| `claim-after-reopen` fails | Task 7's `claimForDispatch` already resets first; additionally make Task 8's `callsFor` emit `update -s open --assignee ""` before any `-s in_progress` that follows a `reopen` |
| `close` without `--force` refused for actor `hpipe` on its own claim | Stop: decision 6 does not hold |
| `issues.jsonl` lacks labels, dependencies or comment text | Task 8 cannot use `readExport()` as actual state: change `syncBeads` to call `bd.show(task.bead)` per task under the budget, and tell the user (more spawns per tick) |
| `show` JSON is not an array, or link entries lack `status` / `dependency_type` | Adjust `BeadDetail` / `LinkedBead` and `Bd.show`'s parse in Task 2 to the recorded shape |
| `create` JSON lacks `id` | Adjust `Bd.create`'s parse in Task 2 to the recorded shape |
| The stderr warning does not contain `beads.role` | Change `failureText`'s filter in Task 2 to the recorded text |
| `--env` does not reach the pane, or `--cwd` is ignored | Task 13: `board.ts` falls back to `basename(process.cwd())` for the slug only if `--cwd` works; if neither works, stop and bring §9 to the user |
| `HERDR_PANE_ID` is unset in a plugin pane | Stop and bring §9 to the user: `board.ts` cannot record or rename itself |
| `pane rename` fails on a plugin pane | Task 13: drop `paneRename` from `board.ts`; boards keep the label `Board`, which `clearStrayPanes` already spares |

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/research/2026-10-02-beads-spikes.md
git commit -m "docs: record the Beads verification spikes

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 1: `src/lib/beads-project.ts` — slug, prefix, store paths, durability

**Files:**
- Create: `src/lib/beads-project.ts`
- Test: `test/beads-project.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/beads-project.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beadsDir, beadsExportPath, beadsHome, beadsSlug, beadsSpawnEnv, defaultPrefix, normalisePrefix,
  prefixCollisions, prefixOwner, readBeadsProject, writeBeadsProject,
} from '../src/lib/beads-project'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'beads-project-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('the slug is the sanitised repo name and six hex chars of the repo key\'s hash', () => {
  const slug = beadsSlug('/Users/x/Code/Herdr Plugin')
  expect(slug).toMatch(/^herdr-plugin-[0-9a-f]{6}$/)
  expect(beadsSlug('/Users/x/Code/Herdr Plugin')).toBe(slug)
  expect(beadsSlug('/Users/y/Code/Herdr Plugin')).not.toBe(slug)
  expect(beadsSlug('/')).toMatch(/^repo-[0-9a-f]{6}$/)
})

test('the default prefix is the name cut to eight characters, with a trailing dash trimmed as bd does', () => {
  expect(defaultPrefix('/x/herdr-plugin-pipeline')).toBe('herdr-pl')
  expect(defaultPrefix('/x/abcdefg-xyz')).toBe('abcdefg')
  expect(defaultPrefix('/x/api')).toBe('api')
  expect(defaultPrefix('/')).toBe('repo')
})

test('a prefix is lowercased and trimmed, and anything but letters, digits and dashes is refused', () => {
  expect(normalisePrefix('HP-')).toBe('hp')
  expect(normalisePrefix(' web2 ')).toBe('web2')
  expect(normalisePrefix('bad prefix')).toBeNull()
  expect(normalisePrefix('-x')).toBeNull()
  expect(normalisePrefix('')).toBeNull()
})

test('store paths live under $STATE/beads/<slug>, and every spawn gets BEADS_DIR and the git ceiling', () => {
  expect(beadsHome(dir, 'r-abc123')).toBe(join(dir, 'beads', 'r-abc123'))
  expect(beadsDir(dir, 'r-abc123')).toBe(join(dir, 'beads', 'r-abc123', '.beads'))
  expect(beadsExportPath(dir, 'r-abc123')).toBe(join(dir, 'beads', 'r-abc123', '.beads', 'issues.jsonl'))
  const env = beadsSpawnEnv(dir, 'r-abc123')
  expect(env.BEADS_DIR).toBe(join(dir, 'beads', 'r-abc123', '.beads'))
  expect(env.GIT_CEILING_DIRECTORIES).toBe(join(dir, 'beads'))
  expect(env.PATH).toBe(process.env.PATH)
})

test('project.json round-trips, and a prefix is found in another project but never in its own', async () => {
  expect(await readBeadsProject(dir, 'a-111111')).toBeNull()
  await writeBeadsProject(dir, 'a-111111', { repo_root: '/r/a', prefix: 'hp', created_at: 5 })
  expect(await readBeadsProject(dir, 'a-111111')).toEqual({ repo_root: '/r/a', prefix: 'hp', created_at: 5 })

  expect(await prefixOwner(dir, 'hp', 'b-222222')).toEqual({ repo_root: '/r/a', prefix: 'hp', created_at: 5 })
  expect(await prefixOwner(dir, 'hp', 'a-111111')).toBeNull()
  expect(await prefixOwner(dir, 'web', 'b-222222')).toBeNull()
})

test('prefixOwner with no beads directory at all finds nothing', async () => {
  expect(await prefixOwner(join(dir, 'missing'), 'hp', 'a-111111')).toBeNull()
})

test('the durability scan finds <prefix>-<n> names under docs/superpowers and nothing else', () => {
  const repo = join(dir, 'repo')
  for (const sub of ['specs', 'reviews', 'plans']) mkdirSync(join(repo, 'docs', 'superpowers', sub), { recursive: true })
  writeFileSync(join(repo, 'docs/superpowers/specs/2026-10-02-hp-3-design.md'), '')
  writeFileSync(join(repo, 'docs/superpowers/reviews/hp-12-spec-review-0.md'), '')
  writeFileSync(join(repo, 'docs/superpowers/plans/2026-09-17-issue-3-plan.md'), '')
  writeFileSync(join(repo, 'docs/superpowers/plans/chp-3-plan.md'), '')

  expect(prefixCollisions(repo, 'hp')).toEqual([
    'docs/superpowers/reviews/hp-12-spec-review-0.md',
    'docs/superpowers/specs/2026-10-02-hp-3-design.md',
  ])
  expect(prefixCollisions(repo, 'web')).toEqual([])
  expect(prefixCollisions(join(dir, 'no-docs'), 'hp')).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/beads-project.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/beads-project'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/beads-project.ts`:

```ts
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readJson, writeJson } from './store'

export interface BeadsProject {
  repo_root: string
  prefix: string
  created_at: number
}

const PREFIX_MAX_CHARS = 8
const SLUG_HASH_CHARS = 6

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function repoName(repoKey: string): string {
  return sanitise(basename(repoKey)) || 'repo'
}

export function beadsSlug(repoKey: string): string {
  const hash = createHash('sha256').update(repoKey).digest('hex').slice(0, SLUG_HASH_CHARS)
  return `${repoName(repoKey)}-${hash}`
}

/** bd trims a trailing `-` from the prefix it stores, so the one recorded here is trimmed the same way. */
export function defaultPrefix(repoKey: string): string {
  return repoName(repoKey).slice(0, PREFIX_MAX_CHARS).replace(/-+$/, '')
}

export function normalisePrefix(raw: string): string | null {
  const prefix = raw.trim().toLowerCase().replace(/-+$/, '')
  return /^[a-z0-9][a-z0-9-]*$/.test(prefix) ? prefix : null
}

export const beadsRoot = (stateDir: string): string => join(stateDir, 'beads')
export const beadsHome = (stateDir: string, slug: string): string => join(beadsRoot(stateDir), slug)
export const beadsDir = (stateDir: string, slug: string): string => join(beadsHome(stateDir, slug), '.beads')
export const beadsExportPath = (stateDir: string, slug: string): string =>
  join(beadsDir(stateDir, slug), 'issues.jsonl')
const projectPath = (stateDir: string, slug: string): string => join(beadsHome(stateDir, slug), 'project.json')

/**
 * The ceiling stops every bd and bv spawn from finding a git work tree that
 * encloses the state dir — a dotfiles repo at $HOME, say — and committing into it.
 */
export function beadsSpawnEnv(stateDir: string, slug: string): Record<string, string | undefined> {
  return { ...process.env, BEADS_DIR: beadsDir(stateDir, slug), GIT_CEILING_DIRECTORIES: beadsRoot(stateDir) }
}

export async function readBeadsProject(stateDir: string, slug: string): Promise<BeadsProject | null> {
  return readJson<BeadsProject>(projectPath(stateDir, slug))
}

export async function writeBeadsProject(stateDir: string, slug: string, project: BeadsProject): Promise<void> {
  await writeJson(projectPath(stateDir, slug), project)
}

export async function prefixOwner(stateDir: string, prefix: string, exceptSlug: string): Promise<BeadsProject | null> {
  let slugs: string[]
  try {
    slugs = readdirSync(beadsRoot(stateDir))
  } catch {
    return null
  }
  for (const slug of slugs.filter((s) => s !== exceptSlug).sort()) {
    const project = await readBeadsProject(stateDir, slug)
    if (project?.prefix === prefix) return project
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The state dir is the only copy of the backlog. A store set up again after it
 * was lost restarts its counter at `<prefix>-1`, and new artifact stems would
 * collide with ones already committed under these names.
 */
export function prefixCollisions(repoRoot: string, prefix: string): string[] {
  const root = join(repoRoot, 'docs', 'superpowers')
  if (!existsSync(root)) return []
  const named = new RegExp(`(^|[^a-z0-9])${escapeRegExp(prefix)}-\\d+($|[^0-9])`)
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => named.test(basename(path)))
    .map((path) => join('docs', 'superpowers', path))
    .sort()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/beads-project.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and the whole suite**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/beads-project.ts test/beads-project.test.ts
git commit -m "feat: per-project Beads store layout, prefix and durability scan

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 2: `Bd` — the one way hpipe runs `bd`, plus tool version checks

Two commits: the spawn primitive and version checks first, then `Bd`.

**Files:**
- Create: `src/lib/spawn.ts`, `src/lib/tools.ts`, `src/lib/bd.ts`
- Test: `test/spawn.test.ts`, `test/tools.test.ts`, `test/bd.test.ts`

- [ ] **Step 1: Write the failing tests for the spawn primitive and the version checks**

Create `test/spawn.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { runBounded } from '../src/lib/spawn'

test('a finished command returns its code and both streams', async () => {
  const out = await runBounded(['sh', '-c', 'echo out; echo err >&2; exit 3'], { timeoutMs: 5_000 })
  expect(out).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
})

test('a missing binary degrades to code -1 instead of throwing', async () => {
  const out = await runBounded(['/nonexistent/bd-binary'], { timeoutMs: 5_000 })
  expect(out.code).toBe(-1)
  expect(out.timedOut).toBe(false)
})

test('a command that outlives the timeout is killed and says so', async () => {
  const started = Date.now()
  const out = await runBounded(['sleep', '10'], { timeoutMs: 200 })
  expect(out.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(5_000)
})
```

Create `test/tools.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import {
  atLeast, bdProblem, BD_MIN_VERSION, BV_MIN_VERSION, bvProblem, checkTool, parseVersion, toolsLine,
} from '../src/lib/tools'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tools-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('the version is the first x.y.z in the output, whatever surrounds it', () => {
  expect(parseVersion('bd version 1.3.1 (Homebrew)\n')).toBe('1.3.1')
  expect(parseVersion('bv v0.25.2\n')).toBe('0.25.2')
  expect(parseVersion('no version here')).toBeNull()
})

test('versions compare numerically, part by part', () => {
  expect(atLeast('1.3.1', '1.3.1')).toBe(true)
  expect(atLeast('1.10.0', '1.3.1')).toBe(true)
  expect(atLeast('1.0.4', '1.3.1')).toBe(false)
  expect(atLeast('0.25.1', '0.25.2')).toBe(false)
})

test('checkTool reads a good, an old and a missing binary', async () => {
  const good = await makeFakeBin(join(dir), { version: 'bd version 1.3.1 (Homebrew)\n' })
  expect(await checkTool([good, 'version'], BD_MIN_VERSION)).toEqual({ state: 'ok', version: '1.3.1' })

  const oldDir = mkdtempSync(join(dir, 'old-'))
  const old = await makeFakeBin(oldDir, { version: 'bd version 1.0.4 (Homebrew)\n' })
  expect(await checkTool([old, 'version'], BD_MIN_VERSION)).toEqual({ state: 'old', version: '1.0.4' })

  const missing = await checkTool([join(dir, 'no-such-bv'), '--version'], BV_MIN_VERSION)
  expect(missing.state).toBe('missing')
})

test('the problems name the fix, and the tools line is absent when both are fine', () => {
  const ok = { state: 'ok', version: '9.9.9' } as const
  expect(bdProblem(ok)).toBeNull()
  expect(bdProblem({ state: 'old', version: '1.0.4' })).toContain('brew upgrade beads')
  expect(bdProblem({ state: 'missing', detail: 'ENOENT' })).toContain('brew install beads')
  expect(bvProblem({ state: 'missing', detail: 'ENOENT' })).toContain('brew install dicklesworthstone/tap/bv')
  expect(toolsLine({ bd: ok, bv: ok })).toBeNull()
  expect(toolsLine({ bd: ok, bv: { state: 'old', version: '0.20.0' } }))
    .toBe(`tools: bv 0.20.0 is older than ${BV_MIN_VERSION} — brew upgrade bv`)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/spawn.test.ts test/tools.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/spawn'` and `'../src/lib/tools'`.

- [ ] **Step 3: Write the spawn primitive and the version checks**

Create `src/lib/spawn.ts`:

```ts
export interface Bounded {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface BoundedOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs: number
}

function spawnPiped(argv: string[], options: BoundedOptions) {
  return Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
}

/**
 * Bun.spawn throws synchronously on a missing binary or cwd. Callers rely on
 * this never throwing, so that degrades to code -1, as `Gh.run` does.
 */
export async function runBounded(argv: string[], options: BoundedOptions): Promise<Bounded> {
  let proc: ReturnType<typeof spawnPiped>
  try {
    proc = spawnPiped(argv, options)
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error), timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, options.timeoutMs)
  try {
    // Drained together: reading one pipe to the end first can deadlock on a full other one.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    return { code: await proc.exited, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}
```

Create `src/lib/tools.ts`:

```ts
import { runBounded } from './spawn'

export const BD_MIN_VERSION = '1.3.1'
export const BV_MIN_VERSION = '0.25.2'
export const BD_INSTALL_HINT = 'brew install beads'
export const BV_INSTALL_HINT = 'brew install dicklesworthstone/tap/bv'
const VERSION_CHECK_TIMEOUT_MS = 10_000

/** Not config keys: the CLI loads no config, and two processes reading different bins would let two bd versions write one store. */
export const bdBin = (): string => process.env.BD_BIN ?? 'bd'
export const bvBin = (): string => process.env.BV_BIN ?? 'bv'

export type ToolCheck =
  | { state: 'ok'; version: string }
  | { state: 'old'; version: string }
  | { state: 'missing'; detail: string }

export interface Tools {
  bd: ToolCheck
  bv: ToolCheck
}

export function parseVersion(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null
}

export function atLeast(version: string, minimum: string): boolean {
  const have = version.split('.').map(Number)
  const need = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (have[i] ?? 0) - (need[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export async function checkTool(argv: string[], minimum: string): Promise<ToolCheck> {
  const out = await runBounded(argv, { timeoutMs: VERSION_CHECK_TIMEOUT_MS })
  const version = out.code === 0 ? parseVersion(out.stdout) : null
  if (version === null) {
    const detail = (out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`).split('\n')[0] ?? ''
    return { state: 'missing', detail }
  }
  return atLeast(version, minimum) ? { state: 'ok', version } : { state: 'old', version }
}

export const checkBd = (): Promise<ToolCheck> => checkTool([bdBin(), 'version'], BD_MIN_VERSION)
export const checkBv = (): Promise<ToolCheck> => checkTool([bvBin(), '--version'], BV_MIN_VERSION)

export async function checkTools(): Promise<Tools> {
  const [bd, bv] = await Promise.all([checkBd(), checkBv()])
  return { bd, bv }
}

export function bdProblem(check: ToolCheck): string | null {
  switch (check.state) {
    case 'ok': return null
    case 'old': return `bd ${check.version} is older than ${BD_MIN_VERSION}, whose close guards this pipeline relies on — brew upgrade beads`
    case 'missing': return `bd did not run (${check.detail}) — ${BD_INSTALL_HINT}`
  }
}

export function bvProblem(check: ToolCheck): string | null {
  switch (check.state) {
    case 'ok': return null
    case 'old': return `bv ${check.version} is older than ${BV_MIN_VERSION} — brew upgrade bv`
    case 'missing': return `bv did not run (${check.detail}) — ${BV_INSTALL_HINT}`
  }
}

export function toolsLine(tools: Tools): string | null {
  const problems = [bdProblem(tools.bd), bvProblem(tools.bv)].filter((p): p is string => p !== null)
  return problems.length === 0 ? null : `tools: ${problems.join('; ')}`
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test test/spawn.test.ts test/tools.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/spawn.ts src/lib/tools.ts test/spawn.test.ts test/tools.test.ts
git commit -m "feat: bounded spawns and bd/bv version checks

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

- [ ] **Step 6: Write the failing `Bd` tests**

Create `test/bd.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bd, isBdFailure } from '../src/lib/bd'
import { beadsExportPath, beadsHome } from '../src/lib/beads-project'
import { processStartedAtMs } from '../src/lib/pidfile'

const SLUG = 'repo-abc123'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const home = (): string => beadsHome(dir, SLUG)
const logLines = (prefix: string): string[] =>
  readFileSync(join(dir, 'bd.log'), 'utf8').split('\n').filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length))
const withTmp = (line: string): string => line.replace(/\S*\.hpipe-[0-9a-f-]+\.md/g, '<tmp>')

function scriptBd(body: string): string {
  const path = join(dir, `bd-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * Records each call's argv, cwd and env, and the text of any file it is handed:
 * Bd deletes its temp files as soon as the call returns, so the text can only be
 * caught inside the call. Warns on stderr the way bd does outside git.
 */
function recordingBd(responses: Record<string, unknown> = {}): string {
  return scriptBd(`
import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const out = (line) => appendFileSync(${JSON.stringify(join(dir, 'bd.log'))}, line + '\\n')
out('argv: ' + argv.join(' '))
out('env: cwd=' + process.cwd() + ' BEADS_DIR=' + process.env.BEADS_DIR + ' CEILING=' + process.env.GIT_CEILING_DIRECTORIES)
for (const flag of ['--body-file', '--file', '--reason-file']) {
  const i = argv.indexOf(flag)
  if (i !== -1) out('file: ' + readFileSync(argv[i + 1], 'utf8').trim())
}
process.stderr.write('warning: beads.role is not set\\n')
process.stdout.write(JSON.stringify(${JSON.stringify(responses)}[argv[3]] ?? {}))
`)
}

async function liveHolder(): Promise<string> {
  return JSON.stringify({ pid: process.pid, started_at_ms: await processStartedAtMs(process.pid), token: 'someone' })
}

test('every call runs bd --json --actor hpipe in the store dir, with BEADS_DIR and the git ceiling', async () => {
  const bd = new Bd({
    stateDir: dir, slug: SLUG, lockWaitMs: 0,
    bin: recordingBd({ show: [{ id: 'hp-1', title: 'One', status: 'open' }] }),
  })
  expect(await bd.show('hp-1')).toEqual({ id: 'hp-1', title: 'One', status: 'open' })
  expect(logLines('argv: ')).toEqual(['--json --actor hpipe show hp-1 --include-comments --include-dependents'])
  expect(logLines('env: ')).toEqual([
    `cwd=${realpathSync(home())} BEADS_DIR=${join(home(), '.beads')} CEILING=${join(dir, 'beads')}`,
  ])
})

test('each method sends the argv of spec §2, and the files it hands bd hold the text it was given', async () => {
  const bd = new Bd({
    stateDir: dir, slug: SLUG, lockWaitMs: 0, exportAfterWrites: false,
    bin: recordingBd({ create: { id: 'hp-7', title: 'Fix the tile' } }),
  })
  expect(await bd.create({
    title: 'Fix the tile', body: 'Body text.\n', acceptance: 'It reads Bar.',
    labels: ['pipeline:tier-light', 'ui'], depsDiscoveredFrom: 'hp-1',
  })).toEqual({ id: 'hp-7' })
  expect(await bd.claim('hp-7')).toEqual({ ok: true })
  expect(await bd.update('hp-7', {
    status: 'open', assignee: '', addLabels: ['phase:plan'], removeLabels: ['phase:spec'],
  })).toEqual({ ok: true })
  expect(await bd.reopen('hp-7')).toEqual({ ok: true })
  expect(await bd.comment('hp-7', 'A ruling.\n')).toEqual({ ok: true })
  expect(await bd.depAdd('hp-7', 'hp-1')).toEqual({ ok: true })
  expect(await bd.close('hp-7', 'merged in PR #4 (abc1234)', { force: true })).toEqual({ ok: true })

  expect(logLines('argv: ').map(withTmp)).toEqual([
    '--json --actor hpipe create --title Fix the tile --body-file <tmp> --acceptance It reads Bar. ' +
      '-l pipeline:tier-light -l ui --deps discovered-from:hp-1',
    '--json --actor hpipe update hp-7 --claim',
    '--json --actor hpipe update hp-7 -s open --assignee  --add-label phase:plan --remove-label phase:spec',
    '--json --actor hpipe reopen hp-7',
    '--json --actor hpipe comment hp-7 --file <tmp>',
    '--json --actor hpipe dep add hp-7 hp-1 --type blocks',
    '--json --actor hpipe close hp-7 --reason-file <tmp> --force',
  ])
  expect(logLines('file: ')).toEqual(['Body text.', 'A ruling.', 'merged in PR #4 (abc1234)'])
  expect(readdirSync(home()).filter((name) => name.startsWith('.hpipe-'))).toEqual([])
})

test('an update with nothing to change spawns nothing', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.update('hp-1', {})).toEqual({ ok: true })
  expect(existsSync(join(dir, 'bd.log'))).toBe(false)
})

test('a refusal carries bd\'s JSON error from stdout, ignoring the stderr warning', async () => {
  const refusing = scriptBd(`
process.stdout.write(JSON.stringify({ error: 'cannot close hp-1: assignee is "bob", actor is "hpipe"' }))
process.stderr.write('warning: beads.role is not set\\n')
process.exit(1)
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: refusing })
  expect(await bd.close('hp-1', 'merged', { force: false }))
    .toEqual({ reason: 'exit', error: 'cannot close hp-1: assignee is "bob", actor is "hpipe"' })
})

test('with no JSON error the failure is stderr without the beads.role warning', async () => {
  const locked = scriptBd(`
process.stderr.write('warning: beads.role is not set\\nError: database is locked\\n')
process.exit(1)
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: locked })
  expect(await bd.claim('hp-1')).toEqual({ reason: 'exit', error: 'Error: database is locked' })
})

test('a close as hpipe passes a bd that refuses every other actor', async () => {
  const guarded = scriptBd(`
const argv = process.argv.slice(2)
const actor = argv[argv.indexOf('--actor') + 1]
if (argv.includes('close') && actor !== 'hpipe') {
  process.stdout.write(JSON.stringify({ error: 'cannot close hp-1: assignee is "hpipe", actor is "' + actor + '"' }))
  process.exit(1)
}
process.stdout.write('{}')
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: guarded })
  expect(await bd.close('hp-1', 'merged in PR #1 (abc)', { force: false })).toEqual({ ok: true })
})

test('a write exports inside its hold; a failed export leaves export.dirty, which the next hold clears first', async () => {
  const flaky = scriptBd(`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'bd.log'))}, 'call: ' + argv.slice(3).join(' ') + '\\n')
const failedOnce = ${JSON.stringify(join(dir, 'export-failed-once'))}
if (argv[3] === 'export' && !existsSync(failedOnce)) {
  writeFileSync(failedOnce, '')
  process.stderr.write('disk full\\n')
  process.exit(1)
}
process.stdout.write('{}')
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: flaky })
  const exportLine = `export -o ${beadsExportPath(dir, SLUG)}`

  expect(await bd.claim('hp-1')).toEqual({ ok: true })
  expect(existsSync(join(home(), 'export.dirty'))).toBe(true)

  expect(await bd.reopen('hp-1')).toEqual({ ok: true })
  expect(logLines('call: ')).toEqual(['update hp-1 --claim', exportLine, exportLine, 'reopen hp-1', exportLine])
  expect(existsSync(join(home(), 'export.dirty'))).toBe(false)
})

test('without export after writes, a write marks the export dirty and exportNow clears it', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, exportAfterWrites: false, bin: recordingBd() })
  expect(await bd.claim('hp-1')).toEqual({ ok: true })
  expect(await bd.reopen('hp-1')).toEqual({ ok: true })
  expect(existsSync(join(home(), 'export.dirty'))).toBe(true)

  expect(await bd.exportNow()).toEqual({ ok: true })
  expect(logLines('argv: ')).toEqual([
    '--json --actor hpipe update hp-1 --claim',
    '--json --actor hpipe reopen hp-1',
    `--json --actor hpipe export -o ${beadsExportPath(dir, SLUG)}`,
  ])
  expect(existsSync(join(home(), 'export.dirty'))).toBe(false)
})

test('refreshExport re-exports only when the export is dirty', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.refreshExport()).toEqual({ ok: true })
  expect(existsSync(join(dir, 'bd.log'))).toBe(false)

  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), 'export.dirty'), '1\n')
  expect(await bd.refreshExport()).toEqual({ ok: true })
  expect(logLines('argv: ')).toEqual([`--json --actor hpipe export -o ${beadsExportPath(dir, SLUG)}`])
})

test('initStore runs bd init, the counter config and a first export, in that order', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.initStore('hp')).toEqual({ ok: true })
  expect(logLines('argv: ')).toEqual([
    '--json --actor hpipe init --prefix hp --skip-agents --skip-hooks --non-interactive',
    '--json --actor hpipe config set issue_id_mode counter',
    `--json --actor hpipe export -o ${beadsExportPath(dir, SLUG)}`,
  ])
})

test('the supervisor\'s try-lock gives up at once on a live holder; the CLI waits, then gives up', async () => {
  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), 'hpipe.lock'), await liveHolder())
  const bin = recordingBd()

  expect(await new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin }).claim('hp-1'))
    .toEqual({ reason: 'busy', error: 'Beads is busy, retry' })

  const started = Date.now()
  expect(await new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 300, bin }).claim('hp-1'))
    .toEqual({ reason: 'busy', error: 'Beads is busy, retry' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  expect(existsSync(join(dir, 'bd.log'))).toBe(false)
})

test('a CLI waiting on the lock gets it once the holder lets go, and releases it after', async () => {
  mkdirSync(home(), { recursive: true })
  const lock = join(home(), 'hpipe.lock')
  writeFileSync(lock, await liveHolder())
  setTimeout(() => rmSync(lock), 150)

  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 2_000, bin: recordingBd() })
  expect(await bd.claim('hp-1')).toEqual({ ok: true })
  expect(existsSync(lock)).toBe(false)
})

test('a lock whose holder is dead is reclaimed, by a try-lock too', async () => {
  const exited = Bun.spawn(['true'])
  await exited.exited
  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), 'hpipe.lock'), JSON.stringify({ pid: exited.pid, started_at_ms: 1, token: 'dead' }))

  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.claim('hp-1')).toEqual({ ok: true })
})

test('a bd that hangs is killed at the timeout and reported as one', async () => {
  const hanging = scriptBd('await Bun.sleep(10_000)')
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, timeoutMs: 200, bin: hanging })
  const started = Date.now()
  const result = await bd.show('hp-1')
  expect(isBdFailure(result) ? result.reason : 'no failure').toBe('timeout')
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a show that prints no bead is an output failure, not a crash', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd({ show: [] }) })
  expect(await bd.show('hp-404')).toEqual({ reason: 'output', error: 'bd show hp-404 printed no bead' })
})

test('readExport parses the issue lines of the export and skips the rest', () => {
  mkdirSync(join(home(), '.beads'), { recursive: true })
  writeFileSync(beadsExportPath(dir, SLUG), [
    JSON.stringify({
      _type: 'issue', id: 'hp-1', title: 'One', status: 'in_progress', assignee: 'hpipe',
      labels: ['phase:plan'], dependencies: [{ issue_id: 'hp-1', depends_on_id: 'hp-0', type: 'blocks' }],
      comments: [{ id: 'c1', text: 'hi [hpipe t1/d1/asked]' }],
    }),
    JSON.stringify({ _type: 'memory', key: 'k', value: 'v' }),
    'not json',
    '',
  ].join('\n'))

  const beads = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0 }).readExport()
  expect(beads.map((b) => b.id)).toEqual(['hp-1'])
  expect(beads[0]).toMatchObject({ status: 'in_progress', assignee: 'hpipe', labels: ['phase:plan'] })
  expect(beads[0]?.dependencies?.[0]).toMatchObject({ depends_on_id: 'hp-0', type: 'blocks' })
  expect(beads[0]?.comments?.[0]?.text).toContain('[hpipe t1/d1/asked]')
  expect(new Bd({ stateDir: join(dir, 'none'), slug: SLUG, lockWaitMs: 0 }).readExport()).toEqual([])
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test test/bd.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/bd'`.

- [ ] **Step 8: Write `Bd`**

Create `src/lib/bd.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beadsExportPath, beadsHome, beadsSpawnEnv } from './beads-project'
import { processStartedAtMs } from './pidfile'
import { type Bounded, runBounded } from './spawn'
import { readJson, removeJsonIf, writeJsonExclusive } from './store'
import { bdBin } from './tools'

/** bd 1.3.1 refuses a close by anyone but the assignee, so the claim and the close must share one actor. */
export const BD_ACTOR = 'hpipe'
export const CLI_LOCK_WAIT_MS = 10_000
export const BD_TIMEOUT_MS = 30_000
const LOCK_POLL_MS = 50
// `ps` reports whole seconds, as for the supervisor's pid file.
const START_TIME_SLOP_MS = 1_000

export type BdFailureReason = 'exit' | 'timeout' | 'busy' | 'output' | 'unavailable'

export interface BdFailure {
  reason: BdFailureReason
  error: string
}

export interface Done {
  ok: true
}

export interface CreatedBead {
  id: string
}

export interface BeadComment {
  text: string
  author?: string
}

export interface BeadEdge {
  depends_on_id: string
  type: string
}

/** One line of `bd export`: a bead with its labels, dependencies and comments. */
export interface ExportedBead {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  status: string
  assignee?: string
  labels?: string[]
  dependencies?: BeadEdge[]
  comments?: BeadComment[]
}

export interface LinkedBead {
  id: string
  title: string
  status: string
  dependency_type: string
}

/** One entry of `bd show --json --include-comments --include-dependents`. */
export interface BeadDetail {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  status: string
  assignee?: string
  labels?: string[]
  dependencies?: LinkedBead[]
  dependents?: LinkedBead[]
  comments?: BeadComment[]
}

export interface BeadCreateInput {
  title: string
  body: string
  acceptance?: string
  labels: string[]
  depsDiscoveredFrom?: string
}

export interface BeadUpdate {
  status?: string
  assignee?: string
  addLabels?: string[]
  removeLabels?: string[]
}

export interface BdOptions {
  stateDir: string
  slug: string
  /** 0 is a try-lock: the supervisor's. The CLI waits `CLI_LOCK_WAIT_MS`. */
  lockWaitMs: number
  /** False for the reconciler, which exports once at the end of its pass. */
  exportAfterWrites?: boolean
  timeoutMs?: number
  bin?: string
}

interface LockHolder {
  pid: number
  started_at_ms: number
  token: string
}

const DONE: Done = { ok: true }

export function isBdFailure(value: unknown): value is BdFailure {
  return typeof value === 'object' && value !== null && 'reason' in value && 'error' in value
}

let ownStartTime: Promise<number> | null = null
const ownStartedAtMs = (): Promise<number> =>
  (ownStartTime ??= processStartedAtMs(process.pid).then((at) => at ?? Date.now()))

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function jsonError(stdout: string): string | null {
  const parsed = parseJson<{ error?: unknown; data?: { error?: unknown } }>(stdout)
  if (typeof parsed?.error === 'string') return parsed.error
  if (typeof parsed?.data?.error === 'string') return parsed.data.error
  return null
}

/** Outside a git repo bd warns about `beads.role` on stderr even when it succeeds. */
function failureText(out: Bounded): string {
  const stderr = out.stderr.split('\n')
    .filter((line) => line.trim() !== '' && !line.includes('beads.role'))
    .join('\n').trim()
  return jsonError(out.stdout) ?? (stderr || out.stdout.trim() || `bd exited ${out.code}`)
}

const isHolder = (token: string) => (current: unknown): boolean =>
  (current as Partial<LockHolder> | null)?.token === token

/**
 * The only code that spawns `bd`. Each call takes `hpipe.lock` for itself (and its
 * export) and never for a batch, so a waiter waits at most one call. The lock
 * exists so hpipe processes queue instead of tripping bd's own fail-fast Dolt
 * lock; bd's kernel lock still stops a second writer while an orphaned child lives.
 */
export class Bd {
  readonly #options: BdOptions
  readonly #home: string
  readonly #exportPath: string
  readonly #lockPath: string
  readonly #dirtyPath: string
  readonly #exportAfterWrites: boolean

  constructor(options: BdOptions) {
    this.#options = options
    this.#home = beadsHome(options.stateDir, options.slug)
    this.#exportPath = beadsExportPath(options.stateDir, options.slug)
    this.#lockPath = join(this.#home, 'hpipe.lock')
    this.#dirtyPath = join(this.#home, 'export.dirty')
    this.#exportAfterWrites = options.exportAfterWrites ?? true
  }

  async initStore(prefix: string): Promise<Done | BdFailure> {
    return this.#hold(async () => {
      for (const args of [
        ['init', '--prefix', prefix, '--skip-agents', '--skip-hooks', '--non-interactive'],
        ['config', 'set', 'issue_id_mode', 'counter'],
      ]) {
        const out = await this.#call(args)
        if (isBdFailure(out)) return out
      }
      return this.#export()
    })
  }

  async create(input: BeadCreateInput): Promise<CreatedBead | BdFailure> {
    return this.#withTempFile(input.body, (bodyFile) => this.#write([
      'create', '--title', input.title, '--body-file', bodyFile,
      ...(input.acceptance === undefined ? [] : ['--acceptance', input.acceptance]),
      ...input.labels.flatMap((label) => ['-l', label]),
      ...(input.depsDiscoveredFrom === undefined ? [] : ['--deps', `discovered-from:${input.depsDiscoveredFrom}`]),
    ], (stdout) => {
      const created = parseJson<{ id?: unknown }>(stdout)
      return typeof created?.id === 'string' ? { id: created.id } : null
    }))
  }

  async show(id: string): Promise<BeadDetail | BdFailure> {
    return this.#hold(async () => {
      const out = await this.#call(['show', id, '--include-comments', '--include-dependents'])
      if (isBdFailure(out)) return out
      const shown = parseJson<BeadDetail[]>(out)
      const bead = Array.isArray(shown) ? shown[0] : undefined
      return bead === undefined ? { reason: 'output', error: `bd show ${id} printed no bead` } : bead
    })
  }

  async claim(id: string): Promise<Done | BdFailure> {
    return this.#write(['update', id, '--claim'], () => DONE)
  }

  async update(id: string, change: BeadUpdate): Promise<Done | BdFailure> {
    const args = [
      ...(change.status === undefined ? [] : ['-s', change.status]),
      ...(change.assignee === undefined ? [] : ['--assignee', change.assignee]),
      ...(change.addLabels ?? []).flatMap((label) => ['--add-label', label]),
      ...(change.removeLabels ?? []).flatMap((label) => ['--remove-label', label]),
    ]
    if (args.length === 0) return DONE
    return this.#write(['update', id, ...args], () => DONE)
  }

  async reopen(id: string): Promise<Done | BdFailure> {
    return this.#write(['reopen', id], () => DONE)
  }

  async comment(id: string, text: string): Promise<Done | BdFailure> {
    return this.#withTempFile(text, (file) => this.#write(['comment', id, '--file', file], () => DONE))
  }

  async depAdd(from: string, to: string): Promise<Done | BdFailure> {
    return this.#write(['dep', 'add', from, to, '--type', 'blocks'], () => DONE)
  }

  async close(id: string, reason: string, options: { force: boolean }): Promise<Done | BdFailure> {
    return this.#withTempFile(reason, (reasonFile) => this.#write(
      ['close', id, '--reason-file', reasonFile, ...(options.force ? ['--force'] : [])], () => DONE,
    ))
  }

  async exportNow(): Promise<Done | BdFailure> {
    return this.#hold(() => this.#export())
  }

  async refreshExport(): Promise<Done | BdFailure> {
    return this.#hold(async () => (existsSync(this.#dirtyPath) ? this.#export() : DONE))
  }

  /** No spawn and no lock: the export is written atomically by bd. */
  readExport(): ExportedBead[] {
    let text: string
    try {
      text = readFileSync(this.#exportPath, 'utf8')
    } catch {
      return []
    }
    const beads: ExportedBead[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const record = parseJson<ExportedBead & { _type?: string }>(line)
      if (record === null || typeof record.id !== 'string') continue
      if (record._type !== undefined && record._type !== 'issue') continue
      beads.push(record)
    }
    return beads
  }

  async #hold<T>(work: () => Promise<T | BdFailure>): Promise<T | BdFailure> {
    const token = await this.#acquire()
    if (token === null) return { reason: 'busy', error: 'Beads is busy, retry' }
    try {
      if (this.#exportAfterWrites && existsSync(this.#dirtyPath)) await this.#export()
      return await work()
    } finally {
      removeJsonIf(this.#lockPath, isHolder(token))
    }
  }

  async #write<T>(args: string[], parse: (stdout: string) => T | null): Promise<T | BdFailure> {
    return this.#hold(async () => {
      const out = await this.#call(args)
      if (isBdFailure(out)) return out
      if (this.#exportAfterWrites) await this.#export()
      else this.#markDirty()
      return parse(out) ?? { reason: 'output', error: `bd ${args[0]} printed no usable JSON: ${out.trim().slice(0, 200)}` }
    })
  }

  async #call(args: string[]): Promise<string | BdFailure> {
    const timeoutMs = this.#options.timeoutMs ?? BD_TIMEOUT_MS
    const out = await runBounded([this.#options.bin ?? bdBin(), '--json', '--actor', BD_ACTOR, ...args], {
      cwd: this.#home, env: beadsSpawnEnv(this.#options.stateDir, this.#options.slug), timeoutMs,
    })
    if (out.timedOut) return { reason: 'timeout', error: `bd ${args[0]} was killed after ${timeoutMs / 1000}s` }
    if (out.code !== 0) return { reason: 'exit', error: failureText(out) }
    return out.stdout
  }

  async #export(): Promise<Done | BdFailure> {
    const out = await this.#call(['export', '-o', this.#exportPath])
    if (isBdFailure(out)) {
      this.#markDirty()
      return out
    }
    rmSync(this.#dirtyPath, { force: true })
    return DONE
  }

  #markDirty(): void {
    writeFileSync(this.#dirtyPath, `${Date.now()}\n`)
  }

  async #withTempFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T> {
    mkdirSync(this.#home, { recursive: true })
    const path = join(this.#home, `.hpipe-${randomUUID()}.md`)
    writeFileSync(path, text)
    try {
      return await use(path)
    } finally {
      rmSync(path, { force: true })
    }
  }

  async #acquire(): Promise<string | null> {
    mkdirSync(this.#home, { recursive: true })
    const deadline = Date.now() + this.#options.lockWaitMs
    for (;;) {
      const token = randomUUID()
      const holder: LockHolder = { pid: process.pid, started_at_ms: await ownStartedAtMs(), token }
      if (await writeJsonExclusive(this.#lockPath, holder)) return token
      if (await this.#reclaimFromDeadHolder()) continue
      if (Date.now() >= deadline) return null
      await Bun.sleep(LOCK_POLL_MS)
    }
  }

  /** True when the lock may be retried at once: its holder was dead, or it was let go meanwhile. */
  async #reclaimFromDeadHolder(): Promise<boolean> {
    const holder = await readJson<LockHolder>(this.#lockPath)
    if (holder === null) {
      removeJsonIf(this.#lockPath, (current) => current === null)
      return true
    }
    const startedAt = await processStartedAtMs(holder.pid)
    const alive = startedAt !== null && Math.abs(startedAt - holder.started_at_ms) <= START_TIME_SLOP_MS
    if (alive) return false
    removeJsonIf(this.#lockPath, isHolder(holder.token))
    return true
  }
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `bun test test/bd.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 10: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/bd.ts test/bd.test.ts
git commit -m "feat: Bd, the per-call-locked bd wrapper with export after writes

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 3: `src/lib/held.ts` — the held predicate across every session

**Files:**
- Modify: `src/lib/gating.ts:7`, `:14` (export `TERMINAL_OK` and `TERMINAL_BAD`)
- Create: `src/lib/held.ts`
- Test: `test/held.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/held.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadHolds, heldBy, holdsBead } from '../src/lib/held'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'held-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeRun(session: string, run: { run_id: string; phase: string; tasks: object[] }): void {
  mkdirSync(join(dir, 'runs', session), { recursive: true })
  writeFileSync(join(dir, 'runs', session, `${run.run_id}.json`), JSON.stringify({ schema_version: 3, ...run }))
}

test('a live task in a live run holds its bead; a finished task, a finished run or no bead does not', () => {
  const live = { phase: 'execute' }
  for (const phase of ['queued', 'research', 'implement', 'merge', 'close', 'escalated', 'blocked-on-decision']) {
    expect(holdsBead(live, { phase, bead: 'hp-1' }), phase).toBe(true)
  }
  for (const phase of ['done', 'failed', 'orphaned', 'blocked-on-failure']) {
    expect(holdsBead(live, { phase, bead: 'hp-1' }), phase).toBe(false)
  }
  expect(holdsBead({ phase: 'done' }, { phase: 'implement', bead: 'hp-1' })).toBe(false)
  expect(holdsBead(live, { phase: 'implement' })).toBe(false)
})

test('every session\'s runs are scanned, and only what is held is returned', async () => {
  writeRun('personal', {
    run_id: 'r1', phase: 'execute',
    tasks: [{ task_id: 't1', phase: 'implement', bead: 'hp-1' }, { task_id: 't2', phase: 'failed', bead: 'hp-2' }],
  })
  writeRun('work', { run_id: 'r2', phase: 'intake', tasks: [{ task_id: 't1', phase: 'queued', bead: 'hp-3' }] })
  writeRun('work', { run_id: 'r3', phase: 'done', tasks: [{ task_id: 't1', phase: 'implement', bead: 'hp-4' }] })
  writeRun('work', { run_id: 'r4', phase: 'execute', tasks: [{ task_id: 't1', phase: 'implement', issue: 7 }] })

  const holds = await beadHolds(dir)
  expect([...holds.keys()].sort()).toEqual(['hp-1', 'hp-3'])
  expect(await heldBy(dir, 'hp-3')).toEqual({ session: 'work', run_id: 'r2', task_id: 't1', phase: 'queued' })
  expect(await heldBy(dir, 'hp-2')).toBeNull()
})

test('no runs directory means nothing is held', async () => {
  expect((await beadHolds(join(dir, 'empty'))).size).toBe(0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/held.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/held'`.

- [ ] **Step 3: Export the terminal sets**

In `src/lib/gating.ts`, change line 7 from:

```ts
const TERMINAL_OK: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['done'])
```

to:

```ts
export const TERMINAL_OK: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['done'])
```

and line 14 from:

```ts
const TERMINAL_BAD: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
```

to:

```ts
export const TERMINAL_BAD: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
```

- [ ] **Step 4: Write `held.ts`**

Create `src/lib/held.ts`:

```ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_BAD, TERMINAL_OK } from './gating'
import { readJson } from './store'
import type { TaskPhase } from './types'

/**
 * The fields read off disk, typed structurally: run files of every schema
 * version sit side by side, and a v2 task carries no `bead` at all.
 */
interface RunFileTask {
  task_id: string
  phase: string
  bead?: string
}

interface RunFile {
  run_id: string
  phase: string
  tasks?: RunFileTask[]
}

export interface BeadHold {
  session: string
  run_id: string
  task_id: string
  phase: string
}

/** Adoption, `hpipe next` and the reconciler's release rule all read this one predicate. */
export function holdsBead<T extends { phase: string; bead?: string }>(
  run: { phase: string }, task: T,
): task is T & { bead: string } {
  if (task.bead === undefined || run.phase === 'done') return false
  const phase = task.phase as TaskPhase
  return !TERMINAL_OK.has(phase) && !TERMINAL_BAD.has(phase)
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Every session's runs, not only the caller's: a bead held from another herdr session is still taken. */
export async function beadHolds(stateDir: string): Promise<Map<string, BeadHold>> {
  const holds = new Map<string, BeadHold>()
  const runsRoot = join(stateDir, 'runs')
  for (const session of entries(runsRoot).sort()) {
    for (const name of entries(join(runsRoot, session)).filter((n) => n.endsWith('.json')).sort()) {
      const run = await readJson<RunFile>(join(runsRoot, session, name))
      if (run === null) continue
      for (const task of run.tasks ?? []) {
        if (!holdsBead(run, task)) continue
        holds.set(task.bead, { session, run_id: run.run_id, task_id: task.task_id, phase: task.phase })
      }
    }
  }
  return holds
}

export async function heldBy(stateDir: string, bead: string): Promise<BeadHold | null> {
  return (await beadHolds(stateDir)).get(bead) ?? null
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test test/held.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/gating.ts src/lib/held.ts test/held.test.ts
git commit -m "feat: the held-bead predicate across every session's runs

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 4: Setup — `hpipe start --prefix`, the setup flow, the action, the tools warnings

**Files:**
- Create: `src/lib/beads-setup.ts`, `src/actions/beads-setup.ts`, `test/beads-setup.test.ts`, `test/helpers/cmd-start.ts`
- Modify: `src/cli.ts:1-32` (imports), `:176-202` (`cmdStart`), `:925-942` (`cmdStatus`), `:1026-1027` (usage), `:1135-1143` (argv `start`)
- Modify: `src/lib/status.ts:365-379` (`formatStatus` gains `tools`)
- Modify: `src/actions/status.ts:20-28`, `src/startup.ts:1-8,160-165`
- Modify: `herdr-plugin.toml:75` (new action after `install-cli`)
- Modify: `test/helpers/fake-bin.ts` (synchronous variant)
- Test: `test/beads-setup.test.ts`, `test/cli.test.ts:6` and append, `test/status.test.ts` append, `test/cli-commands.test.ts:9,63`, `test/cli-argv.test.ts:1-58,174` and append

- [ ] **Step 1: Write the failing setup tests**

Create `test/beads-setup.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsHome, beadsSlug, readBeadsProject, writeBeadsProject } from '../src/lib/beads-project'
import { setupBeads, setupLines, type SetupDeps } from '../src/lib/beads-setup'

let dir: string
let repo: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'beads-setup-state-'))
  repo = mkdtempSync(join(tmpdir(), 'beads-setup-repo-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const KEY = '/code/herdr-plugin-pipeline'

function fakeDeps(over: Partial<SetupDeps> = {}): { deps: SetupDeps; inits: Array<[string, string]> } {
  const inits: Array<[string, string]> = []
  return {
    inits,
    deps: {
      initStore: async (_stateDir, slug, prefix) => { inits.push([slug, prefix]); return { ok: true } },
      enclosingWorkTree: async () => false,
      now: () => 42,
      ...over,
    },
  }
}

test('a first setup inits the store under the default prefix and records project.json', async () => {
  const { deps, inits } = fakeDeps()
  const slug = beadsSlug(KEY)
  expect(await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: null }, deps))
    .toEqual({ ok: true, slug, prefix: 'herdr-pl', created: true, notes: [] })
  expect(inits).toEqual([[slug, 'herdr-pl']])
  expect(await readBeadsProject(dir, slug)).toEqual({ repo_root: repo, prefix: 'herdr-pl', created_at: 42 })
})

test('--prefix overrides the default, normalised the way bd stores it', async () => {
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'HP-' }, deps)
  expect(result.ok && result.prefix).toBe('hp')
  expect(inits.map(([, prefix]) => prefix)).toEqual(['hp'])
})

test('an existing store is left alone, and a --prefix that disagrees with it is reported as ignored', async () => {
  const slug = beadsSlug(KEY)
  await writeBeadsProject(dir, slug, { repo_root: repo, prefix: 'hp', created_at: 1 })
  const { deps, inits } = fakeDeps()
  expect(await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'web' }, deps)).toEqual({
    ok: true, slug, prefix: 'hp', created: false,
    notes: ['this repo\'s Beads store already uses prefix hp; --prefix web was ignored'],
  })
  expect(inits).toEqual([])
})

test('a malformed prefix is refused before anything is created', async () => {
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'two words' }, deps)
  expect(result).toEqual({ ok: false, error: '--prefix must be lowercase letters, digits and dashes, got: two words' })
  expect(inits).toEqual([])
})

test('a prefix another repo\'s store uses is refused, naming --prefix', async () => {
  await writeBeadsProject(dir, 'other-123456', { repo_root: '/code/other', prefix: 'hp', created_at: 1 })
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toBe('prefix hp is already the Beads prefix of /code/other — pass --prefix <another>')
  expect(inits).toEqual([])
})

test('a prefix whose <prefix>-<n> names already sit under docs/superpowers is refused', async () => {
  mkdirSync(join(repo, 'docs', 'superpowers', 'specs'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'superpowers', 'specs', '2026-10-02-hp-1-design.md'), '')
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('docs/superpowers/specs/2026-10-02-hp-1-design.md')
  expect(!result.ok && result.error).toContain('pass --prefix <another>')
  expect(inits).toEqual([])
})

test('a state dir inside a git work tree is set up anyway, with a note saying why that is harmless', async () => {
  const { deps } = fakeDeps({ enclosingWorkTree: async () => true })
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok && result.notes).toEqual([
    `${beadsHome(dir, beadsSlug(KEY))} sits inside a git work tree; every bd and bv call runs with ` +
      'GIT_CEILING_DIRECTORIES set, so none commits into it',
  ])
})

test('a failed bd init records nothing and passes bd\'s error through', async () => {
  const { deps } = fakeDeps({ initStore: async () => ({ reason: 'exit', error: 'Error: database is locked' }) })
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('Error: database is locked')
  expect(existsSync(join(beadsHome(dir, beadsSlug(KEY)), 'project.json'))).toBe(false)
})

test('setupLines says whether the store was created, then each note', () => {
  expect(setupLines({ ok: true, slug: 's-123456', prefix: 'hp', created: true, notes: ['n'] }, '/st')).toEqual([
    'beads: created /st/beads/s-123456 with prefix hp', 'beads: n',
  ])
  expect(setupLines({ ok: true, slug: 's-123456', prefix: 'hp', created: false, notes: [] }, '/st')).toEqual([
    'beads: prefix hp, store /st/beads/s-123456',
  ])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/beads-setup.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/beads-setup'`.

- [ ] **Step 3: Write the setup flow**

Create `src/lib/beads-setup.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { Bd, CLI_LOCK_WAIT_MS, isBdFailure, type BdFailure, type Done } from './bd'
import {
  beadsHome, beadsSlug, defaultPrefix, normalisePrefix, prefixCollisions, prefixOwner,
  readBeadsProject, writeBeadsProject,
} from './beads-project'
import { runBounded } from './spawn'

export interface SetupInput {
  stateDir: string
  repoKey: string
  repoRoot: string
  prefix: string | null
}

export type SetupResult =
  | { ok: true; slug: string; prefix: string; created: boolean; notes: string[] }
  | { ok: false; error: string }

export interface SetupDeps {
  initStore: (stateDir: string, slug: string, prefix: string) => Promise<Done | BdFailure>
  enclosingWorkTree: (dir: string) => Promise<boolean>
  now: () => number
}

const GIT_CHECK_TIMEOUT_MS = 10_000
const COLLISIONS_NAMED = 3

/** Run WITHOUT the ceiling on purpose: it reports the work tree the ceiling exists to hide. */
async function insideGitWorkTree(dir: string): Promise<boolean> {
  const out = await runBounded(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: dir, timeoutMs: GIT_CHECK_TIMEOUT_MS })
  return out.code === 0 && out.stdout.trim() === 'true'
}

export const REAL_SETUP_DEPS: SetupDeps = {
  initStore: (stateDir, slug, prefix) => new Bd({ stateDir, slug, lockWaitMs: CLI_LOCK_WAIT_MS }).initStore(prefix),
  enclosingWorkTree: insideGitWorkTree,
  now: Date.now,
}

export async function setupBeads(input: SetupInput, deps: SetupDeps = REAL_SETUP_DEPS): Promise<SetupResult> {
  const slug = beadsSlug(input.repoKey)
  const existing = await readBeadsProject(input.stateDir, slug)
  if (existing !== null) {
    const ignored = input.prefix !== null && normalisePrefix(input.prefix) !== existing.prefix
      ? [`this repo's Beads store already uses prefix ${existing.prefix}; --prefix ${input.prefix} was ignored`]
      : []
    return { ok: true, slug, prefix: existing.prefix, created: false, notes: ignored }
  }

  const prefix = normalisePrefix(input.prefix ?? defaultPrefix(input.repoKey))
  if (prefix === null) {
    return { ok: false, error: `--prefix must be lowercase letters, digits and dashes, got: ${input.prefix}` }
  }
  const owner = await prefixOwner(input.stateDir, prefix, slug)
  if (owner !== null) {
    return { ok: false, error: `prefix ${prefix} is already the Beads prefix of ${owner.repo_root} — pass --prefix <another>` }
  }
  const collisions = prefixCollisions(input.repoRoot, prefix)
  if (collisions.length > 0) {
    const named = collisions.slice(0, COLLISIONS_NAMED).join(', ') + (collisions.length > COLLISIONS_NAMED ? ', …' : '')
    return {
      ok: false,
      error: `docs/superpowers already holds artifacts named ${prefix}-<n> (${named}); a new store's counter ` +
        'would reuse those names — pass --prefix <another>',
    }
  }

  const home = beadsHome(input.stateDir, slug)
  mkdirSync(home, { recursive: true })
  const notes = (await deps.enclosingWorkTree(home))
    ? [`${home} sits inside a git work tree; every bd and bv call runs with GIT_CEILING_DIRECTORIES set, so none commits into it`]
    : []
  const initialised = await deps.initStore(input.stateDir, slug, prefix)
  if (isBdFailure(initialised)) {
    return { ok: false, error: `bd init failed in ${home}; nothing was recorded:\n  ${initialised.error}` }
  }
  await writeBeadsProject(input.stateDir, slug, { repo_root: input.repoRoot, prefix, created_at: deps.now() })
  return { ok: true, slug, prefix, created: true, notes }
}

export function setupLines(result: Extract<SetupResult, { ok: true }>, stateDir: string): string[] {
  const home = beadsHome(stateDir, result.slug)
  return [
    result.created ? `beads: created ${home} with prefix ${result.prefix}` : `beads: prefix ${result.prefix}, store ${home}`,
    ...result.notes.map((note) => `beads: ${note}`),
  ]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/beads-setup.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing `hpipe start` and `status` tests**

Create `test/helpers/cmd-start.ts`:

```ts
import { cmdStart as cmdStartWithRealBeads, type StartBeads } from '../../src/cli'
import type { Tools } from '../../src/lib/tools'

type CmdStartArgs = Parameters<typeof cmdStartWithRealBeads>

export const READY_TOOLS: Tools = {
  bd: { state: 'ok', version: '1.3.1' },
  bv: { state: 'ok', version: '0.25.2' },
}

/** Tools present and the store already set up: what a start test assumes unless it says otherwise. */
export function startBeads(over: Partial<StartBeads> = {}): StartBeads {
  return {
    tools: async () => READY_TOOLS,
    setup: async () => ({ ok: true, slug: 'repo-abc123', prefix: 'repo', created: false, notes: [] }),
    ...over,
  }
}

/**
 * `hpipe start` checks bd and bv and sets up a Beads store; a call here gets the
 * fake above instead of spawning the machine's own binaries into a temp state dir.
 */
export function cmdStart(
  ctx: CmdStartArgs[0], input: Omit<CmdStartArgs[1], 'prefix'> & { prefix?: string | null },
  beads: StartBeads = startBeads(),
): ReturnType<typeof cmdStartWithRealBeads> {
  return cmdStartWithRealBeads(ctx, { prefix: null, ...input }, beads)
}
```

In `test/cli.test.ts`, replace line 6:

```ts
import { cmdRewind, cmdStart, listFlag } from '../src/cli'
```

with:

```ts
import { cmdRewind, listFlag } from '../src/cli'
import type { SetupInput } from '../src/lib/beads-setup'
import { cmdStart, READY_TOOLS, startBeads } from './helpers/cmd-start'
```

Append to `test/cli.test.ts`:

```ts
const startInput = {
  title: 'a', repoKey: 'k', socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
}

test('start sets Beads up before it opens the run, and says what it set up', async () => {
  const asked: SetupInput[] = []
  const out = await cmdStart(ctx(), { ...startInput, repoRoot: repoDir, prefix: 'hp' }, startBeads({
    setup: async (input) => {
      asked.push(input)
      return { ok: true, slug: 'k-abc123', prefix: 'hp', created: true, notes: [] }
    },
  }))
  expect(out.ok).toBe(true)
  expect(asked).toEqual([{ stateDir: dir, repoKey: 'k', repoRoot: repoDir, prefix: 'hp' }])
  expect(out.text).toContain(`beads: created ${join(dir, 'beads', 'k-abc123')} with prefix hp`)
  expect(out.text).toContain('intake')
})

test('start refuses without a working bd, and neither sets up nor opens a run', async () => {
  let setups = 0
  const out = await cmdStart(ctx(), { ...startInput, repoRoot: repoDir }, startBeads({
    tools: async () => ({ ...READY_TOOLS, bd: { state: 'old', version: '1.0.4' } }),
    setup: async () => {
      setups++
      return { ok: true, slug: 's-123456', prefix: 'p', created: false, notes: [] }
    },
  }))
  expect(out.ok).toBe(false)
  expect(out.text).toContain('bd 1.0.4 is older than 1.3.1')
  expect(setups).toBe(0)
  expect(await liveRun()).toBeNull()
})

test('a refused setup opens no run and passes its reason through', async () => {
  const out = await cmdStart(ctx(), { ...startInput, repoRoot: repoDir }, startBeads({
    setup: async () => ({ ok: false, error: 'prefix hp is already the Beads prefix of /code/other — pass --prefix <another>' }),
  }))
  expect(out.ok).toBe(false)
  expect(out.text).toContain('pass --prefix <another>')
  expect(await liveRun()).toBeNull()
})

test('start goes ahead without bv, saying the board and hpipe next are off', async () => {
  const out = await cmdStart(ctx(), { ...startInput, repoRoot: repoDir }, startBeads({
    tools: async () => ({ ...READY_TOOLS, bv: { state: 'missing', detail: 'ENOENT' } }),
  }))
  expect(out.ok).toBe(true)
  expect(out.text).toContain('tools: bv did not run (ENOENT) — brew install dicklesworthstone/tap/bv')
  expect(out.text).toContain('the board and `hpipe next` stay off')
  expect((await liveRun())?.title).toBe('a')
})
```

Append to `test/status.test.ts`:

```ts
test('a tools problem is printed right under the supervisor line, and nothing when there is none', () => {
  const line = 'tools: bv did not run (ENOENT) — brew install dicklesworthstone/tap/bv'
  const text = formatStatus([], { state: 'live', pid: 1 }, 'personal', HP, new Set(), Date.now(), {}, line)
  expect(text.split('\n').slice(0, 3)).toEqual(['session: personal', 'supervisor: live (pid 1)', line])
  expect(formatStatus([], { state: 'live', pid: 1 }, 'personal', HP)).not.toContain('tools:')
})
```

In `test/cli-commands.test.ts`, add below the `import { cmdTask } from './helpers/cmd-task'` line:

```ts
import { READY_TOOLS } from './helpers/cmd-start'
```

and change line 63 from:

```ts
  expect((await cmdStatus(ctx())).text).toContain('no active runs')
```

to:

```ts
  expect((await cmdStatus(ctx(), async () => READY_TOOLS)).text).toContain('no active runs')
```

- [ ] **Step 6: Give the argv suite fake `bd` and `bv` binaries**

`hpipe start` now spawns `bd` and `bv`, and the argv suite's fixture is synchronous. In
`test/helpers/fake-bin.ts`, replace the whole file with:

```ts
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Writes an executable that echoes a canned JSON response per argv prefix and
 * appends every invocation to `calls.log`. Responses are matched on the longest
 * prefix, so 'pane list' wins over 'pane'. An `error` envelope goes to stderr
 * with exit 1 and nothing on stdout, which is what herdr 0.9.0 does. A string
 * response is printed as it is, the way herdr 0.9.0 prints `pane read`.
 */
export function makeFakeBinSync(
  dir: string,
  responses: Record<string, unknown>,
  exitCodes: Record<string, number> = {},
): string {
  const path = join(dir, 'fake-bin')
  const table = JSON.stringify(responses)
  const codes = JSON.stringify(exitCodes)

  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, argv.join(' ') + '\\n')
const table = ${table}
const codes = ${codes}
const joined = argv.join(' ')
// Require a token boundary after the match: without it, a stub for
// 'agent get w1:p1' silently answers 'agent get w1:p10' with the wrong payload.
const key = Object.keys(table)
  .filter((k) => joined === k || joined.startsWith(k + ' '))
  .sort((a, b) => b.length - a.length)[0]
if (key === undefined) {
  process.stderr.write(JSON.stringify({ error: { code: 'unstubbed', message: joined } }))
  process.exit(1)
}
const response = table[key]
const isError = typeof response === 'object' && response !== null && 'error' in response
;(isError ? process.stderr : process.stdout)
  .write(typeof response === 'string' ? response : JSON.stringify(response))
process.exit(codes[key] ?? (isError ? 1 : 0))
`)
  chmodSync(path, 0o755)
  return path
}

export async function makeFakeBin(
  dir: string,
  responses: Record<string, unknown>,
  exitCodes: Record<string, number> = {},
): Promise<string> {
  return makeFakeBinSync(dir, responses, exitCodes)
}
```

In `test/cli-argv.test.ts`, change line 4 from:

```ts
import { makeFakeBin } from './helpers/fake-bin'
```

to:

```ts
import { makeFakeBin, makeFakeBinSync } from './helpers/fake-bin'
```

Insert above `function fixture(): Fixture {`:

```ts
/**
 * `hpipe start` checks bd and bv and sets up a Beads store, so the suite stands
 * in for both rather than touching the machine's own. Any bd call a change adds
 * that is not stubbed here fails loudly; a test exercising more of bd replaces
 * `f.env.BD_BIN` with its own fake bin.
 */
const BD_RESPONSES: Record<string, unknown> = {
  version: 'bd version 1.3.1 (Homebrew)\n',
  '--json --actor hpipe init': {},
  '--json --actor hpipe config set issue_id_mode counter': {},
  '--json --actor hpipe export': {},
}
const BV_RESPONSES: Record<string, unknown> = { '--version': 'bv v0.25.2\n' }
```

and in `fixture()`, change the `env` literal's last line from:

```ts
    GH_BIN: defaultGhBin(),
  }
```

to:

```ts
    GH_BIN: defaultGhBin(),
    BD_BIN: makeFakeBinSync(tempDir('hpipe-argv-bd-'), BD_RESPONSES),
    BV_BIN: makeFakeBinSync(tempDir('hpipe-argv-bv-'), BV_RESPONSES),
  }
```

Both repos of the cross-repo test default to the same prefix (`hpipe-ar`), which setup refuses. In
`test('decide from another repo does not reach the first repo run'`, change:

```ts
  expect(hpipe(['start', 'repo b'], b).code).toBe(0)
```

to:

```ts
  expect(hpipe(['start', 'repo b', '--prefix', 'repob'], b).code).toBe(0)
```

Append to `test/cli-argv.test.ts`:

```ts
test('start sets up a Beads store once, and --prefix names its prefix without joining the title', () => {
  const f = fixture()
  const r = hpipe(['start', 'argv', 'fixture', '--prefix', 'argv'], f)
  expect(r.code).toBe(0)
  expect(r.out).toContain('beads: created')
  expect(r.out).toContain('with prefix argv')

  const runsDir = join(f.stateDir, 'runs', 'argv-fixture')
  const run = JSON.parse(readFileSync(join(runsDir, readdirSync(runsDir)[0]!), 'utf8')) as { title: string }
  expect(run.title).toBe('argv fixture')
  const slugs = readdirSync(join(f.stateDir, 'beads'))
  expect(slugs).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(f.stateDir, 'beads', slugs[0]!, 'project.json'), 'utf8')))
    .toMatchObject({ prefix: 'argv' })
})

test('start refuses on a bd older than 1.3.1 and opens no run', () => {
  const f = fixture()
  f.env.BD_BIN = makeFakeBinSync(tempDir('hpipe-argv-oldbd-'), { version: 'bd version 1.0.4 (Homebrew)\n' })
  const r = hpipe(['start', 'argv fixture'], f)
  expect(r.code).toBe(1)
  expect(r.out).toContain('bd 1.0.4 is older than 1.3.1')
  expect(existsSync(join(f.stateDir, 'runs', 'argv-fixture'))).toBe(false)
})
```

- [ ] **Step 7: Run them to verify they fail**

Run: `bun test test/cli.test.ts test/status.test.ts test/cli-argv.test.ts test/cli-commands.test.ts`
Expected: FAIL — `SyntaxError: Export named 'StartBeads' not found in module '…/src/cli.ts'` (and the
status test's extra argument is ignored, so its first-three-lines assertion fails).

- [ ] **Step 8: Implement `start --prefix`, setup at start, and the tools line**

In `src/lib/status.ts`, change the `formatStatus` signature and its supervisor block (lines
365-379) from:

```ts
export function formatStatus(
  runs: Run[], supervisor: StatusSupervisor, session: SessionKey, hpipe: string,
  livePanes: ReadonlySet<string> = new Set(), now: number = Date.now(),
  panes: PaneObservations = {},
): string {
  const holds = panes.holds ?? {}
  const lines: string[] = []
  lines.push(`session: ${session}`)
  lines.push(
    `supervisor: ${supervisor.state}${supervisor.pid ? ` (pid ${supervisor.pid})` : ''}`,
  )
  if (supervisor.state !== 'live') {
```

to:

```ts
export function formatStatus(
  runs: Run[], supervisor: StatusSupervisor, session: SessionKey, hpipe: string,
  livePanes: ReadonlySet<string> = new Set(), now: number = Date.now(),
  panes: PaneObservations = {}, tools: string | null = null,
): string {
  const holds = panes.holds ?? {}
  const lines: string[] = []
  lines.push(`session: ${session}`)
  lines.push(
    `supervisor: ${supervisor.state}${supervisor.pid ? ` (pid ${supervisor.pid})` : ''}`,
  )
  if (tools !== null) lines.push(tools)
  if (supervisor.state !== 'live') {
```

In `src/cli.ts`, add to the imports (keep them sorted as the file already is):

```ts
import { type SetupInput, type SetupResult, setupBeads, setupLines } from './lib/beads-setup'
import { bdProblem, bvProblem, checkTools, type Tools, toolsLine } from './lib/tools'
```

Replace `cmdStart` (lines 176-202) with:

```ts
export interface StartBeads {
  tools: () => Promise<Tools>
  setup: (input: SetupInput) => Promise<SetupResult>
}

const REAL_START_BEADS: StartBeads = { tools: checkTools, setup: (input) => setupBeads(input) }

export async function cmdStart(ctx: Ctx, input: {
  title: string; repoKey: string; repoRoot: string
  socketPath: string; paneId: string; workspaceId: string
  prefix: string | null
}, beads: StartBeads = REAL_START_BEADS): Promise<CmdResult> {
  const existing = await runForRepo(ctx.stateDir, ctx.session, input.repoKey)
  if (existing.kind !== 'free') {
    const blocker = existing.kind === 'ambiguous' ? existing.runs[0] as Run : existing.run
    return fail(`a run is already active for this repo: ${blocker.run_id} (phase ${blocker.phase}). ` +
      `Finish it, or run: ${hpipeCommand(ctx.pluginRoot)} abort ${blocker.run_id}`)
  }

  const tools = await beads.tools()
  const bdBroken = bdProblem(tools.bd)
  if (bdBroken !== null) return fail(`${bdBroken}\nhpipe start needs a working bd; nothing was started`)
  const setup = await beads.setup({
    stateDir: ctx.stateDir, repoKey: input.repoKey, repoRoot: input.repoRoot, prefix: input.prefix,
  })
  if (!setup.ok) return fail(setup.error)
  const bvBroken = bvProblem(tools.bv)

  const run = newRun({
    session: ctx.session, socketPath: input.socketPath,
    repoKey: input.repoKey, repoRoot: input.repoRoot, title: input.title,
  })
  run.orchestrator_pane = input.paneId
  await saveRun(ctx.stateDir, run)
  await writeOrchestrator(ctx.stateDir, ctx.session, input.repoKey, {
    pane_id: input.paneId, workspace_id: input.workspaceId,
    socket_path: input.socketPath, claimed_at: Date.now(),
  })

  const intake = await renderPrompt(ctx.pluginRoot, 'intake', {
    run_id: run.run_id, title: run.title,
  })
  const preface = [
    ...setupLines(setup, ctx.stateDir),
    ...(bvBroken === null ? [] : [`tools: ${bvBroken} — the board and \`hpipe next\` stay off until it is fixed`]),
  ]
  return ok(`${preface.join('\n')}\n\n${intake}`, JSON.stringify({ run_id: run.run_id }))
}
```

Replace `cmdStatus` (lines 925-942) with:

```ts
export async function cmdStatus(ctx: Ctx, tools: () => Promise<Tools> = checkTools): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const state = await supervisorState(ctx.stateDir, ctx.session)
  const herdr = new Herdr()
  const { livePanes, panes } = await observePanes(
    () => herdr.paneList(), ctx.stateDir, ctx.session,
    state.state === 'live' ? state.info.pid : undefined,
  )
  return ok(formatStatus(
    runs,
    { state: state.state, pid: 'info' in state ? state.info.pid : undefined },
    ctx.session,
    hpipeCommand(ctx.pluginRoot),
    livePanes,
    Date.now(),
    panes,
    toolsLine(await tools()),
  ))
}
```

Add, above `function positionals(`:

```ts
function withoutFlag(argv: string[], name: string): string[] {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]
}
```

Change the `start` usage (line 1027) from:

```ts
  start: ['hpipe start <title>'],
```

to:

```ts
  start: ['hpipe start <title> [--prefix <bead-prefix>]'],
```

Change the argv `start` case (lines 1135-1143) from:

```ts
    case 'start':
      out = await cmdStart(ctx, {
        title: rest.join(' ').trim(),
```

to:

```ts
    case 'start':
      out = await cmdStart(ctx, {
        title: withoutFlag(rest, 'prefix').join(' ').trim(),
        prefix: flag(rest, 'prefix'),
```

(the remaining lines of the case are unchanged).

In `src/actions/status.ts`, change the import block's last line and the `formatStatus` call
(lines 8, 20-28) to:

```ts
import { formatStatus } from '../lib/status'
import { checkTools, toolsLine } from '../lib/tools'
```

```ts
console.log(formatStatus(
  await listRuns(stateDir, session),
  { state: state.state === 'live' ? 'live' : state.state, pid: 'info' in state ? state.info.pid : undefined },
  session,
  hpipeCommand(pluginRoot),
  livePanes,
  Date.now(),
  panes,
  toolsLine(await checkTools()),
))
```

In `src/startup.ts`, add to the imports:

```ts
import { checkTools, toolsLine } from './lib/tools'
```

and in `main()`, after `await gcStaleTmp(join(stateDir, 'queue', session), ONE_HOUR_MS)`, insert:

```ts
  const toolsWarning = toolsLine(await checkTools())
  if (toolsWarning !== null) console.error(`[pipeline] ${toolsWarning}`)
```

- [ ] **Step 9: Add the setup action**

Create `src/actions/beads-setup.ts`:

```ts
import { setupBeads, setupLines } from '../lib/beads-setup'
import { repoContext } from '../lib/repo'
import { bdProblem, checkBd } from '../lib/tools'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const repo = await repoContext()
if (!repo) {
  console.error('[pipeline] "Set up Beads for this repo" must be invoked from a pane inside a git repository')
  process.exit(1)
}

const broken = bdProblem(await checkBd())
if (broken !== null) {
  console.error(`[pipeline] ${broken}`)
  process.exit(1)
}

// herdr actions take no input, so the prefix override rides in the environment.
const result = await setupBeads({
  stateDir, repoKey: repo.repoKey, repoRoot: repo.repoRoot, prefix: process.env.HPIPE_BEADS_PREFIX ?? null,
})
if (!result.ok) {
  console.error(`[pipeline] ${result.error}`)
  process.exit(1)
}
for (const line of setupLines(result, stateDir)) console.log(`[pipeline] ${line}`)
```

In `herdr-plugin.toml`, insert after the `install-cli` action (after line 75):

```toml

[[actions]]
id = "beads-setup"
title = "Set up Beads for this repo"
contexts = ["pane"]
command = ["bun", "run", "src/actions/beads-setup.ts"]
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `bun test test/cli.test.ts test/status.test.ts test/cli-argv.test.ts test/cli-commands.test.ts test/prompts.test.ts`
Expected: PASS. (`prompts.test.ts` checks the new action's script exists.)

- [ ] **Step 11: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/beads-setup.ts src/actions/beads-setup.ts src/cli.ts src/lib/status.ts src/actions/status.ts \
  src/startup.ts herdr-plugin.toml test/beads-setup.test.ts test/helpers/cmd-start.ts test/helpers/fake-bin.ts \
  test/cli.test.ts test/status.test.ts test/cli-commands.test.ts test/cli-argv.test.ts
git commit -m "feat: set up a Beads store at hpipe start, with --prefix, a setup action and tools warnings

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 5: Schema v3 — `issue` becomes `bead`, the captured brief, `--title`/`--bead` through `Bd`

One commit: the type change, its every reader, the 14 templates that render `{{issue}}` and the
removal of the `gh` issue functions cannot be split without a red tree (`render()` throws on an
unresolved placeholder, `src/lib/render.ts:8-13`, and `issueView(task.issue)` stops compiling).
The close row's *signal* switches here (deviation 2); its wiring is Task 9.

**Files:**
- Create: `test/helpers/bead-fields.ts`
- Modify: `src/lib/types.ts:35-45,128-209`; `src/lib/decisions.ts:15-16`; `src/lib/ledger.ts:15-45,300-361`
- Modify: `src/supervisor/main.ts:46-52,203,309`; `src/lib/status.ts:5,259,398,425,432,435,486`
- Modify: `src/supervisor/tick.ts:60,140,155`; `src/supervisor/deliver.ts:402,465`; `src/lib/awaiting.ts:21,27`
- Modify: `src/supervisor/stall.ts:341-352`; `src/lib/machine.ts:158-172,229-251`
- Modify: `src/supervisor/tasks.ts:10,44,118,143-144,221,300-315,393-410,594`
- Modify: `src/lib/worker-prompt.ts:1-30`; `src/lib/verdict-path.ts:19-21`; `src/lib/gating.ts:95`; `src/lib/tiers.ts:1-8,37,43`
- Modify: `src/lib/gh.ts:13-25,111-137`
- Modify: `src/cli.ts:1-32,204-457,760,1028-1030,1145-1161`
- Modify: `prompts/worker-brief.md` (whole file), `prompts/research.md:8,17`, `prompts/spec.md:1-3,20-21`,
  `prompts/spec-review.md:1,23-24`, `prompts/plan.md:1,30-31`, `prompts/plan-review.md:1`,
  `prompts/implement.md:1,8,21-27`, `prompts/pr-review.md:1,28-29,34`, `prompts/pr-review-intent.md:1,27-30`,
  `prompts/pr-review-quality.md:1`, `prompts/ci-red.md:1`, `prompts/merge.md:1`, `prompts/close.md` (whole file),
  `prompts/decision.md:1,15`, `prompts/dispatch.md:43-44`
- Test: every `test/*.test.ts` that builds a `Task` (mechanical, Step 2), `test/helpers/cmd-task.ts`, and the
  rewrites in Steps 3-11

- [ ] **Step 1: Add the v3 task fields helper for test fixtures**

Create `test/helpers/bead-fields.ts`:

```ts
import type { BeadBrief, BeadSync, Discovery } from '../../src/lib/types'

/**
 * The fields every v3 task carries beyond the ones a fixture is about. A function,
 * not a constant: the reconciler and `discover` mutate them in place, and a shared
 * object would leak one test's writes into the next.
 */
export function beadTaskFields(): {
  brief: BeadBrief; bead_closed_at_ms: number | null; bead_sync: BeadSync; discoveries: Discovery[]
} {
  return {
    brief: {
      title: 'Relabel the tile', description: 'The settings tile says Foo; it should say Bar.',
      acceptance: 'The tile reads Bar.', labels: [], captured_at_ms: 0,
    },
    bead_closed_at_ms: null,
    bead_sync: { failures: 0, last_error: null, last_ok_at_ms: null },
    discoveries: [],
  }
}
```

- [ ] **Step 2: Convert every test fixture mechanically**

Save this one-off script outside the repo and run it from the repo root; it is not committed:

```bash
cat > "${TMPDIR:-/tmp}/beads-v3-fixtures.ts" <<'TS'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GENERIC: Array<[RegExp, string]> = [
  [/issue_closed_at_entry: false, (passes: \{\})/g, '...beadTaskFields(), $1'],
  [/\bissue: (\d+)/g, "bead: 'hp-$1'"],
  [/\(#(\d+)([,)])/g, '(hp-$1$2'],
  [/\bissue-(\d+)/g, 'hp-$1'],
  [/— issue #(\d+)/g, '— hp-$1'],
  [/'issue #(\d+)'/g, "'hp-$1'"],
  [/'issue: {6}#(\d+)'/g, "'bead:       hp-$1'"],
  [/(answered_at: [^,]+, prompted_at: [^,\n]+,)/g, '$1 escalated_at: null, orchestrator_recommendation: null,'],
  [/^[ \t]*issueView: [^\n]*\n/gm, ''],
]
const SPECIFIC: Record<string, Array<[RegExp, string]>> = {
  'status.test.ts': [[/(\w) #(\d+) \[/g, '$1 hp-$2 [']],
  'machine-task.test.ts': [[/issueClosed: (?:true|false),\s*/g, ''], [/closedAtMs(?:: \d+)?,\s*/g, '']],
  'cli-commands.test.ts': [[/undefined, fetchedBase, async \(\) => \[\]\)/g, 'undefined, fetchedBase)']],
}
const ONLY_SPECIFIC: Record<string, Array<[RegExp, string]>> = {
  'cli-argv.test.ts': [[/'--issue', '(\d+)'/g, "'--bead', 'argv-$1'"]],
}
const IMPORT = "import { beadTaskFields } from './helpers/bead-fields'\n"

function addImport(text: string): string {
  if (!text.includes('beadTaskFields()') || text.includes(IMPORT)) return text
  const imports = [...text.matchAll(/^(?:import [^\n]*from '[^']+'|\} from '[^']+')\n/gm)]
  const last = imports.at(-1)
  if (last?.index === undefined) return IMPORT + text
  const at = last.index + last[0].length
  return text.slice(0, at) + IMPORT + text.slice(at)
}

for (const name of readdirSync('test').filter((n) => n.endsWith('.test.ts'))) {
  const path = join('test', name)
  const before = readFileSync(path, 'utf8')
  const rules = ONLY_SPECIFIC[name] ?? [...GENERIC, ...(SPECIFIC[name] ?? [])]
  const after = addImport(rules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), before))
  if (after !== before) {
    writeFileSync(path, after)
    console.log(`converted ${path}`)
  }
}
TS
bun "${TMPDIR:-/tmp}/beads-v3-fixtures.ts"
```

Expected: one `converted test/…` line for each of `ci`, `cli`, `cli-argv`, `cli-commands`, `courier`,
`decide`, `deliver`, `gating`, `ledger`, `machine-task`, `outbox`, `prompts`, `stall`, `status`,
`table`, `tasks`, `teardown`, `tick`, `tier-prompt`, `tiers`, `unstarted`, `verdict-path`, plus
`bootstrap` (a path string only). Then make the semantic rewrites below; the script cannot.

- [ ] **Step 3: Rewrite `test/helpers/cmd-task.ts`**

Replace the whole file with:

```ts
import { cmdTask as cmdTaskWithRealBeads, type RegistrationBeads } from '../../src/cli'
import type { BeadDetail } from '../../src/lib/bd'

type CmdTaskArgs = Parameters<typeof cmdTaskWithRealBeads>

export function openBead(id: string, over: Partial<BeadDetail> = {}): BeadDetail {
  return {
    id, title: `Bead ${id}`, description: `What ${id} asks for.`, acceptance_criteria: `${id} is done.`,
    status: 'open', labels: [], dependencies: [], dependents: [], comments: [], ...over,
  }
}

/** Files every bead as hp-318, and shows any id as an open, unassigned, unlinked bead. */
export function fakeBeads(over: Partial<RegistrationBeads> = {}): RegistrationBeads {
  return {
    create: async () => ({ id: 'hp-318' }),
    show: async (_repoKey, id) => openBead(id),
    ...over,
  }
}

/**
 * Registration reads and files beads through `bd`; a call here without beads of
 * its own gets the fake above instead of a real store, which a temp state dir lacks.
 */
export function cmdTask(
  ctx: CmdTaskArgs[0], input: CmdTaskArgs[1], beads: RegistrationBeads = fakeBeads(),
  dispatchBase?: CmdTaskArgs[3],
): ReturnType<typeof cmdTaskWithRealBeads> {
  return cmdTaskWithRealBeads(ctx, input, beads, dispatchBase)
}
```

- [ ] **Step 4: Rewrite the registration tests in `test/cli-commands.test.ts`**

Change the helper import (line 10) from:

```ts
import { cmdTask } from './helpers/cmd-task'
```

to (`cmdBrief` is already in the `../src/cli` import list at the top of the file):

```ts
import type { BeadCreateInput, BeadDetail } from '../src/lib/bd'
import { cmdTask, fakeBeads, openBead } from './helpers/cmd-task'
```

Replace the whole test `test('task registration requires an issue and seeds artifact paths'` with:

```ts
test('task registration records the bead and its brief, and seeds artifact paths from the bead id', async () => {
  // t1 stays in flight so the new task's dependsOn leaves it gated — a task
  // dispatched immediately at registration moves off 'queued' (covered by
  // cli.test.ts), which is not what this test is checking.
  const run = runWithTasks([{ task_id: 't1', phase: 'implement' }])
  run.repo_root = repoDir
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/land-first', bead: 'hp-210', surface: 'core', notes: 'land first',
    dependsOn: ['t1'], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(true)

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  const task = saved?.tasks.find((t) => t.task_id === 't2')
  expect(task?.bead).toBe('hp-210')
  expect(task?.brief).toMatchObject({ title: 'Bead hp-210', description: 'What hp-210 asks for.', acceptance: 'hp-210 is done.' })
  expect(task?.bead_closed_at_ms).toBeNull()
  expect(task?.bead_sync).toEqual({ failures: 0, last_error: null, last_ok_at_ms: null })
  expect(task?.discoveries).toEqual([])
  expect(task?.notes).toBe('land first')
  expect(task?.artifacts.research).toContain('hp-210')
  expect(task?.artifacts.spec).toContain('hp-210')
  expect(task?.artifacts.plan).toContain('hp-210')
  expect(task?.registered_at).toBeGreaterThan(0)
  expect(task?.phase).toBe('queued')
})
```

Replace everything from the line `const unfiledTask = {` through the end of
`test('with neither --issue nor --title the error names both ways in'` with:

```ts
const unfiledTask = {
  branch: 'feat/tile-label', surface: 'core', notes: '',
  dependsOn: [] as string[], files: [] as string[], keepWorktree: false,
  repoKey: 'k', runId: null,
}

async function seedInRepoWithBrief(): Promise<string> {
  await saveRun(dir, newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' }))
  const bodyFile = join(repoDir, 'brief.md')
  writeFileSync(bodyFile, 'Relabel the settings tile.\n')
  return bodyFile
}

const registered = async (): Promise<Task[]> => (await listRuns(dir, 'personal'))[0]!.tasks

/** Lands a write between the command's read and its save, as the supervisor would. */
async function supervisorWrites(change: (run: Run) => void): Promise<void> {
  const run = (await listRuns(dir, 'personal'))[0]!
  change(run)
  await saveRun(dir, run)
}

const counting = (): { beads: ReturnType<typeof fakeBeads>; created: () => number; shown: () => number } => {
  let created = 0
  let shown = 0
  return {
    beads: fakeBeads({
      create: async () => { created++; return { id: 'hp-318' } },
      show: async (_repoKey, id) => { shown++; return openBead(id) },
    }),
    created: () => created,
    shown: () => shown,
  }
}

test('--title files the bead with its body and acceptance, and registers the task under its id', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const acceptanceFile = join(repoDir, 'acceptance.md')
  writeFileSync(acceptanceFile, 'The tile reads Bar.\n')
  const filed: Array<[string, BeadCreateInput]> = []

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 'Relabel the tile', bodyFile, acceptanceFile },
    fakeBeads({ create: async (repoKey, input) => { filed.push([repoKey, input]); return { id: 'hp-318' } } }))

  expect(result.ok).toBe(true)
  expect(result.text).toContain('bead: hp-318 (filed)')
  expect(filed).toEqual([['k', {
    title: 'Relabel the tile', body: 'Relabel the settings tile.\n', acceptance: 'The tile reads Bar.\n', labels: [],
  }]])
  const task = (await registered())[0]!
  expect(task.bead).toBe('hp-318')
  expect(task.artifacts.spec).toContain('hp-318')
  expect(task.brief).toMatchObject({
    title: 'Relabel the tile', description: 'Relabel the settings tile.\n', acceptance: 'The tile reads Bar.\n', labels: [],
  })
})

test('--bead adopts an open, unassigned bead and captures its brief from bd show', async () => {
  await seedInRepoWithBrief()
  const shown: string[] = []
  const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-12' }, fakeBeads({
    show: async (_repoKey, id) => {
      shown.push(id)
      return openBead(id, { title: 'Fix the meter', description: 'It drifts.', acceptance_criteria: 'It holds.', labels: ['ui'] })
    },
  }))

  expect(result.ok).toBe(true)
  expect(result.text).not.toContain('(filed)')
  expect(shown).toEqual(['hp-12'])
  expect((await registered())[0]).toMatchObject({
    bead: 'hp-12', brief: { title: 'Fix the meter', description: 'It drifts.', acceptance: 'It holds.', labels: ['ui'] },
  })
})

test('brief prints the brief captured at registration', async () => {
  await seedInRepoWithBrief()
  await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-12' },
    fakeBeads({ show: async (_repoKey, id) => openBead(id, { title: 'Fix the meter', description: 'It drifts.' }) }))

  const result = await cmdBrief(ctx(), { taskId: 't1', repoKey: 'k', runId: null })
  expect(result.ok).toBe(true)
  expect(result.text).toContain('**Fix the meter**')
  expect(result.text).toContain('It drifts.')
  expect(result.text).not.toContain('gh issue view')
})

test('--bead and --title together are rejected before anything is filed or read', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const { beads, created, shown } = counting()

  const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-4', title: 't', bodyFile }, beads)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('--bead')
  expect(result.text).toContain('--title')
  expect([created(), shown()]).toEqual([0, 0])
})

test('--title without a --body-file that is a file is rejected, because the body is the brief', async () => {
  await seedInRepoWithBrief()
  const { beads, created } = counting()

  const missing = await cmdTask(ctx(), { ...unfiledTask, title: 't' }, beads)
  const absent = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile: join(repoDir, 'nope.md') }, beads)
  const directory = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile: repoDir }, beads)
  const acceptance = await cmdTask(ctx(),
    { ...unfiledTask, title: 't', bodyFile: join(repoDir, 'brief.md'), acceptanceFile: join(repoDir, 'nope.md') }, beads)

  expect(missing.ok).toBe(false)
  expect(missing.text).toContain('--body-file')
  expect(absent.ok).toBe(false)
  expect(absent.text).toContain('nope.md')
  expect(directory.ok).toBe(false)
  expect(directory.text).toContain('is not a file')
  expect(acceptance.ok).toBe(false)
  expect(acceptance.text).toContain('--acceptance-file is not a file')
  expect(created()).toBe(0)
  expect(await registered()).toEqual([])
})

test('--body-file with --bead is refused: an existing bead already has its brief', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-4', bodyFile })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('only go with --title')
})

test('a --title that swallowed the next flag files nothing', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const { beads, created } = counting()

  const result = await cmdTask(ctx(), { ...unfiledTask, title: '--body-file', bodyFile }, beads)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('the value after --title is missing')
  expect(created()).toBe(0)
})

test('a registration that fails validation files no orphan bead', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const { beads, created } = counting()

  const badSurface = await cmdTask(ctx(), { ...unfiledTask, surface: 'kore', title: 't', bodyFile }, beads)
  const badDepends = await cmdTask(ctx(), { ...unfiledTask, dependsOn: ['t9'], title: 't', bodyFile }, beads)
  const cyclic = await cmdTask(ctx(), { ...unfiledTask, dependsOn: ['t1'], title: 't', bodyFile }, beads)

  expect([badSurface.ok, badDepends.ok, cyclic.ok]).toEqual([false, false, false])
  expect(cyclic.text).toContain('cycle')
  expect(created()).toBe(0)
})

test('a registration that loses its save is retried without filing the bead again', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile }, fakeBeads({
    create: async () => {
      filed++
      await supervisorWrites((run) => { run.intake_closed = true })
      return { id: 'hp-318' }
    },
  }))

  expect(result.ok).toBe(true)
  expect(filed).toBe(1)
  expect((await registered()).map((t) => t.bead)).toEqual(['hp-318'])
})

test('a registration that fails after filing names the bead so it can be registered with --bead', async () => {
  const bodyFile = await seedInRepoWithBrief()
  let filed = 0

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile }, fakeBeads({
    create: async () => {
      filed++
      await supervisorWrites((run) => { run.phase = 'done' })
      return { id: 'hp-318' }
    },
  }))

  expect(result.ok).toBe(false)
  expect(filed).toBe(1)
  expect(result.text).toContain('bead hp-318 was filed but no task was registered')
  expect(result.text).toContain('--bead hp-318')
  expect(await registered()).toEqual([])
})

test('a failure after the registration landed says so, and does not invite a second registration', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const noPrompts = mkdtempSync(join(tmpdir(), 'clicmd-noprompts-'))

  const result = await cmdTask({ ...ctx(), pluginRoot: noPrompts }, { ...unfiledTask, title: 't', bodyFile })
  rmSync(noPrompts, { recursive: true, force: true })

  expect(result.ok).toBe(false)
  expect(result.text).toContain('task t1 is registered with bead hp-318')
  expect(result.text).toContain('hpipe brief --task t1')
  expect(result.text).not.toContain('--bead hp-318')
  expect((await registered()).map((t) => t.bead)).toEqual(['hp-318'])
})

test('a failed bd create registers nothing and passes bd\'s error through', async () => {
  const bodyFile = await seedInRepoWithBrief()

  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile },
    fakeBeads({ create: async () => ({ reason: 'exit', error: 'Error: database is locked' }) }))

  expect(result.ok).toBe(false)
  expect(result.text).toContain('bd create failed')
  expect(result.text).toContain('Error: database is locked')
  expect(await registered()).toEqual([])
})

test('a failed bd show registers nothing and passes bd\'s error through', async () => {
  await seedInRepoWithBrief()
  const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-12' },
    fakeBeads({ show: async () => ({ reason: 'busy', error: 'Beads is busy, retry' }) }))
  expect(result.ok).toBe(false)
  expect(result.text).toContain('bd show hp-12 failed')
  expect(result.text).toContain('Beads is busy, retry')
  expect(await registered()).toEqual([])
})

test('--bead refuses a closed, assigned, blocked or parent bead, and registers nothing', async () => {
  await seedInRepoWithBrief()
  const cases: Array<[Partial<BeadDetail>, string]> = [
    [{ status: 'closed' }, 'bead hp-12 is closed'],
    [{ assignee: 'alice' }, 'bead hp-12 is assigned to alice'],
    [{ dependencies: [{ id: 'hp-2', title: 'x', status: 'open', dependency_type: 'blocks' }] }, 'is blocked by open hp-2'],
    [{ dependents: [{ id: 'hp-9', title: 'child', status: 'in_progress', dependency_type: 'parent-child' }] },
      'has open dependents (hp-9)'],
  ]
  for (const [over, expected] of cases) {
    const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-12' },
      fakeBeads({ show: async (_repoKey, id) => openBead(id, over) }))
    expect(result.ok, expected).toBe(false)
    expect(result.text).toContain(expected)
  }
  expect(await registered()).toEqual([])
})

test('--bead adopts past a closed blocker and a closed dependent', async () => {
  await seedInRepoWithBrief()
  const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-12' }, fakeBeads({
    show: async (_repoKey, id) => openBead(id, {
      dependencies: [{ id: 'hp-2', title: 'x', status: 'closed', dependency_type: 'blocks' }],
      dependents: [{ id: 'hp-9', title: 'y', status: 'closed', dependency_type: 'parent-child' }],
    }),
  }))
  expect(result.ok).toBe(true)
})

test('--bead refuses a bead another session\'s live run holds', async () => {
  await seedInRepoWithBrief()
  const other = newRun({ session: 'work', socketPath: '/s', repoKey: 'k2', repoRoot: '/elsewhere', title: 'b' })
  other.tasks = [mkTask({ task_id: 't4', bead: 'hp-12', phase: 'implement' })]
  await saveRun(dir, other)

  const result = await cmdTask(ctx(), { ...unfiledTask, bead: 'hp-12' })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('bead hp-12 is already held by t4 (implement)')
  expect(result.text).toContain('session work')
  expect(await registered()).toEqual([])
})

test('with neither --bead nor --title the error names both ways in', async () => {
  await seedInRepoWithBrief()

  const result = await cmdTask(ctx(), unfiledTask)

  expect(result.ok).toBe(false)
  expect(result.text).toContain('--bead <id>')
  expect(result.text).toContain('--title')
})
```

Replace `const MERGED_PR_STATE` and the test after it
(`test('rewind to implement or earlier forgets the PR, so a merged one cannot finish the task'`) with:

```ts
const MERGED_PR_STATE: Partial<Task> = {
  pr: 5, ci: 'pass', head_sha_at_entry: 'aaa', merged_at_ms: 9_000, bead_closed_at_ms: 9_500,
}

test('rewind to implement or earlier forgets the PR and the bead close, so neither can finish the task', async () => {
  // `merge` is a level: a sticky pr pointing at an already-merged PR would carry
  // the reworked task straight through merge on the old PR's mergedAt.
  for (const phase of ['implement', 'blocked-on-files', 'plan', 'research'] as const) {
    const run = runWithTasks([{ task_id: 't1', phase: 'done', ...MERGED_PR_STATE }])
    await saveRun(dir, run)

    expect((await cmdRewind(ctx(), { runId: run.run_id, phase, taskId: 't1' })).ok).toBe(true)

    const task = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)?.tasks[0]
    expect(task?.pr, phase).toBeNull()
    expect(task?.ci, phase).toBeNull()
    expect(task?.merged_at_ms, phase).toBeNull()
    expect(task?.bead_closed_at_ms, phase).toBeNull()
  }
})
```

Replace `test('task registration refuses a missing issue number'` with:

```ts
test('task registration refuses a task with no bead at all', async () => {
  // Live-run finding: a mistyped command once minted a ghost task into a running run.
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  await saveRun(dir, run)

  const result = await cmdTask(ctx(), {
    branch: 'feat/x', surface: 'core', notes: '',
    dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: null,
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--bead')

  const saved = (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)
  expect(saved?.tasks).toHaveLength(0)
})
```

Replace everything from `const existingIssue = {` through the end of
`test('a registration that loses its save reads the labels once'` with:

```ts
const existingBead = {
  branch: 'feat/tiered', bead: 'hp-12', surface: 'core', notes: '',
  dependsOn: [] as string[], files: [] as string[], keepWorktree: false,
  repoKey: 'k', runId: null,
}

const labelled = (...labels: string[]) => fakeBeads({ show: async (_repoKey, id) => openBead(id, { labels }) })

const headLines = (text: string): string[] => text.split('\n\n')[0]!.split('\n')

test('a pipeline:tier label beats --tier, and the tier line says what --tier said', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), { ...existingBead, tier: 'standard', callerPane: 'w1:p1' },
    labelled('bug', 'pipeline:tier-light'), fetchedBase)

  expect(result.ok).toBe(true)
  expect(headLines(result.text).slice(0, 2)).toEqual([
    'task_id: t1', 'tier: light (label pipeline:tier-light; --tier said standard)',
  ])
  const task = (await registered())[0]!
  expect(task.tier).toBe('light')
  expect(task.tier_history).toEqual([{
    at: expect.any(Number), from: null, to: 'light', source: 'label', pane: 'w1:p1',
    why: 'label pipeline:tier-light; --tier said standard',
  }])
})

test('--tier with no tier label is recorded as the flag', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), { ...existingBead, tier: 'heavy' }, labelled('bug'), fetchedBase)
  expect(headLines(result.text)).toContain('tier: heavy (--tier)')
  expect((await registered())[0]!.tier_history?.[0]).toMatchObject({ source: 'flag', pane: null })
})

test('with neither a label nor --tier the task is standard', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), existingBead, labelled(), fetchedBase)
  expect(headLines(result.text)).toContain('tier: standard (default)')
  expect((await registered())[0]!.tier).toBe('standard')
})

test('two tier labels refuse the registration and record nothing', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), existingBead, labelled('pipeline:tier-light', 'pipeline:tier-heavy'), fetchedBase)
  expect(result.ok).toBe(false)
  expect(result.text).toContain('pipeline:tier-light, pipeline:tier-heavy')
  expect(await registered()).toEqual([])
})

test('an unknown tier label refuses the registration', async () => {
  await seedInRepo()
  const result = await cmdTask(ctx(), existingBead, labelled('pipeline:tier-huge'), fetchedBase)
  expect(result.ok).toBe(false)
  expect(result.text).toContain('unknown tier label pipeline:tier-huge')
  expect(await registered()).toEqual([])
})

test('an unknown --tier files no bead', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const { beads, created } = counting()
  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile, tier: 'huge' }, beads)
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--tier must be one of light, standard, heavy, got: huge')
  expect(created()).toBe(0)
})

test('an unknown --tier is refused before the bead is read', async () => {
  await seedInRepo()
  const { beads, shown } = counting()
  const result = await cmdTask(ctx(), { ...existingBead, tier: 'huge' }, beads, fetchedBase)
  expect(result.ok).toBe(false)
  expect(result.text).toContain('--tier must be one of light, standard, heavy, got: huge')
  expect(shown()).toBe(0)
})

test('a filed bead has no labels to read, so --title reads nothing', async () => {
  const bodyFile = await seedInRepoWithBrief()
  const { beads, shown } = counting()
  const result = await cmdTask(ctx(), { ...unfiledTask, title: 't', bodyFile }, beads, fetchedBase)
  expect(result.ok).toBe(true)
  expect(shown()).toBe(0)
  expect(headLines(result.text).slice(0, 3)).toEqual(['task_id: t1', 'tier: standard (default)', 'bead: hp-318 (filed)'])
})

test('a registration that loses its save reads the bead once', async () => {
  await seedInRepo()
  let reads = 0
  const result = await cmdTask(ctx(), existingBead, fakeBeads({
    show: async (_repoKey, id) => {
      reads++
      await supervisorWrites((run) => { run.intake_closed = true })
      return openBead(id, { labels: ['pipeline:tier-heavy'] })
    },
  }), fetchedBase)
  expect(result.ok).toBe(true)
  expect(reads).toBe(1)
  expect((await registered()).map((t) => t.tier)).toEqual(['heavy'])
})
```

- [ ] **Step 5: Rewrite the close and merge tests in `test/machine-task.test.ts` and `test/tasks.test.ts`**

In `test/machine-task.test.ts`, replace
`test('a rewind into merge after the merge reaches teardown through close'` with:

```ts
test('a rewind into merge after the merge reaches teardown through close once the bead close is recorded', () => {
  const { run, task } = fixture('close')
  const mergedAtMs = Date.now() - 60_000
  task.merged_at_ms = null
  task.phase = 'merge'
  task.phase_entered_at = Date.now()

  const s = {
    actorIdle: true, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: true, mergedAtMs,
    ciBucket: null, filesClear: false, maxPasses: 2,
  }
  expect(advanceTask(run, task, s)?.phase).toBe('close')
  expect(advanceTask(run, task, s)).toBeNull()
  task.bead_closed_at_ms = mergedAtMs + 2_000
  expect(advanceTask(run, task, s)?.phase).toBe('teardown')
})
```

and replace the four tests from
`test('merge records merged_at_ms, the merge commit, and whether the issue was already closed'`
through `test('close does not complete on an issue that is still open'` with:

```ts
test('merge records merged_at_ms and the merge commit', () => {
  const { run, task } = fixture('merge')
  task.phase_entered_at = 1000
  advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, mergedAtMs: 2000, mergeCommit: 'm3rg3', ciBucket: null,
    filesClear: false, maxPasses: 2,
  })
  expect(task.phase).toBe('close')
  expect(task.merged_at_ms).toBe(2000)
  expect(task.merge_commit).toBe('m3rg3')
})

test('close completes once a reconciler pass has recorded the bead closed', () => {
  const { run, task } = fixture('close')
  task.merged_at_ms = 2000
  task.bead_closed_at_ms = 2500
  const next = advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, ciBucket: null, filesClear: false, maxPasses: 2,
  })
  expect(next?.phase).toBe('teardown')
})

test('close waits while no bead close is recorded', () => {
  const { run, task } = fixture('close')
  task.merged_at_ms = 2000
  expect(advanceTask(run, task, {
    actorIdle: true, artifactFresh: false, verdict: null, prNumber: 5, headSha: 'a',
    merged: true, ciBucket: null, filesClear: false, maxPasses: 2,
  })).toBeNull()
})
```

In `test/tasks.test.ts`, replace the tests from
`test('a merged PR advances to close, and a closed issue to teardown'` through the end of
`test('close prompts only when the issue is still open'` with:

```ts
test('a merged PR advances to close, and a recorded bead close to teardown', async () => {
  const run = mkRun([mkTask({ phase: 'merge', pr: 42, phase_entered_at: 1_000 })])
  await advanceTasks(run, deps({
    prView: async () => ({ merged: true, mergedAtMs: 2_000, mergeCommit: 'm3rg3', headSha: 'x' }),
  }))
  expect(run.tasks[0]?.phase).toBe('close')
  expect(run.tasks[0]?.merge_commit).toBe('m3rg3')

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('close')

  run.tasks[0]!.bead_closed_at_ms = 3_000
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('teardown')
})

test('a rewind into merge rescues a close whose merge was never recorded', async () => {
  const run = mkRun([mkTask({ phase: 'close', pr: 42, merged_at_ms: null })])
  await advanceTasks(run, deps({ prView: async () => ({ merged: true, mergedAtMs: 10_000, headSha: 'x' }) }))
  expect(run.tasks[0]?.phase).toBe('close')

  Object.assign(run.tasks[0]!, { phase: 'merge', phase_entered_at: Date.now() })
  expect(await advanceTasks(run, deps())).toHaveLength(0)
})

test('close tells the orchestrator the supervisor closes the bead itself', async () => {
  const run = mkRun([mkTask({ phase: 'close', pr: 42 })])
  expect(await promptForTaskPhase(run, run.tasks[0]!, deps(), 'merge'))
    .toContain('The supervisor closes bead `hp-1` itself')
})
```

- [ ] **Step 6: Rewrite the stall, tick, ledger, tiers and gh tests**

In `test/stall.test.ts`, replace `test('a close row names the issue and does not assert it is still open — #19'` with:

```ts
test('a close row waits on the supervisor\'s Beads close and names the merge rewind — #19', () => {
  const run = runWithTask({ phase: 'close' })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.short).toBe('bead hp-1 to be closed by the supervisor')
  expect(a.clause).toContain('close bead hp-1')
  expect(a.clause).toContain(`hp rewind ${run.run_id} merge --task t1`)
  expect(a.clause).not.toContain('gh issue')
  expect(a.clause).not.toContain('whatever clears')
})
```

In `test/tick.test.ts`, change line 12 from:

```ts
import { isCurrentSchemaRun, makeSettledIdleReader, refreshingIdleReader } from '../src/supervisor/main'
```

to:

```ts
import { makeSettledIdleReader, refreshingIdleReader } from '../src/supervisor/main'
```

change the ledger import (line 13) from:

```ts
import { loadRun, newRun, saveRun, StaleRunError } from '../src/lib/ledger'
```

to:

```ts
import { isCurrentSchemaRun, loadRun, newRun, saveRun, StaleRunError } from '../src/lib/ledger'
```

rename `test('a run without schema_version 2 is never advanced'` to
`test('a run without schema_version 3 is never advanced'`, and change:

```ts
  expect(at('close')).toBe('YOUR move: waiting for issue #1 to close')
```

to:

```ts
  expect(at('close')).toBe('YOUR move: waiting for bead hp-1 to be closed by the supervisor')
```

In `test/ledger.test.ts`, add `runForRepo` to the `../src/lib/ledger` import list, and replace
`test('a new run carries schema_version 2 and an open intake'` with:

```ts
test('a new run carries schema_version 3 and an open intake', () => {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  expect(run.schema_version).toBe(3)
  expect(run.intake_closed).toBe(false)
  expect(run.passes).toEqual({})
})

test('runForRepo ignores a run of another schema, so it never blocks hpipe start', async () => {
  const old = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'old' })
  old.schema_version = 2
  await saveRun(dir, old)
  expect((await runForRepo(dir, 'personal', 'k')).kind).toBe('free')

  const current = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'new' })
  await saveRun(dir, current)
  expect(await runForRepo(dir, 'personal', 'k')).toMatchObject({ kind: 'one', run: { run_id: current.run_id } })
})
```

In `test/tiers.test.ts`, delete the whole test
`test('unreadable labels fall back to --tier, else standard, and say why on one line'`.

In `test/gh.test.ts`, delete the tests `'issueView reads closed and closedAt'`,
`'issueCreate files with the given title and body file and returns the new number'`,
`'issueCreate passes gh\'s stderr through on failure, and fails on output with no issue URL'`,
`'issueLabels reads the label names of an existing issue'` and
`'issueLabels passes gh\'s stderr through on failure'`.

- [ ] **Step 7: Rewrite the prompt tests**

In `test/prompts.test.ts`, replace
`test('the worker brief routes to the surface agent and demands a closing keyword'` with:

```ts
test('the worker brief inlines the captured brief and ends the PR body with Refs', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(text).toContain('{{agent_file}}')
  expect(text).toContain('{{brief}}')
  expect(text).toContain('Refs {{bead}}')
  expect(text).not.toContain('gh issue')
  // `render()` throws on a placeholder no caller resolves, so an inherited
  // {{task_text}} kills the first dispatch.
  expect(text).not.toContain('{{task_text}}')
})

test('no template reads an issue any more', async () => {
  for (const name of ALL) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text, name).not.toContain('{{issue}}')
    expect(text, name).not.toContain('gh issue view')
  }
})

test('a rendered worker brief carries the brief captured at registration', async () => {
  const text = await renderBriefFor([briefTask({})], 0)
  expect(text).toContain('# feat/x — hp-1')
  expect(text).toContain('**Relabel the tile**')
  expect(text).toContain('The settings tile says Foo; it should say Bar.')
  expect(text).toContain('The tile reads Bar.')
})
```

- [ ] **Step 8: Rewrite the argv tests in `test/cli-argv.test.ts`**

Replace the doc comment and body of `function defaultGhBin(): string {` with:

```ts
/**
 * Nothing in the CLI calls gh any more; this bin stands in so a change that
 * starts to never shells out to the real `gh` on the machine running the suite.
 * It answers nothing, so such a call fails loudly.
 */
function defaultGhBin(): string {
  const dir = tempDir('hpipe-argv-gh-default-')
  const path = join(dir, 'fake-gh')
  writeFileSync(path, `#!/usr/bin/env bun
console.error('unstubbed: ' + process.argv.slice(2).join(' '))
process.exit(1)
`)
  chmodSync(path, 0o755)
  return path
}
```

Replace `const BD_RESPONSES` (added in Task 4) with:

```ts
const ARGV_BEAD = {
  title: 'Argv fixture bead', description: 'Exercise the argv path.', acceptance_criteria: 'It registers.',
  status: 'open', labels: [] as string[], dependencies: [], dependents: [], comments: [],
}
const BD_RESPONSES: Record<string, unknown> = {
  version: 'bd version 1.3.1 (Homebrew)\n',
  '--json --actor hpipe init': {},
  '--json --actor hpipe config set issue_id_mode counter': {},
  '--json --actor hpipe export': {},
  '--json --actor hpipe show argv-1': [{ id: 'argv-1', ...ARGV_BEAD }],
  '--json --actor hpipe show argv-2': [{ id: 'argv-2', ...ARGV_BEAD, labels: ['pipeline:tier-light'] }],
  '--json --actor hpipe create': { id: 'argv-77' },
}
```

In `test('a resolving command outside a git repo names --run, and --run works from there'`, change:

```ts
  expect(named.stdout.toString()).toContain('issue #1')
```

to:

```ts
  expect(named.stdout.toString()).toContain('— argv-1')
```

Replace `test('task --title --body-file files the issue through gh and registers it'` and
`test('task --title with its value missing does not file an issue named after the next flag'` with:

```ts
const bdCalls = (f: Fixture): string => {
  const log = join(f.env.BD_BIN!.replace(/fake-bin$/, ''), 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8') : ''
}

test('task --title --body-file files the bead through bd and registers it with its brief', () => {
  const f = started()
  writeFileSync(join(f.repo, 'brief.md'), 'Relabel the settings tile.\n')

  const r = hpipe(['task', '--branch', 'feat/tile', '--title', '-relabel the tile',
    '--body-file', 'brief.md', '--surface', 'core'], f)

  expect(r.code).toBe(0)
  expect(r.out).toContain('bead: argv-77 (filed)')
  expect(r.out).toContain('# feat/tile — argv-77')
  expect(bdCalls(f)).toContain('--json --actor hpipe create --title -relabel the tile --body-file ')
  expect(registeredTasks(f)).toMatchObject([{ bead: 'argv-77', brief: { description: 'Relabel the settings tile.\n' } }])
})

test('task --title with its value missing does not file a bead named after the next flag', () => {
  const f = started()
  writeFileSync(join(f.repo, 'brief.md'), 'Relabel the settings tile.\n')

  const r = hpipe(['task', '--branch', 'feat/t', '--title', '--body-file', 'brief.md', '--surface', 'core'], f)

  expect(r.code).toBe(1)
  expect(r.out).toContain('the value after --title is missing')
  expect(bdCalls(f)).not.toContain(' create ')
  expect(registeredTasks(f)).toEqual([])
})
```

In `test('dispatch --task submits the brief through herdr agent prompt and waits for it'`, change:

```ts
  expect(calls).toStartWith('agent prompt w1-2 # smoke/one — issue #1')
```

to:

```ts
  expect(calls).toStartWith('agent prompt w1-2 # smoke/one — argv-1')
```

Replace `test('task --tier reaches registration, and a pipeline:tier label read through gh overrides it'` with:

```ts
test('task --tier reaches registration, and a pipeline:tier label read through bd overrides it', () => {
  const f = started()

  const labelled = hpipe(['task', '--branch', 'smoke/two', '--bead', 'argv-2', '--surface', 'core', '--tier', 'heavy'], f)
  expect(labelled.code).toBe(0)
  expect(labelled.out).toContain('tier: light (label pipeline:tier-light; --tier said heavy)')

  const flagged = hpipe([...TASK, '--tier', 'heavy'], f)
  expect(flagged.code).toBe(0)
  expect(flagged.out).toContain('tier: heavy (--tier)')
  expect(bdCalls(f)).toContain('--json --actor hpipe show argv-2 --include-comments --include-dependents')
})
```

In `test('tier reads its positional tier and --why, and the caller pane from HERDR_PANE_ID'`, delete
the two lines:

```ts
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, { 'issue view': { labels: [] } })
```

- [ ] **Step 9: Run the suite to verify it fails**

Run: `bun test`
Expected: FAIL — a module-level error such as `Export named 'beadPromptVars' not found` /
`'RegistrationBeads' not found`, and `bun run typecheck` reports `Property 'bead' does not exist on
type 'Task'` across the tests.

- [ ] **Step 10: Change the ledger types**

In `src/lib/types.ts`, in `interface Decision` (lines 35-45), insert after `prompted_at: number | null`:

```ts
  /** Set by `hpipe escalate` when the question goes to the human; the bead shows blocked until it is answered. */
  escalated_at: number | null
  /** What the orchestrator recommended when it escalated, posted on the bead beside the worker's. */
  orchestrator_recommendation: string | null
```

Insert above `export interface Task {` (line 128):

```ts
/** The worker's brief for the life of the run: captured at registration, never re-read from the bead. */
export interface BeadBrief {
  title: string
  description: string
  acceptance: string
  labels: string[]
  captured_at_ms: number
}

/** `failures` is monotone; a converged write clears `last_error`. */
export interface BeadSync {
  failures: number
  last_error: string | null
  last_ok_at_ms: number | null
}

/** Out-of-scope work a worker recorded with `hpipe discover`, filed as a bead only by the orchestrator. */
export interface Discovery {
  id: string
  title: string
  body_path: string
  filed_bead: string | null
}
```

In `interface Task`, change line 131 from:

```ts
  issue: number
```

to:

```ts
  bead: string
  brief: BeadBrief
```

and replace lines 166-167:

```ts
  /** True when the issue was already closed at `merge` completion. */
  issue_closed_at_entry: boolean
```

with:

```ts
  /**
   * Set only by a reconciler pass that saw the bead closed after `merged_at_ms`
   * was recorded, and cleared with the merge by a rewind: the close row's edge.
   */
  bead_closed_at_ms: number | null
  bead_sync: BeadSync
  discoveries: Discovery[]
```

In `src/lib/decisions.ts`, change line 16 from:

```ts
    answer: null, answered_by: null, answered_at: null, prompted_at: null,
```

to:

```ts
    answer: null, answered_by: null, answered_at: null, prompted_at: null,
    escalated_at: null, orchestrator_recommendation: null,
```

- [ ] **Step 11: Schema v3 in the ledger, the supervisor and status**

In `src/lib/ledger.ts`, insert above `export function newRun(` (line 15):

```ts
export const SCHEMA_VERSION = 3

/**
 * No in-place migration: a run of another schema is never advanced, never
 * blocks `hpipe start`, and `hpipe status` tells the human to finish it on the
 * release that wrote it.
 */
export function isCurrentSchemaRun(run: Run): boolean {
  return run.schema_version === SCHEMA_VERSION
}
```

change line 40 from `    schema_version: 2,` to `    schema_version: SCHEMA_VERSION,`, and replace
`resolveRun` and `runForRepo` (lines 300-361) with:

```ts
export async function resolveRun(
  stateDir: string, session: SessionKey, query: RunQuery,
): Promise<RunResolution> {
  return resolveAmong(await listRuns(stateDir, session), query)
}

function resolveAmong(runs: Run[], query: RunQuery): RunResolution {
  if (query.runId !== null) {
    const named = runs.find((r) => r.run_id === query.runId)
    if (!named) return { ok: false, reason: 'no-such-run' }
    const state = runPhaseState(named)
    if (state === 'unreadable') return { ok: false, reason: 'unreadable', run: named }
    if (state === 'terminal' && query.reach !== 'finished-if-named') {
      return { ok: false, reason: 'terminal', run: named }
    }
    if (query.reach === 'driven' && !runIsDriven(named)) {
      return { ok: false, reason: 'parked', run: named }
    }
    if (query.phases !== null && !query.phases.includes(named.phase)) {
      return { ok: false, reason: 'wrong-phase', run: named }
    }
    return { ok: true, run: named }
  }

  const inRepo = runs.filter((r) => query.repoKey === null || r.repo_key === query.repoKey)
  const withTask = inRepo.filter(
    (r) => query.taskId === null || r.tasks.some((t) => t.task_id === query.taskId),
  )
  const matched = withTask.filter(
    (r) => withinReach(r, query.reach) &&
      (query.phases === null || query.phases.includes(r.phase)),
  )

  const only = matched[0]
  if (matched.length === 1 && only) return { ok: true, run: only }
  if (matched.length > 1) return { ok: false, reason: 'ambiguous', candidates: matched }
  return { ok: false, reason: 'none', excluded: withTask }
}

export type RepoRun =
  | { kind: 'free' }
  | { kind: 'one'; run: Run }
  | { kind: 'ambiguous'; runs: Run[] }
  | { kind: 'unreadable'; run: Run }

/**
 * "The run for this repo", read the same way by `hpipe start` and the claim
 * action. A run in no phase row still occupies the repo: the old first-match
 * lookup threw on it, and reading it as absent would let `start` open a second
 * run beside it while `claim` reported there was none. A run of another schema
 * does not: nothing will ever advance it here.
 */
export async function runForRepo(
  stateDir: string, session: SessionKey, repoKey: string,
): Promise<RepoRun> {
  const runs = (await listRuns(stateDir, session)).filter(isCurrentSchemaRun)
  const resolved = resolveAmong(runs, {
    runId: null, repoKey, phases: null, taskId: null, reach: 'unfinished',
  })
  if (resolved.ok) return { kind: 'one', run: resolved.run }
  if (resolved.reason === 'ambiguous') return { kind: 'ambiguous', runs: resolved.candidates }
  const unreadable = resolved.reason === 'none'
    ? resolved.excluded.find((r) => runPhaseState(r) === 'unreadable')
    : undefined
  return unreadable ? { kind: 'unreadable', run: unreadable } : { kind: 'free' }
}
```

In `src/supervisor/main.ts`, delete lines 46-52 (the doc comment and `export function
isCurrentSchemaRun`), add `isCurrentSchemaRun` to the `../lib/ledger` import list, and delete
line 309:

```ts
            issueView: (issue) => runGh.issueView(issue),
```

In `src/lib/status.ts`, add `isCurrentSchemaRun` to the `./ledger` import (line 5), then change:
- line 259: `` `    ${task.task_id} ${task.branch} (#${task.issue}) [${task.phase} ${age}m] — ${move.clause}` `` →
  `` `    ${task.task_id} ${task.branch} (${task.bead}) [${task.phase} ${age}m] — ${move.clause}` ``
- line 398: `    if (run.schema_version !== 2) {` → `    if (!isCurrentSchemaRun(run)) {`
- line 425: `` `#${task.issue}`, `` → `task.bead,`
- line 432: `(run.schema_version === 2 ? taskLineMove(` → `(isCurrentSchemaRun(run) ? taskLineMove(`
- line 435: `    if (run.schema_version === 2) {` → `    if (isCurrentSchemaRun(run)) {`
- line 486: `` `issue:      #${task.issue}`, `` → `` `bead:       ${task.bead}`, ``

- [ ] **Step 12: Every other display site renders the bead id**

- `src/supervisor/tick.ts:60,140,155`: `(#${task.issue})` → `(${task.bead})` (three places).
- `src/supervisor/deliver.ts:402`: `` (#${t.issue}, `` → `` (${t.bead}, ``; `:465`: `(#${t.issue})` → `(${t.bead})`.
- `src/supervisor/tasks.ts:221`: `` `Dispatch ${task.task_id} (${task.branch}, #${task.issue}):\n` `` →
  `` `Dispatch ${task.task_id} (${task.branch}, ${task.bead}):\n` ``.
- `src/lib/awaiting.ts:21`: `` `a pushed PR for ${task.branch} (#${task.issue})` `` →
  `` `a pushed PR for ${task.branch} (${task.bead})` ``; `:27`: `` `issue #${task.issue} to close` `` →
  `` `bead ${task.bead} to be closed by the supervisor` ``.

In `src/supervisor/stall.ts`, replace the `closed` branch (lines 341-352) with:

```ts
  if (row.signal === 'closed' && task) {
    return {
      short: awaitedFor(task),
      clause: `This phase is waiting for the supervisor to close bead ${task.bead}, which it does once ` +
        `the merge is recorded. If no merge is recorded, \`${hpipe} rewind ${run.run_id} merge --task ` +
        `${task.task_id}\` records it.`,
    }
  }
```

- [ ] **Step 13: The machine's merge and close rows**

In `src/lib/machine.ts`, delete lines 167-168 from `TaskSignals`:

```ts
  issueClosed: boolean
  closedAtMs?: number
```

delete line 236 (`      task.issue_closed_at_entry = s.issueClosed`), and replace the `close` case
(lines 240-251) with:

```ts
    // An edge although it reads a field: only a reconciler pass that saw the bead
    // closed after this merge was recorded sets it, and every rewind that clears
    // the merge clears it too.
    case 'close': {
      if (task.bead_closed_at_ms === null) return null
      return enterTaskPhase(run, task, 'teardown', `bead ${task.bead} closed`)
    }
```

- [ ] **Step 14: Prompt variables `{{bead}}` and `{{brief}}`**

In `src/lib/worker-prompt.ts`, change the imports (lines 1-5) to:

```ts
import { briefNote, repoBootstrap } from './bootstrap'
import { taskRow } from './phases'
import { renderPrompt } from './render'
import { tierPromptVars } from './tier-prompt'
import type { BeadBrief, Run, Task } from './types'
```

insert above `export async function renderWorkerPrompt(`:

```ts
export function renderBrief(brief: BeadBrief): string {
  const acceptance = brief.acceptance.trim() === '' ? '(none recorded)' : brief.acceptance.trim()
  return [`**${brief.title}**`, '', brief.description.trim(), '', '**Acceptance**', '', acceptance].join('\n')
}

/** Spread into every task render site, so no template can render without either token. */
export function beadPromptVars(task: Task): { bead: string; brief: string } {
  return { bead: task.bead, brief: renderBrief(task.brief) }
}
```

and change line 23 from `    issue: String(task.issue),` to `    ...beadPromptVars(task),`.

In `src/supervisor/tasks.ts`:
- line 10: `import type { IssueView, PrView } from '../lib/gh'` → `import type { PrView } from '../lib/gh'`
- line 20: `import { renderWorkerPrompt } from '../lib/worker-prompt'` →
  `import { beadPromptVars, renderWorkerPrompt } from '../lib/worker-prompt'`
- delete line 44 (`  issueView: (issue: number) => Promise<IssueView | null>`)
- line 118: `    issue: String(task.issue),` → `    ...beadPromptVars(task),`
- lines 143-144: `return task.issue_closed_at_entry ? '' : renderPrompt(deps.pluginRoot, 'close', common)` →
  `return renderPrompt(deps.pluginRoot, 'close', common)`
- in `gatherSignals`, delete the two `base` lines `    issueClosed: false,` and
  `    closedAtMs: undefined as number | undefined,`, and replace the `merge` and `close` cases
  (lines 393-410) with:

```ts
    case 'merge': {
      if (task.pr === null) return base
      const view = await deps.prView(task.pr)
      if (!view?.merged) return base
      return {
        ...base, merged: true, mergedAtMs: view.mergedAtMs ?? undefined,
        mergeCommit: view.mergeCommit ?? undefined,
      }
    }
    case 'close':
      return base
```

- line 594: `      branch: task.branch, issue: String(task.issue),` →
  `      branch: task.branch, ...beadPromptVars(task),`

- [ ] **Step 15: Verdict prefix, artifact separation, tier labels**

`src/lib/verdict-path.ts:19-21` becomes:

```ts
export function taskVerdictPrefix(task: Pick<Task, 'bead'>): string {
  return task.bead
}
```

`src/lib/gating.ts:95`: `declared: string[], task: Pick<Task, 'issue' | 'artifacts'>,` →
`declared: string[], task: Pick<Task, 'bead' | 'artifacts'>,`.

In `src/lib/tiers.ts`, delete line 1 (`import type { GhFailure } from './gh'`), change lines 7-8 to:

```ts
/** `null` when nothing was read: a bead `hpipe task` just filed carries no labels yet. */
export type LabelRead = string[] | null
```

delete line 37 (`  if ('error' in labels) return { ...fallback, why: … }`), and on line 43 change
`the issue carries` to `the bead carries`.

- [ ] **Step 16: Remove the gh issue functions**

In `src/lib/gh.ts`, delete `FiledIssue`, `GhFailure` and `IssueView` (lines 13-25) and the methods
`issueView`, `issueLabels` and `issueCreate` (lines 111-137, through the closing brace of
`issueCreate`; the class's own closing brace stays).

- [ ] **Step 17: `hpipe task --bead | --title` through `Bd`**

In `src/cli.ts`:
- line 2: `import { existsSync, statSync } from 'node:fs'` → `import { existsSync, readFileSync, statSync } from 'node:fs'`
- delete line 9 (`import { Gh, type FiledIssue, type GhFailure } from './lib/gh'`)
- add, in import order:

```ts
import {
  Bd, CLI_LOCK_WAIT_MS, isBdFailure, type BdFailure, type BeadCreateInput, type BeadDetail, type CreatedBead,
} from './lib/bd'
import { beadsSlug, readBeadsProject } from './lib/beads-project'
import { heldBy } from './lib/held'
```

- line 26: `import { isLowering, pipelinePanes, registrationTier, type LabelRead } from './lib/tiers'` →
  `import { isLowering, pipelinePanes, registrationTier } from './lib/tiers'`
- add `checkBd` to the `./lib/tools` import from Task 4.
- line 32: `import type { Run, RunPhase, Task, TaskPhase } from './lib/types'` →
  `import type { BeadBrief, Run, RunPhase, Task, TaskPhase } from './lib/types'`

Replace everything from `type FileIssue = ` (line 209) through the end of `cmdTask` (line 457) with:

```ts
/** The store for this repo, or why the CLI cannot use one. */
async function cliBd(stateDir: string, repoKey: string): Promise<Bd | BdFailure> {
  const slug = beadsSlug(repoKey)
  if ((await readBeadsProject(stateDir, slug)) === null) {
    return {
      reason: 'unavailable',
      error: `no Beads store for ${repoKey} — \`hpipe start\` there sets one up, or run the "Set up Beads for this repo" action`,
    }
  }
  const broken = bdProblem(await checkBd())
  if (broken !== null) return { reason: 'unavailable', error: broken }
  return new Bd({ stateDir, slug, lockWaitMs: CLI_LOCK_WAIT_MS })
}

async function withCliBd<T>(
  stateDir: string, repoKey: string, use: (bd: Bd) => Promise<T | BdFailure>,
): Promise<T | BdFailure> {
  const bd = await cliBd(stateDir, repoKey)
  return isBdFailure(bd) ? bd : use(bd)
}

export interface RegistrationBeads {
  create: (repoKey: string, input: BeadCreateInput) => Promise<CreatedBead | BdFailure>
  show: (repoKey: string, id: string) => Promise<BeadDetail | BdFailure>
}

const cliRegistrationBeads = (stateDir: string): RegistrationBeads => ({
  create: (repoKey, input) => withCliBd(stateDir, repoKey, (bd) => bd.create(input)),
  show: (repoKey, id) => withCliBd(stateDir, repoKey, (bd) => bd.show(id)),
})

/** What one `hpipe task` call carries across the stale-run retries of its registration. */
interface RegistrationAttempt {
  fileBeadOnce: (repoKey: string, input: BeadCreateInput) => Promise<CreatedBead | BdFailure>
  showBeadOnce: (repoKey: string, id: string) => Promise<BeadDetail | BdFailure>
  landed: (taskId: string) => void
  dispatchBase: DispatchBaseFor
}

type DispatchBaseFor = (repoRoot: string, dependencyMerges: string[] | null) => Promise<DispatchBase>

interface TaskInput {
  branch: string; bead?: string; surface: string; notes: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
  repoKey: string | null; runId: string | null
  title?: string; bodyFile?: string; acceptanceFile?: string
  tier?: string
  callerPane?: string | null
}

const isReadableFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()

/**
 * Why an existing bead cannot become a task, or null. Each refusal keeps one of
 * bd's close guards from firing at merge: a foreign assignee, an open blocker,
 * or an open child.
 */
async function adoptionRefusal(stateDir: string, bead: BeadDetail): Promise<string | null> {
  if (bead.status === 'closed') return `bead ${bead.id} is closed — adopt an open bead, or file a new one with --title`
  if ((bead.assignee ?? '') !== '') {
    return `bead ${bead.id} is assigned to ${bead.assignee} — only an unassigned bead can be adopted`
  }
  const holder = await heldBy(stateDir, bead.id)
  if (holder !== null) {
    return `bead ${bead.id} is already held by ${holder.task_id} (${holder.phase}) in run ${holder.run_id}, ` +
      `session ${holder.session}`
  }
  const blockers = (bead.dependencies ?? []).filter((d) => d.dependency_type === 'blocks' && d.status !== 'closed')
  if (blockers.length > 0) {
    return `bead ${bead.id} is blocked by open ${blockers.map((d) => d.id).join(', ')} — finish or adopt those first`
  }
  const dependents = (bead.dependents ?? []).filter((d) => d.status !== 'closed')
  if (dependents.length > 0) {
    return `bead ${bead.id} has open dependents (${dependents.map((d) => d.id).join(', ')}) — an epic or ` +
      'parent bead cannot be adopted; adopt its children instead'
  }
  return null
}

function filingInput(input: TaskInput): BeadCreateInput {
  return {
    title: input.title!,
    body: readFileSync(resolve(input.bodyFile!), 'utf8'),
    acceptance: input.acceptanceFile === undefined ? undefined : readFileSync(resolve(input.acceptanceFile), 'utf8'),
    labels: [],
  }
}

async function registerTask(
  ctx: Ctx, input: TaskInput, attempt: RegistrationAttempt,
): Promise<CmdResult> {
  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: REGISTRABLE, taskId: null, reach: 'unfinished',
  }
  const found = await resolveFor(ctx, query, null)
  if (!found.ok) return found.result
  const run = found.value

  // Work with no bead behind it used to fall outside the pipeline and be
  // hand-rolled, which is where the mistakes were. Filing one here keeps the
  // brief captured at registration as the worker's one source. Measured on a live run.
  const filing = input.title !== undefined
  const adopting = input.bead !== undefined

  // The argv parser leaves a missing --branch as "". Without these checks a
  // mistyped command mints a ghost task into a live run, and there is no command
  // that removes one. Measured on a live run.
  if (filing && adopting) {
    return fail('--bead adopts an existing bead and --title files a new one — pass one, not both')
  }
  if (!filing && !adopting) {
    return fail('a task needs a bead: --bead <id> adopts an existing one, ' +
      '--title <title> --body-file <path> files a new one')
  }
  if (adopting && input.bead!.trim().length === 0) return fail('--bead needs a bead id')
  if (filing) {
    if (input.title!.trim().length === 0) return fail('--title cannot be empty')
    // --title is free text, so the argv layer lets a missing value swallow the
    // next flag — and the bead it files would carry that flag's name.
    if (input.title!.startsWith('--')) {
      return fail(`--title got a flag where the title belongs: "${input.title}" — the value after --title is missing`)
    }
    if (input.bodyFile === undefined) return fail('--title needs --body-file: the body is the worker\'s brief')
    const bodyPath = resolve(input.bodyFile)
    if (!isReadableFile(bodyPath)) return fail(`--body-file is not a file: ${bodyPath}`)
    if (input.acceptanceFile !== undefined && !isReadableFile(resolve(input.acceptanceFile))) {
      return fail(`--acceptance-file is not a file: ${resolve(input.acceptanceFile)}`)
    }
  } else if (input.bodyFile !== undefined || input.acceptanceFile !== undefined) {
    return fail('--body-file and --acceptance-file only go with --title; an existing bead already has its brief')
  }
  if (input.branch.trim().length === 0) return fail('--branch is required')
  if (input.branch.startsWith('-')) return fail(`--branch cannot start with "-", got: ${input.branch}`)

  const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
  if (!existsSync(agentFile)) {
    return fail(`no agent definition at ${agentFile} — check --surface`)
  }

  // A path prefix cannot contain whitespace, and cannot look like a flag. Both are
  // argv accidents: one quoted space-separated list in a single --files, or a
  // --files with no value swallowing the next flag. Neither is detectable later —
  // filesOverlap simply never fires and the gate reports "no overlapping files in
  // flight" while two workers edit the same files. Measured on a live run.
  for (const entry of input.files) {
    if (/\s/.test(entry)) {
      return fail(
        `--files is comma-separated; this entry contains whitespace: "${entry}"\n` +
        `  → --files ${entry.trim().split(/\s+/).join(',')}`,
      )
    }
    if (entry.startsWith('--')) {
      return fail(
        `--files got a flag where a path prefix belongs: "${entry}" — ` +
        'the value after --files is missing',
      )
    }
  }

  const taskId = `t${run.tasks.length + 1}`

  // detectCycle skips ids it does not recognise, so a typo would otherwise pass
  // validation here and then wait in `queued` forever with no diagnostic. The
  // new task's own id counts as known — depending on yourself is a cycle, not
  // a typo, and must fall through to the cycle check below to be reported as one.
  const known = new Set([...run.tasks.map((t) => t.task_id), taskId])
  const unknown = input.dependsOn.filter((id) => !known.has(id))
  if (unknown.length > 0) return fail(`--depends-on names no such task: ${unknown.join(', ')}`)

  const cycle = detectCycle([...run.tasks, { task_id: taskId, depends_on: input.dependsOn }])
  if (cycle) return fail(`--depends-on forms a cycle: ${cycle.join(' → ')}`)

  // Before filing or reading, so a typo'd --tier files nothing and costs no bd round-trip.
  const flagRefused = input.tier !== undefined && !isTier(input.tier)
  let adopted: BeadDetail | null = null
  if (adopting && !flagRefused) {
    const id = input.bead!.trim()
    const shown = await attempt.showBeadOnce(run.repo_key, id)
    if (isBdFailure(shown)) return fail(`bd show ${id} failed; nothing was registered:\n  ${shown.error}`)
    const refusal = await adoptionRefusal(ctx.stateDir, shown)
    if (refusal !== null) return fail(refusal)
    adopted = shown
  }
  const chosen = registrationTier(input.tier, adopted?.labels ?? null)
  if (!chosen.ok) return fail(chosen.error)

  // Last, after every check: a bead filed for a registration that then fails
  // sits in the backlog with nothing in the pipeline behind it.
  let bead: string
  let brief: BeadBrief
  let filed = false
  if (adopted !== null) {
    bead = adopted.id
    brief = {
      title: adopted.title, description: adopted.description ?? '', acceptance: adopted.acceptance_criteria ?? '',
      labels: adopted.labels ?? [], captured_at_ms: Date.now(),
    }
  } else {
    const createInput = filingInput(input)
    const created = await attempt.fileBeadOnce(run.repo_key, createInput)
    if (isBdFailure(created)) {
      return fail(`bd create failed; nothing was filed or registered:\n  ${created.error}`)
    }
    bead = created.id
    filed = true
    brief = {
      title: createInput.title, description: createInput.body, acceptance: createInput.acceptance ?? '',
      labels: createInput.labels, captured_at_ms: Date.now(),
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const stem = `${date}-${bead}`

  const task: Task = {
    task_id: taskId,
    branch: input.branch, bead, brief, surface: input.surface,
    depends_on: input.dependsOn, files: input.files,
    keep_worktree: input.keepWorktree,
    workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'queued', phase_entered_at: Date.now(),
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: null, registered_at: Date.now(), adopted_at: null,
    artifacts: {
      research: join(ARTIFACT_ROOT, 'research', `${stem}-research.md`),
      spec: join(ARTIFACT_ROOT, 'specs', `${stem}-design.md`),
      plan: join(ARTIFACT_ROOT, 'plans', `${stem}-plan.md`),
      verdicts: {},
    },
    merged_at_ms: null, merge_commit: null, bead_closed_at_ms: null,
    bead_sync: { failures: 0, last_error: null, last_ok_at_ms: null },
    discoveries: [], passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: input.notes,
    tier: chosen.tier,
    tier_history: [{
      at: Date.now(), from: null, to: chosen.tier, source: chosen.source,
      pane: input.callerPane ?? null, why: chosen.why,
    }],
  }

  run.tasks.push(task)
  // execute completes only once intake is closed and every task is terminal, so a
  // task registered mid-run must reopen the gate or the run could complete underneath it.
  run.intake_closed = false

  // The CLI is handing the prompt over now, so the task is dispatched. Leaving it
  // `queued` would make the next tick deliver the same prompt a second time. One
  // save for registration and dispatch together: a stale second save would make
  // the retry register the task twice.
  const gate = gateStatus(task, run.tasks)
  if (gate.state === 'ready') {
    enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
  }
  await saveRun(ctx.stateDir, run)
  attempt.landed(task.task_id)

  // The recorded set, printed back. A malformed --files is otherwise invisible:
  // the only other place task.files reaches a human is the blocked-on-files
  // warning in status.ts, which speaks only once overlap has already fired — so a
  // declaration that matches nothing is silent by construction.
  const filesLine = `files: ${task.files.length > 0 ? task.files.join(', ') : 'none'}`

  // The same line the supervisor's dispatch prompt prints, on the path that
  // actually dispatches: 17 of the last 20 tasks left `queued` here, not in the
  // supervisor's tick. Measured on the live ledger.
  const bootstrap = repoBootstrap(run.repo_root)
  const bootLine = bootstrapLine(bootstrap)

  const header = [
    `task_id: ${task.task_id}`, `tier: ${chosen.tier} (${chosen.why})`,
    ...(filed ? [`bead: ${bead} (filed)`] : []), filesLine, bootLine,
  ].join('\n')

  if (gate.state !== 'ready') return ok(`${header}\nqueued: waiting on ${gate.on.join(', ')}`)

  // After the save, not before: nothing here is recorded, and a fetch between
  // the read and the save only widens the window a concurrent write can take.
  const base = await attempt.dispatchBase(run.repo_root, dependencyMerges(task, run.tasks))
  const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  const sequence = dispatchSequence(run, task, base, bootstrap, hpipeCommand(ctx.pluginRoot))
  return ok(`${header}\n${baseLine(base)}\n${sequence}\n\n${prompt}`)
}

export async function cmdTask(
  ctx: Ctx, input: TaskInput, beads: RegistrationBeads = cliRegistrationBeads(ctx.stateDir),
  dispatchBase: DispatchBaseFor = freshDispatchBase,
): Promise<CmdResult> {
  // The retry re-runs registerTask from a fresh read, so the bd calls are memoised
  // out here: a second attempt reuses the bead the first one filed and the bead it
  // read, and never files another.
  const outcome: {
    filing: Promise<CreatedBead | BdFailure> | null
    shown: Promise<BeadDetail | BdFailure> | null
    registeredAs: string | null
  } = { filing: null, shown: null, registeredAs: null }
  const attempt: RegistrationAttempt = {
    fileBeadOnce: (repoKey, createInput) => (outcome.filing ??= beads.create(repoKey, createInput)),
    showBeadOnce: (repoKey, id) => (outcome.shown ??= beads.show(repoKey, id)),
    landed: (taskId) => { outcome.registeredAs = taskId },
    dispatchBase,
  }
  const filedBead = async (): Promise<CreatedBead | null> => {
    const filed = outcome.filing === null ? null : await outcome.filing
    return filed === null || isBdFailure(filed) ? null : filed
  }

  let reason: string
  try {
    const result = await retryOnStaleRun(() => registerTask(ctx, input, attempt))
    if (result.ok) return result
    reason = result.text
  } catch (error) {
    const filed = await filedBead()
    if (filed === null) {
      if (isUnlandedSave(error)) return fail(unlandedSaveMessage(error))
      throw error
    }
    // Not unlandedSaveMessage: its "run it again" would file a second bead.
    reason = error instanceof Error ? error.message : String(error)
  }

  const filed = await filedBead()
  if (filed === null) return fail(reason)
  if (outcome.registeredAs !== null) {
    return fail(
      `task ${outcome.registeredAs} is registered with bead ${filed.id}, but: ${reason}\n` +
      `  → hpipe brief --task ${outcome.registeredAs} prints its brief; do not register it again`,
    )
  }
  return fail(
    `${reason}\nbead ${filed.id} was filed but no task was registered\n` +
    `  → register it with --bead ${filed.id} in place of --title and --body-file; ` +
    're-running with --title files a second bead',
  )
}
```

In `rewind`, change line 760 from:

```ts
      task.issue_closed_at_entry = false
```

to:

```ts
      task.bead_closed_at_ms = null
```

Change the `task` usage (lines 1028-1030) to:

```ts
  task: ['hpipe task --branch <branch> (--bead <id> | --title <title> --body-file <path> ' +
    '[--acceptance-file <path>]) --surface <surface> [--tier light|standard|heavy] ' +
    '[--depends-on <id,id>] [--files <prefix,prefix>] [--notes <text>] [--keep-worktree] [--run <run-id>]'],
```

In the argv `task` case (lines 1145-1161), change:

```ts
        issue: Number(flag(rest, 'issue') ?? '0'),
```

to:

```ts
        bead: flag(rest, 'bead') ?? undefined,
```

and after `        bodyFile: flag(rest, 'body-file') ?? undefined,` add:

```ts
        acceptanceFile: flag(rest, 'acceptance-file') ?? undefined,
```

- [ ] **Step 18: The 14 templates and `dispatch.md`**

Replace `prompts/worker-brief.md` with:

````markdown
# {{branch}} — {{bead}}

You own bead `{{bead}}` end to end, alone, in this worktree. Your task id is `{{task_id}}` in run
`{{run_id}}` — if a command ever says it cannot tell which run you mean, that id is the answer.

**This is your brief.** It was captured when the task was registered: later edits to the bead do not
reach you, and `{{hpipe}} brief --task {{task_id}}` prints it again.

{{brief}}

Never run `bd` or `bv` yourself.

Read `{{agent_file}}` before your first edit — it is the scoped guide for surface `{{surface}}`, and
the repo's root `CLAUDE.md` outranks it where they conflict. Work only on this surface, only in this
worktree, only on `{{branch}}`.

{{bootstrap_note}}

{{batch_context}}

## The loop

You are driven one phase at a time. Each phase's instructions arrive as a prompt in this pane; do
that phase, commit, push, and stop. Do not run ahead — a phase completes when its file is on the
branch, not when you feel finished.

{{phase_loop}}

Those paths are relative to this worktree, which is your cwd. Write them exactly as given, stem and
all — do not re-derive them from the conventions you see in `docs/`. The stem carries the bead id,
and every later phase cites the path by name. An artifact written anywhere else
does not satisfy this phase's contract.

Your review tier is `{{tier}}`: it decides which of those reviews run. Never lower it. If research
shows the task is bigger than its tier — another surface, a contract, a migration — raise it:
`{{hpipe}} tier --task {{task_id}} <higher> --why "<what you found>"`.

Before `implement` you may wait — a sibling task holding files you need has to land first. When
`implement` starts, the subagent that writes the code re-reads every file before it edits it, and you
re-read them too: to triage review findings, and to brief it. A sibling may have rewritten them while
you waited, and a plan written against the old text will conflict or silently undo their work.

## Decisions

When you hit a choice you should not make alone — expensive to undo, changes scope, commits another
surface to a contract, invents a pattern this repo does not already establish, or trades off
security or data integrity — surface it as the **last action of your turn**:

    {{hpipe}} decide --task {{task_id}} \
      --question "<what must be decided, and why it cannot be settled here>" \
      --recommend "<the path you would take, and the reasoning>"

`--recommend` is required and the CLI rejects a call without it. A bare question moves your thinking
onto the orchestrator and then onto the human, which is the cost this pipeline exists to remove:
decide what you would do, then ask whether to do it.

Do not surface what the brief, `CLAUDE.md`, or an existing call site already answers — read those
first. One open decision at a time; ask the more consequential one first. The answer comes back to
this pane and you resume where you stopped.

## Definition of done, in every phase

- TDD: the failing test first, run it, then the minimum code that passes it, run it again.
- Mirror the nearest existing example and name the file you modelled on. If neither this repo nor its
  gold standard establishes a pattern this work needs, surface a decision instead of inventing one.
- Conventional-commit messages. Never commit to `main`.
- Commit and push before your turn ends, every phase, unless you are ending it on a decision with
  unverified work in the tree. Your branch starts with no upstream, so the first push is
  `git push -u origin HEAD`.
- The PR body ends with the line:

      Refs {{bead}}

  There is no GitHub issue to close: the supervisor closes the bead itself once the PR merges.
````

Replace `prompts/close.md` with (Task 9 deletes it):

```markdown
# Merged — {{branch}} ({{bead}}), PR #{{pr}}

PR #{{pr}} is merged. The supervisor closes bead `{{bead}}` itself; teardown of the worktree runs
once the close is recorded. Nothing is needed from you unless `{{hpipe}} status` reports the bead
out of sync.
```

Line edits (old → new), each a whole line unless marked:

| File:line | Old | New |
|---|---|---|
| `research.md:8` | `` Answer, with evidence: which files own the behaviour issue #{{issue}} is about; what the current `` | `` Answer, with evidence: which files own the behaviour bead `{{bead}}` asks for (`{{hpipe}} brief --task {{task_id}}` prints it); what the current `` |
| `research.md:17` | `It may be short. It may not be empty, and it may not simply restate the issue.` | `It may be short. It may not be empty, and it may not simply restate the brief.` |
| `spec.md:1` | `# Write the spec — {{branch}} (#{{issue}})` | `# Write the spec — {{branch}} ({{bead}})` |
| `spec.md:3` | `Write the spec for issue #{{issue}} now. Do not ask whether to proceed.` | ``Write the spec for bead `{{bead}}` now. Do not ask whether to proceed.`` |
| `spec.md:21` | ``issue under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept, and record in`` | ``bead under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept, and record in`` |
| `spec-review.md:1` | `# Adversarial review of your spec — {{branch}} (#{{issue}}), pass {{pass}}` | `# Adversarial review of your spec — {{branch}} ({{bead}}), pass {{pass}}` |
| `spec-review.md:23` | ``Review `{{spec_path}}` adversarially against issue #{{issue}} (`gh issue view {{issue}}`) and the`` | ``Review `{{spec_path}}` adversarially against the brief for `{{bead}}` (`{{hpipe}} brief --task {{task_id}}`) and the`` |
| `plan.md:1` | `# Write the implementation plan — {{branch}} (#{{issue}})` | `# Write the implementation plan — {{branch}} ({{bead}})` |
| `plan.md:31` | ``issue under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept before`` | ``bead under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept before`` |
| `plan-review.md:1` | `# Adversarial review of your plan — {{branch}} (#{{issue}}), pass {{pass}}` | `# Adversarial review of your plan — {{branch}} ({{bead}}), pass {{pass}}` |
| `implement.md:1` | `# Implement — {{branch}} (#{{issue}})` | `# Implement — {{branch}} ({{bead}})` |
| `implement.md:8` | ``for this issue under `docs/superpowers/reviews/`. Decide which findings you accept. Every BLOCKER`` (3-space indent kept) | ``for this bead under `docs/superpowers/reviews/`. Decide which findings you accept. Every BLOCKER`` |
| `pr-review.md:1` | ``# `pr-review` — PR #{{pr}}, {{branch}} (#{{issue}}), pass {{pass}}`` | ``# `pr-review` — PR #{{pr}}, {{branch}} ({{bead}}), pass {{pass}}`` |
| `pr-review.md:28` | ``Review PR #{{pr}} on `{{branch}}` (`gh pr diff {{pr}}`) against issue #{{issue}}`` | ``Review PR #{{pr}} on `{{branch}}` (`gh pr diff {{pr}}`) against the brief for `{{bead}}` `` |
| `pr-review.md:29` | ``(`gh issue view {{issue}}`) and the spec the PR itself carries at `{{spec_path}}`. The review has two`` | ``(`{{hpipe}} brief --task {{task_id}}`) and the spec the PR itself carries at `{{spec_path}}`. The review has two`` |
| `pr-review.md:34` | `Check: every acceptance criterion in the issue met; every spec requirement implemented, not just the` | `Check: every acceptance criterion in the brief met; every spec requirement implemented, not just the` |
| `pr-review-intent.md:1` | ``# `pr-review-intent` — stage 1 on PR #{{pr}}, {{branch}} (#{{issue}}), pass {{pass}}`` | ``# `pr-review-intent` — stage 1 on PR #{{pr}}, {{branch}} ({{bead}}), pass {{pass}}`` |
| `pr-review-intent.md:28` | ``#{{issue}} (`gh issue view {{issue}}`) and the spec the PR itself carries at `{{spec_path}}`.`` | `` `{{bead}}`'s brief (`{{hpipe}} brief --task {{task_id}}`) and the spec the PR itself carries at `{{spec_path}}`. `` |
| `pr-review-intent.md:30` | `Check: every acceptance criterion in the issue met; every spec requirement implemented, not just the` | `Check: every acceptance criterion in the brief met; every spec requirement implemented, not just the` |
| `pr-review-quality.md:1` | ``# `pr-review-quality` — stage 2 on PR #{{pr}}, {{branch}} (#{{issue}}), pass {{pass}}`` | ``# `pr-review-quality` — stage 2 on PR #{{pr}}, {{branch}} ({{bead}}), pass {{pass}}`` |
| `ci-red.md:1` | `# CI is red — {{branch}} (#{{issue}}), PR #{{pr}}` | `# CI is red — {{branch}} ({{bead}}), PR #{{pr}}` |
| `merge.md:1` | `# Ready to merge — {{branch}} (#{{issue}}), PR #{{pr}}` | `# Ready to merge — {{branch}} ({{bead}}), PR #{{pr}}` |
| `decision.md:1` | ``# Decision from {{task_id}} — {{branch}} (#{{issue}}), asked in `{{phase}}` `` | ``# Decision from {{task_id}} — {{branch}} ({{bead}}), asked in `{{phase}}` `` |
| `decision.md:15` | ``Read before you escalate: issue #{{issue}}, the repo's `CLAUDE.md`, the surface's agent file, and an`` | ``Read before you escalate: the brief (`{{hpipe}} brief --task {{task_id}}`), the repo's `CLAUDE.md`, the surface's agent file, and an`` |
| `dispatch.md:44` | ``worker there, reading `gh issue view` against a different repo's issues. Measured on a live run.`` | `worker there, reading a different repo. Measured on a live run.` |

`pr-review-intent.md:27` keeps its first half; the line becomes
``Review PR #{{pr}} on `{{branch}}` (`gh pr diff {{pr}}`) for **intent** against two documents:``
(only the trailing `issue` is moved to line 28 as shown).

`implement.md:21-27` (from `4. **Verify and ship.**` through the `"Implements #{{issue}}"` line) becomes:

```markdown
4. **Verify and ship.** Run the tests and the typecheck yourself and read their output. If either is
   red, dispatch a fresh subagent with the failing output; do not fix it yourself. When both are
   green, push, and open the PR. Its body ends with the line:

       Refs {{bead}}

   There is no GitHub issue to close: the supervisor closes the bead itself once the PR merges.
```

Then check nothing still renders the old token:

Run: `grep -rn "{{issue}}\|gh issue view" prompts/`
Expected: no output.

- [ ] **Step 19: Run the suite and the typecheck**

Run: `bun test && bun run typecheck`
Expected: all green. If a test still fails, it is one whose expected text quotes a changed string
(`#1` → `hp-1`, `issue` → `bead`); change the expectation to the new rendering — never the source.

- [ ] **Step 20: Commit**

```bash
git add -A src prompts test
git commit -m "feat!: schema v3 — tasks carry a bead and its captured brief instead of a GitHub issue

hpipe task takes --bead <id> or --title/--body-file/--acceptance-file, filed or read
through Bd; every template renders {{bead}} and {{brief}}; the close row advances on
bead_closed_at_ms; the gh issue calls are gone. v2 runs are no longer advanced.

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 6: `src/lib/bead-desired.ts` — the state every bead should be in

**Files:**
- Modify: `src/lib/decisions.ts` (add `escalatedUnanswered`)
- Create: `src/lib/bead-desired.ts`
- Test: `test/bead-desired.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/bead-desired.test.ts`:

```ts
import { expect, test } from 'bun:test'
import {
  AWAITING_HUMAN_LABEL, beadOutOfSync, commentMarker, desiredBead, isManagedLabel,
} from '../src/lib/bead-desired'
import { escalatedUnanswered, openDecision } from '../src/lib/decisions'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'implement', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: 7, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, merge_commit: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function runWith(...tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

const RUN_LABEL = 'hpipe:run=r1'

test('a merged task wants its bead closed by hpipe, carrying only the run label', () => {
  for (const phase of ['close', 'teardown', 'done', 'orphaned'] as const) {
    const task = mkTask({ phase, merged_at_ms: 5 })
    expect(desiredBead(task, runWith(task)), phase).toEqual({
      bead: 'hp-1', status: 'closed', assignee: 'hpipe', labels: [RUN_LABEL], blockedBy: [], comments: [],
    })
  }
})

test('a task in a terminal-bad phase releases its bead, its phase label saying why', () => {
  for (const phase of ['failed', 'blocked-on-failure'] as const) {
    const task = mkTask({ phase })
    expect(desiredBead(task, runWith(task)), phase)
      .toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, `phase:${phase}`] })
  }
})

test('a task rewound to done without a merge holds nothing, so its bead is released', () => {
  const task = mkTask({ phase: 'done' })
  expect(desiredBead(task, runWith(task))).toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:done'] })
})

test('an aborted run releases every unmerged bead as phase:aborted, and a resume re-claims it', () => {
  const task = mkTask({ phase: 'implement' })
  const run = runWith(task)
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  expect(desiredBead(task, run)).toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:aborted'] })

  run.history.push({ at: 2, from: 'done', to: 'execute', why: 'resumed' })
  run.phase = 'execute'
  run.escalated_from = null
  expect(desiredBead(task, run)).toMatchObject({ status: 'in_progress', assignee: 'hpipe', labels: [RUN_LABEL, 'phase:implement'] })
})

test('a run that ended on its own releases an unfinished task under that task\'s phase', () => {
  const task = mkTask({ phase: 'failed' })
  const run = runWith(task)
  run.phase = 'done'
  expect(desiredBead(task, run)).toMatchObject({ status: 'open', labels: [RUN_LABEL, 'phase:failed'] })
})

test('an escalated task keeps its claim: the human may resume it', () => {
  const task = mkTask({ phase: 'escalated', escalated_from: 'plan' })
  expect(desiredBead(task, runWith(task))).toMatchObject({ status: 'in_progress', assignee: 'hpipe' })
})

test('a registered task its worker has not been briefed on stays open and unassigned', () => {
  const queued = mkTask({ phase: 'queued' })
  expect(desiredBead(queued, runWith(queued)))
    .toMatchObject({ status: 'open', assignee: null, labels: [RUN_LABEL, 'phase:queued'] })
  const unbriefed = mkTask({ phase: 'research', awaiting_brief: true })
  expect(desiredBead(unbriefed, runWith(unbriefed))).toMatchObject({ status: 'open', assignee: null })
  const briefed = mkTask({ phase: 'research' })
  expect(desiredBead(briefed, runWith(briefed))).toMatchObject({ status: 'in_progress', assignee: 'hpipe' })
})

test('an escalated, unanswered decision blocks the bead, marks it for the human and wants its question posted', () => {
  const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
  const decision = openDecision(task, { question: 'Which store?', recommendation: 'sqlite' })
  decision.escalated_at = 10
  decision.orchestrator_recommendation = 'sqlite, for the tests'

  expect(escalatedUnanswered(task)?.id).toBe('d1')
  const desired = desiredBead(task, runWith(task))
  expect(desired).toMatchObject({
    status: 'blocked', assignee: 'hpipe', labels: [RUN_LABEL, 'phase:blocked-on-decision', AWAITING_HUMAN_LABEL],
  })
  expect(desired.comments.map((c) => c.marker)).toEqual(['[hpipe t1/d1/asked]'])
  const text = desired.comments[0]!.text
  expect(text).toContain('Which store?')
  expect(text).toContain('sqlite')
  expect(text).toContain('sqlite, for the tests')
  expect(text.endsWith('[hpipe t1/d1/asked]')).toBe(true)
})

test('a decision not yet put to the human leaves the bead in progress and posts nothing', () => {
  const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
  openDecision(task, { question: 'q', recommendation: 'r' })
  expect(escalatedUnanswered(task)).toBeNull()
  expect(desiredBead(task, runWith(task))).toMatchObject({ status: 'in_progress', comments: [] })
})

test('any answer ends the block and wants the ruling posted, while the question stays posted', () => {
  for (const by of ['orchestrator', 'human'] as const) {
    const task = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
    const decision = openDecision(task, { question: 'q', recommendation: 'r' })
    decision.escalated_at = 10
    Object.assign(decision, { answer: 'use sqlite', answered_by: by, answered_at: 11 })

    const desired = desiredBead(task, runWith(task))
    expect(desired.status, by).toBe('in_progress')
    expect(desired.comments.map((c) => c.marker)).toEqual(['[hpipe t1/d1/asked]', '[hpipe t1/d1/ruling]'])
    expect(desired.comments[1]!.text).toContain('use sqlite')
    expect(desired.comments[1]!.text).toContain(`by the ${by}`)
  }
})

test('an abandoned decision posts no ruling, and a rewind out of the decision un-blocks the bead', () => {
  const task = mkTask({ phase: 'plan', decision_from: null })
  const decision = openDecision(task, { question: 'q', recommendation: 'r' })
  decision.escalated_at = 10
  expect(desiredBead(task, runWith(task)).status).toBe('in_progress')

  Object.assign(decision, { answered_by: 'abandoned', answered_at: 12 })
  expect(desiredBead(task, runWith(task)).comments.map((c) => c.marker)).toEqual(['[hpipe t1/d1/asked]'])
})

test('each depends_on task becomes a blocks edge to its bead, on every row', () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  expect(desiredBead(second, runWith(first, second)).blockedBy).toEqual(['hp-1'])
  expect(desiredBead(first, runWith(first, second)).blockedBy).toEqual([])
})

test('only the hpipe: and phase: namespaces are hpipe\'s to remove', () => {
  for (const label of ['phase:plan', 'hpipe:run=r9', AWAITING_HUMAN_LABEL, 'hpipe:discovered']) {
    expect(isManagedLabel(label), label).toBe(true)
  }
  for (const label of ['pipeline:tier-light', 'ui', 'phased']) expect(isManagedLabel(label), label).toBe(false)
})

test('the comment marker is spelled the one way the reconciler looks for', () => {
  expect(commentMarker('t3', 'd2', 'ruling')).toBe('[hpipe t3/d2/ruling]')
})

test('a bead is out of sync at five failed calls with an error still standing', () => {
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 5, last_error: 'locked', last_ok_at_ms: null } }))).toBe(true)
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 4, last_error: 'locked', last_ok_at_ms: null } }))).toBe(false)
  expect(beadOutOfSync(mkTask({ bead_sync: { failures: 9, last_error: null, last_ok_at_ms: 3 } }))).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/bead-desired.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/bead-desired'`.

- [ ] **Step 3: Add `escalatedUnanswered` to `src/lib/decisions.ts`**

Append to `src/lib/decisions.ts`:

```ts
/**
 * The question the human currently owns. A rewind out of `blocked-on-decision`
 * ends it as surely as an answer does, so the phase is part of the test.
 */
export function escalatedUnanswered(task: Task): Decision | null {
  if (task.phase !== 'blocked-on-decision') return null
  const open = openDecisionFor(task)
  return open !== null && open.escalated_at !== null ? open : null
}
```

- [ ] **Step 4: Write `bead-desired.ts`**

Create `src/lib/bead-desired.ts`:

```ts
import { BD_ACTOR } from './bd'
import { escalatedUnanswered } from './decisions'
import { TERMINAL_BAD } from './gating'
import { holdsBead } from './held'
import { wasAborted } from './ledger'
import type { Run, Task } from './types'

export const RUN_LABEL_PREFIX = 'hpipe:run='
export const PHASE_LABEL_PREFIX = 'phase:'
export const AWAITING_HUMAN_LABEL = 'hpipe:awaiting-human'
export const DISCOVERED_LABEL = 'hpipe:discovered'
const MANAGED_LABEL_PREFIXES: readonly string[] = ['hpipe:', PHASE_LABEL_PREFIX]

/** `hpipe status` and the close stall both speak up from here, so the two never disagree. */
export const BEAD_SYNC_ALERT_FAILURES = 5

export type BeadStatus = 'open' | 'in_progress' | 'blocked' | 'closed'

export interface DesiredComment {
  marker: string
  text: string
}

export interface DesiredBead {
  bead: string
  status: BeadStatus
  /** Null is unassigned. */
  assignee: string | null
  labels: string[]
  blockedBy: string[]
  comments: DesiredComment[]
}

/** Labels outside these namespaces are a human's, and the reconciler never removes them. */
export const isManagedLabel = (label: string): boolean =>
  MANAGED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))

export function commentMarker(taskId: string, decisionId: string, kind: 'asked' | 'ruling'): string {
  return `[hpipe ${taskId}/${decisionId}/${kind}]`
}

export function beadOutOfSync(task: Task): boolean {
  return task.bead_sync.failures >= BEAD_SYNC_ALERT_FAILURES && task.bead_sync.last_error !== null
}

function dependencyBeads(task: Task, run: Run): string[] {
  return task.depends_on
    .map((id) => run.tasks.find((t) => t.task_id === id)?.bead)
    .filter((bead): bead is string => bead !== undefined)
}

/** One per escalated question and one per ruling, each ending in the marker that makes posting it idempotent. */
function decisionComments(task: Task): DesiredComment[] {
  return task.decisions.flatMap((decision) => {
    const comments: DesiredComment[] = []
    if (decision.escalated_at !== null) {
      const marker = commentMarker(task.task_id, decision.id, 'asked')
      comments.push({
        marker,
        text: [
          `Question for the human (${task.task_id}, asked in ${decision.from_phase}):`, '', decision.question, '',
          'The worker recommends:', '', decision.recommendation, '',
          'The orchestrator recommends:', '', decision.orchestrator_recommendation ?? '(none given)', '',
          marker,
        ].join('\n'),
      })
    }
    const ruled = decision.answered_by === 'orchestrator' || decision.answered_by === 'human'
    if (ruled && decision.answer !== null) {
      const marker = commentMarker(task.task_id, decision.id, 'ruling')
      comments.push({
        marker,
        text: [`Ruling by the ${decision.answered_by} on ${task.task_id}/${decision.id}:`, '', decision.answer, '', marker].join('\n'),
      })
    }
    return comments
  })
}

/**
 * The first matching row of spec §5's table. The release row reads the held
 * predicate itself, so adoption, `hpipe next` and the release can never
 * disagree about whether a task still holds its bead.
 */
export function desiredBead(task: Task, run: Run): DesiredBead {
  const runLabel = `${RUN_LABEL_PREFIX}${run.run_id}`
  const phaseLabel = `${PHASE_LABEL_PREFIX}${task.phase}`
  const shared = { bead: task.bead, blockedBy: dependencyBeads(task, run), comments: decisionComments(task) }

  if (task.merged_at_ms !== null) {
    return { ...shared, status: 'closed', assignee: BD_ACTOR, labels: [runLabel] }
  }
  if (!holdsBead(run, task)) {
    const why = wasAborted(run) && !TERMINAL_BAD.has(task.phase) ? `${PHASE_LABEL_PREFIX}aborted` : phaseLabel
    return { ...shared, status: 'open', assignee: null, labels: [runLabel, why] }
  }
  if (escalatedUnanswered(task) !== null) {
    return { ...shared, status: 'blocked', assignee: BD_ACTOR, labels: [runLabel, phaseLabel, AWAITING_HUMAN_LABEL] }
  }
  if (task.phase !== 'queued' && task.awaiting_brief !== true) {
    return { ...shared, status: 'in_progress', assignee: BD_ACTOR, labels: [runLabel, phaseLabel] }
  }
  return { ...shared, status: 'open', assignee: null, labels: [runLabel, phaseLabel] }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test test/bead-desired.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 6: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/decisions.ts src/lib/bead-desired.ts test/bead-desired.test.ts
git commit -m "feat: desiredBead, the bead state the ledger implies

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 7: Dispatch claims the bead synchronously

**Files:**
- Create: `src/lib/bead-claim.ts`, `test/bead-claim.test.ts`, `test/helpers/cmd-dispatch.ts`
- Modify: `src/cli.ts` (`cmdDispatchTask`, around the anchor `const brief = await renderWorkerPrompt(ctx.pluginRoot, run, task)`)
- Test: `test/cli-commands.test.ts:5-9` and append, `test/cli-argv.test.ts` (`BD_RESPONSES`, the dispatch test)

- [ ] **Step 1: Write the failing tests**

Create `test/bead-claim.test.ts`:

```ts
import { expect, test } from 'bun:test'
import type { BdFailure, BeadDetail, BeadUpdate } from '../src/lib/bd'
import { claimForDispatch } from '../src/lib/bead-claim'

function fakeBd(detail: Partial<BeadDetail>, failures: { show?: BdFailure; claim?: BdFailure } = {}) {
  const calls: string[] = []
  return {
    calls,
    bd: {
      show: async (id: string) => {
        calls.push(`show ${id}`)
        return failures.show ?? { id, title: 't', status: 'open', ...detail }
      },
      update: async (id: string, change: BeadUpdate) => {
        calls.push(`update ${id} ${JSON.stringify(change)}`)
        return { ok: true as const }
      },
      claim: async (id: string) => {
        calls.push(`claim ${id}`)
        return failures.claim ?? { ok: true as const }
      },
    },
  }
}

test('an open, unassigned bead is claimed straight away', async () => {
  const { bd, calls } = fakeBd({})
  expect(await claimForDispatch(bd, 'hp-1')).toEqual({ ok: true })
  expect(calls).toEqual(['show hp-1', 'claim hp-1'])
})

test('a bead left blocked, or assigned but open, is put back to open and unassigned before the claim', async () => {
  for (const left of [{ status: 'blocked', assignee: 'hpipe' }, { status: 'open', assignee: 'hpipe' }]) {
    const { bd, calls } = fakeBd(left)
    expect(await claimForDispatch(bd, 'hp-1')).toEqual({ ok: true })
    expect(calls).toEqual(['show hp-1', 'update hp-1 {"status":"open","assignee":""}', 'claim hp-1'])
  }
})

test('a bead hpipe already holds in progress is re-claimed as bd\'s own no-op', async () => {
  const { bd, calls } = fakeBd({ status: 'in_progress', assignee: 'hpipe' })
  expect(await claimForDispatch(bd, 'hp-1')).toEqual({ ok: true })
  expect(calls).toEqual(['show hp-1', 'claim hp-1'])
})

test('a failed show or a refused claim comes back as bd said it', async () => {
  const unreadable = fakeBd({}, { show: { reason: 'busy', error: 'Beads is busy, retry' } })
  expect(await claimForDispatch(unreadable.bd, 'hp-1')).toEqual({ reason: 'busy', error: 'Beads is busy, retry' })
  expect(unreadable.calls).toEqual(['show hp-1'])

  const refused = fakeBd({}, { claim: { reason: 'exit', error: 'hp-1 is already claimed by bob' } })
  expect(await claimForDispatch(refused.bd, 'hp-1')).toEqual({ reason: 'exit', error: 'hp-1 is already claimed by bob' })
})
```

Create `test/helpers/cmd-dispatch.ts`:

```ts
import { cmdDispatchTask as cmdDispatchTaskWithRealBeads, type ClaimBead } from '../../src/cli'

type DispatchArgs = Parameters<typeof cmdDispatchTaskWithRealBeads>

/**
 * Dispatch claims the task's bead through `bd` before it sends the brief; a call
 * here without a claim of its own claims nothing and succeeds.
 */
export function cmdDispatchTask(
  ctx: DispatchArgs[0], input: DispatchArgs[1], send: DispatchArgs[2], recordPane?: DispatchArgs[3],
  claim: ClaimBead = async () => ({ ok: true }),
): ReturnType<typeof cmdDispatchTaskWithRealBeads> {
  return cmdDispatchTaskWithRealBeads(ctx, input, send, recordPane, claim)
}
```

In `test/cli-commands.test.ts`, remove `cmdDispatchTask` from the `../src/cli` import list (lines
5-9) and add below the `./helpers/cmd-task` import:

```ts
import { cmdDispatchTask } from './helpers/cmd-dispatch'
```

Append to `test/cli-commands.test.ts`:

```ts
test('dispatch --task claims the task\'s bead before it sends the brief', async () => {
  await registerReadyTask()
  const order: string[] = []
  const send = async () => { order.push('send'); return { ok: true } }

  const result = await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null }, send,
    undefined, async (repoKey, bead) => { order.push(`claim ${repoKey} ${bead}`); return { ok: true } })

  expect(result.ok).toBe(true)
  expect(order).toEqual(['claim k hp-11', 'send'])
})

test('a refused claim refuses the dispatch with bd\'s message and sends nothing', async () => {
  await registerReadyTask()
  const { sent, send } = recordingSend()

  const result = await cmdDispatchTask(ctx(), { taskId: 't1', paneId: 'w1-2', repoKey: 'k', runId: null }, send,
    undefined, async () => ({ reason: 'exit', error: 'hp-11 is already claimed by bob' }))

  expect(result.ok).toBe(false)
  expect(result.text).toContain('hp-11 is already claimed by bob')
  expect(result.text).toContain('nothing was sent')
  expect(sent).toEqual([])
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.pane_id).toBeNull()
})
```

In `test/cli-argv.test.ts`, add to `BD_RESPONSES`:

```ts
  '--json --actor hpipe update': {},
```

and in `test('dispatch --task submits the brief through herdr agent prompt and waits for it'`, after
`expect(calls).toContain('--wait --until working --until blocked --timeout')` add:

```ts
  expect(bdCalls(f)).toContain('--json --actor hpipe update argv-1 --claim')
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/bead-claim.test.ts test/cli-commands.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/bead-claim'`, and `Export named 'ClaimBead' not found`.

- [ ] **Step 3: Write `claimForDispatch`**

Create `src/lib/bead-claim.ts`:

```ts
import { type Bd, type BdFailure, type Done, isBdFailure } from './bd'

type ClaimingBd = Pick<Bd, 'show' | 'update' | 'claim'>

/**
 * `--claim` only takes an `open`, unassigned bead. One an earlier life of the
 * task left `blocked`, or assigned but `open`, is put back first, so the claim's
 * answer is about now rather than about that history.
 */
export async function claimForDispatch(bd: ClaimingBd, bead: string): Promise<Done | BdFailure> {
  const current = await bd.show(bead)
  if (isBdFailure(current)) return current
  const assigned = (current.assignee ?? '') !== ''
  if (current.status === 'blocked' || (current.status === 'open' && assigned)) {
    const reset = await bd.update(bead, { status: 'open', assignee: '' })
    if (isBdFailure(reset)) return reset
  }
  return bd.claim(bead)
}
```

- [ ] **Step 4: Claim in `cmdDispatchTask`**

In `src/cli.ts`, add `type Done` to the `./lib/bd` import and add:

```ts
import { claimForDispatch } from './lib/bead-claim'
```

Insert above `export type SendBrief = `:

```ts
export type ClaimBead = (repoKey: string, bead: string) => Promise<Done | BdFailure>

const cliClaimBead = (stateDir: string): ClaimBead => (repoKey, bead) =>
  withCliBd(stateDir, repoKey, (bd) => claimForDispatch(bd, bead))
```

Change the `cmdDispatchTask` signature from:

```ts
}, send: SendBrief, recordPane: typeof recordWorkerPane = recordWorkerPane): Promise<CmdResult> {
```

to:

```ts
}, send: SendBrief, recordPane: typeof recordWorkerPane = recordWorkerPane,
claim: ClaimBead = cliClaimBead(ctx.stateDir)): Promise<CmdResult> {
```

and insert immediately above `  const brief = await renderWorkerPrompt(ctx.pluginRoot, run, task)`:

```ts
  // Before the send: a brief cannot be recalled, and a bead someone else holds
  // must refuse the dispatch rather than surface later as a reconciler failure.
  const claimed = await claim(run.repo_key, task.bead)
  if (isBdFailure(claimed)) {
    return fail(`bd would not let ${task.task_id} claim ${task.bead}; nothing was sent:\n  ${claimed.error}`)
  }
```

- [ ] **Step 5: Run them to verify they pass**

Run: `bun test test/bead-claim.test.ts test/cli-commands.test.ts test/cli-argv.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/bead-claim.ts src/cli.ts test/bead-claim.test.ts test/helpers/cmd-dispatch.ts \
  test/cli-commands.test.ts test/cli-argv.test.ts
git commit -m "feat: dispatch claims the task's bead before sending the brief

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 8: The reconciler — `src/supervisor/beads-sync.ts`

**Files:**
- Create: `src/supervisor/beads-sync.ts`, `test/beads-sync.test.ts`
- Modify: `src/supervisor/main.ts` (imports; insert after the delivery-settle loop that ends at
  line 421, before `// One binding, so the cap the candidates are built with`)
- Modify: `src/lib/status.ts` (`taskWarnings`, lines 269-303)
- Test: `test/status.test.ts` append

- [ ] **Step 1: Write the failing tests**

Create `test/beads-sync.test.ts`:

```ts
import { expect, test } from 'bun:test'
import type { BdFailure, BeadUpdate, Done, ExportedBead } from '../src/lib/bd'
import { desiredBead } from '../src/lib/bead-desired'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { callsFor, closeReason, type SyncBd, type SyncDeps, syncBeads } from '../src/supervisor/beads-sync'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'implement', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: 7, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, merge_commit: 'm3rg3', ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function runWith(...tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: '/code/repo', repoRoot: '/code/repo', title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

const bead = (id: string, over: Partial<ExportedBead> = {}): ExportedBead =>
  ({ id, title: id, status: 'open', labels: [], dependencies: [], comments: [], ...over })

/** An in-memory store whose export is always current, recording each call it is asked to make. */
function fakeStore(beads: ExportedBead[], fail: (id: string, kind: string) => BdFailure | null = () => null) {
  const byId = new Map(beads.map((b) => [b.id, structuredClone(b)]))
  const calls: string[] = []
  let exports = 0
  let onCall = (): void => {}
  const answer = (id: string, call: string, apply: (b: ExportedBead) => void): Promise<Done | BdFailure> => {
    calls.push(call)
    onCall()
    const failure = fail(id, call.split(' ')[0]!)
    if (failure !== null) return Promise.resolve(failure)
    const target = byId.get(id)
    if (target) apply(target)
    return Promise.resolve({ ok: true })
  }
  const bd: SyncBd = {
    readExport: () => [...byId.values()].map((b) => structuredClone(b)),
    reopen: (id) => answer(id, `reopen ${id}`, (b) => { b.status = 'open' }),
    update: (id, change: BeadUpdate) => answer(id, `update ${id} ${JSON.stringify(change)}`, (b) => {
      if (change.status !== undefined) b.status = change.status
      if (change.assignee !== undefined) b.assignee = change.assignee
      b.labels = [...(b.labels ?? []).filter((l) => !(change.removeLabels ?? []).includes(l)), ...(change.addLabels ?? [])]
    }),
    depAdd: (from, to) => answer(from, `depAdd ${from} ${to}`, (b) => {
      b.dependencies = [...(b.dependencies ?? []), { depends_on_id: to, type: 'blocks' }]
    }),
    comment: (id, text) => answer(id, `comment ${id}`, (b) => { b.comments = [...(b.comments ?? []), { text }] }),
    close: (id, reason) => answer(id, `close ${id} ${reason}`, (b) => { b.status = 'closed' }),
    exportNow: async () => { exports++; return { ok: true } },
  }
  return { bd, calls, exports: () => exports, onEachCall: (hook: () => void) => { onCall = hook } }
}

function deps(store: ReturnType<typeof fakeStore>, over: Partial<SyncDeps> = {}): SyncDeps & { persisted: Run[] } {
  const persisted: Run[] = []
  return {
    persisted,
    bdFor: () => store.bd,
    hasStore: async () => true,
    now: () => 1_000,
    budgetMs: 2_000,
    persist: async (run) => { persisted.push(structuredClone(run)) },
    log: () => {},
    ...over,
  }
}

test('a dispatched task\'s open bead gets one update folding status, assignee and labels; foreign labels stay', () => {
  const task = mkTask({ phase: 'implement' })
  const actual = bead('hp-1', { labels: ['hpipe:run=r1', 'phase:research', 'ui'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([{
    kind: 'update',
    change: { status: 'in_progress', assignee: 'hpipe', addLabels: ['phase:implement'], removeLabels: ['phase:research'] },
  }])
})

test('a bead already as desired needs no call', () => {
  const task = mkTask({ phase: 'implement' })
  const actual = bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([])
})

test('a closed bead the ledger wants open again is reopened before its update', () => {
  const task = mkTask({ phase: 'implement' })
  const actual = bead('hp-1', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([
    { kind: 'reopen' },
    { kind: 'update', change: { status: 'in_progress', addLabels: ['phase:implement'] } },
  ])
})

test('a merged task\'s bead is relabelled, then closed last with the merge as its reason', () => {
  const task = mkTask({ phase: 'close', merged_at_ms: 5 })
  const actual = bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:merge'] })
  expect(callsFor(desiredBead(task, runWith(task)), actual, closeReason(task))).toEqual([
    { kind: 'update', change: { removeLabels: ['phase:merge'] } },
    { kind: 'close', reason: 'merged in PR #7 (m3rg3)' },
  ])
})

test('missing edges and comments come after the update and before the close', () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'blocked-on-decision', decision_from: 'plan', depends_on: ['t1'] })
  second.decisions = [{
    id: 'd1', asked_at: 0, from_phase: 'plan', question: 'q', recommendation: 'r',
    answer: null, answered_by: null, answered_at: null, prompted_at: 1, escalated_at: 2, orchestrator_recommendation: 'o',
  }]
  const calls = callsFor(desiredBead(second, runWith(first, second)), bead('hp-2'), closeReason(second))
  expect(calls.map((c) => c.kind)).toEqual(['update', 'depAdd', 'comment'])
  expect(calls[1]).toEqual({ kind: 'depAdd', dependsOn: 'hp-1' })
  expect(calls[2]).toMatchObject({ kind: 'comment', marker: '[hpipe t2/d1/asked]' })
})

test('a closed bead that should stay closed is left alone, whoever it is assigned to', () => {
  const task = mkTask({ phase: 'done', merged_at_ms: 5 })
  expect(callsFor(desiredBead(task, runWith(task)), bead('hp-1', { status: 'closed', labels: ['hpipe:run=r1'] }), closeReason(task)))
    .toEqual([])
})

test('a pass converges every task and exports once', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const store = fakeStore([bead('hp-1', { labels: ['phase:research'] }), bead('hp-2')])

  await syncBeads([runWith(first, second)], deps(store))

  expect(store.calls).toEqual([
    'update hp-1 {"status":"in_progress","assignee":"hpipe","addLabels":["hpipe:run=r1","phase:implement"],"removeLabels":["phase:research"]}',
    'update hp-2 {"addLabels":["hpipe:run=r1","phase:queued"]}',
    'depAdd hp-2 hp-1',
  ])
  expect(store.exports()).toBe(1)
})

test('a pass with nothing to change neither writes, exports nor saves', async () => {
  const task = mkTask({ phase: 'queued' })
  const store = fakeStore([bead('hp-1', { labels: ['hpipe:run=r1', 'phase:queued'] })])
  const d = deps(store)
  await syncBeads([runWith(task)], d)
  expect(store.calls).toEqual([])
  expect(store.exports()).toBe(0)
  expect(d.persisted).toEqual([])
})

test('a failed call is counted on its task, monotonically, and the next task still converges', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const run = runWith(first, second)
  const store = fakeStore([bead('hp-1'), bead('hp-2')],
    (id) => (id === 'hp-1' ? { reason: 'exit', error: 'Error: database is locked' } : null))
  const d = deps(store)

  await syncBeads([run], d)
  await syncBeads([run], d)

  expect(first.bead_sync).toEqual({ failures: 2, last_error: 'Error: database is locked', last_ok_at_ms: null })
  expect(second.bead_sync).toEqual({ failures: 0, last_error: null, last_ok_at_ms: 1_000 })
  expect(d.persisted.at(-1)?.tasks[0]?.bead_sync.failures).toBe(2)
})

test('a held lock ends the pass at once and counts as no failure', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const store = fakeStore([bead('hp-1'), bead('hp-2')], () => ({ reason: 'busy', error: 'Beads is busy, retry' }))

  await syncBeads([runWith(first, second)], deps(store))

  expect(store.calls).toHaveLength(1)
  expect(first.bead_sync.failures).toBe(0)
  expect(store.exports()).toBe(0)
})

test('the 2 s budget stops a pass part-way, and the next pass does only what is left', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'implement' })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const run = runWith(first, second)
  const store = fakeStore([bead('hp-1'), bead('hp-2')])
  let clock = 0
  store.onEachCall(() => { clock += 1_500 })
  const d = deps(store, { now: () => clock })

  await syncBeads([run], d)
  expect(store.calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['update hp-1', 'update hp-2'])
  expect(store.exports()).toBe(1)

  await syncBeads([run], d)
  expect(store.calls.slice(2)).toEqual(['depAdd hp-2 hp-1'])
})

test('a pass that crashed part-way converges on the next one', async () => {
  const first = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'done', merged_at_ms: 1 })
  const second = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'queued', depends_on: ['t1'] })
  const run = runWith(first, second)
  let failNextDep = true
  const store = fakeStore([bead('hp-1', { status: 'closed', labels: ['hpipe:run=r1'] }), bead('hp-2')], (_id, kind) => {
    if (kind !== 'depAdd' || !failNextDep) return null
    failNextDep = false
    return { reason: 'timeout', error: 'bd dep was killed after 30s' }
  })
  const d = deps(store)

  await syncBeads([run], d)
  await syncBeads([run], d)

  expect(store.calls).toEqual([
    'update hp-2 {"addLabels":["hpipe:run=r1","phase:queued"]}', 'depAdd hp-2 hp-1', 'depAdd hp-2 hp-1',
  ])
  expect(second.bead_sync).toMatchObject({ failures: 1, last_error: null })
})

test('done and aborted runs are visited: an aborted run\'s claimed bead is released', async () => {
  const task = mkTask({ phase: 'implement' })
  const run = runWith(task)
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  const store = fakeStore([bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] })])

  await syncBeads([run], deps(store))

  expect(store.calls).toEqual([
    'update hp-1 {"status":"open","assignee":"","addLabels":["phase:aborted"],"removeLabels":["phase:implement"]}',
  ])
})

test('bead_closed_at_ms is set only once a merge is recorded and the export shows the bead closed', async () => {
  const merged = mkTask({ task_id: 't1', bead: 'hp-1', phase: 'close', merged_at_ms: 5 })
  const unmerged = mkTask({ task_id: 't2', bead: 'hp-2', phase: 'implement' })
  const run = runWith(merged, unmerged)
  const store = fakeStore([
    bead('hp-1', { status: 'in_progress', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:close'] }),
    bead('hp-2', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1', 'phase:implement'] }),
  ])
  let clock = 1_000
  const d = deps(store, { now: () => clock })

  await syncBeads([run], d)
  expect(merged.bead_closed_at_ms).toBeNull()
  expect(store.calls).toContain('close hp-1 merged in PR #7 (m3rg3)')
  expect(store.calls).toContain('reopen hp-2')

  clock = 2_000
  await syncBeads([run], d)
  expect(merged.bead_closed_at_ms).toBe(2_000)
  expect(unmerged.bead_closed_at_ms).toBeNull()
})

test('a rewind that clears the merge flips the bead back: reopened and re-claimed', async () => {
  const task = mkTask({ phase: 'implement', merged_at_ms: null, bead_closed_at_ms: null })
  const store = fakeStore([bead('hp-1', { status: 'closed', assignee: 'hpipe', labels: ['hpipe:run=r1'] })])
  await syncBeads([runWith(task)], deps(store))
  expect(store.calls).toEqual(['reopen hp-1', 'update hp-1 {"status":"in_progress","addLabels":["phase:implement"]}'])
})

test('a repo with no Beads store is skipped', async () => {
  const store = fakeStore([bead('hp-1')])
  await syncBeads([runWith(mkTask())], deps(store, { hasStore: async () => false }))
  expect(store.calls).toEqual([])
})
```

Append to `test/status.test.ts`:

```ts
test('a bead out of sync for five failed calls is flagged with bd\'s last error', () => {
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'implement', bead_sync: { failures: 5, last_error: 'Error: database is locked', last_ok_at_ms: null } })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP))
    .toContain('⚠ t1 bead hp-1 is out of sync after 5 failed Beads calls: Error: database is locked')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/beads-sync.test.ts test/status.test.ts`
Expected: FAIL — `Cannot find module '../src/supervisor/beads-sync'`; the status line is missing.

- [ ] **Step 3: Write the reconciler**

Create `src/supervisor/beads-sync.ts`:

```ts
import { type Bd, type BdFailure, type BeadUpdate, type Done, type ExportedBead, isBdFailure } from '../lib/bd'
import { type DesiredBead, desiredBead, isManagedLabel } from '../lib/bead-desired'
import { beadsSlug } from '../lib/beads-project'
import type { RunEffect } from '../lib/ledger'
import type { Run, Task } from '../lib/types'

export const SYNC_BUDGET_MS = 2_000

export type BeadCall =
  | { kind: 'reopen' }
  | { kind: 'update'; change: BeadUpdate }
  | { kind: 'depAdd'; dependsOn: string }
  | { kind: 'comment'; marker: string; text: string }
  | { kind: 'close'; reason: string }

export type SyncBd = Pick<Bd, 'readExport' | 'reopen' | 'update' | 'depAdd' | 'comment' | 'close' | 'exportNow'>

export interface SyncDeps {
  /** A try-lock `Bd` that does not export after writes: the pass exports once at its end. */
  bdFor: (slug: string) => SyncBd
  hasStore: (slug: string) => Promise<boolean>
  now: () => number
  budgetMs: number
  persist: (run: Run, effect: RunEffect) => Promise<void>
  log: (message: string) => void
}

export function closeReason(task: Task): string {
  return `merged in PR #${task.pr ?? 'unknown'} (${task.merge_commit ?? 'unknown commit'})`
}

/**
 * The fewest calls that take `actual` to `desired`, in the only order that
 * works: reopen before anything that needs an open bead, close after everything
 * else. Each is idempotent against `desired`, so a pass cut short anywhere is
 * finished by recomputing the remainder next tick.
 */
export function callsFor(desired: DesiredBead, actual: ExportedBead, reason: string): BeadCall[] {
  const calls: BeadCall[] = []
  const wasClosed = actual.status === 'closed'
  const wantsClosed = desired.status === 'closed'
  const reopening = wasClosed && !wantsClosed
  if (reopening) calls.push({ kind: 'reopen' })

  const change: BeadUpdate = {}
  const statusNow = reopening ? 'open' : actual.status
  if (!wantsClosed && statusNow !== desired.status) change.status = desired.status
  const assignee = desired.assignee ?? ''
  if (!(wantsClosed && wasClosed) && (actual.assignee ?? '') !== assignee) change.assignee = assignee
  const labels = actual.labels ?? []
  const addLabels = desired.labels.filter((label) => !labels.includes(label))
  const removeLabels = labels.filter((label) => isManagedLabel(label) && !desired.labels.includes(label))
  if (addLabels.length > 0) change.addLabels = addLabels
  if (removeLabels.length > 0) change.removeLabels = removeLabels
  if (Object.keys(change).length > 0) calls.push({ kind: 'update', change })

  for (const dependsOn of desired.blockedBy) {
    const present = (actual.dependencies ?? []).some((d) => d.depends_on_id === dependsOn && d.type === 'blocks')
    if (!present) calls.push({ kind: 'depAdd', dependsOn })
  }
  for (const comment of desired.comments) {
    if (!(actual.comments ?? []).some((c) => c.text.includes(comment.marker))) calls.push({ kind: 'comment', ...comment })
  }
  if (wantsClosed && !wasClosed) calls.push({ kind: 'close', reason })
  return calls
}

function applyCall(bd: SyncBd, bead: string, call: BeadCall): Promise<Done | BdFailure> {
  switch (call.kind) {
    case 'reopen': return bd.reopen(bead)
    case 'update': return bd.update(bead, call.change)
    case 'depAdd': return bd.depAdd(bead, call.dependsOn)
    case 'comment': return bd.comment(bead, call.text)
    case 'close': return bd.close(bead, call.reason, { force: false })
  }
}

const onTask = (taskId: string, change: (task: Task) => void): RunEffect => (run) => {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task) change(task)
}

export const recordSyncFailure = (taskId: string, error: string): RunEffect => onTask(taskId, (task) => {
  task.bead_sync = { ...task.bead_sync, failures: task.bead_sync.failures + 1, last_error: error }
})

export const recordSyncOk = (taskId: string, at: number): RunEffect => onTask(taskId, (task) => {
  task.bead_sync = { ...task.bead_sync, last_error: null, last_ok_at_ms: at }
})

/** Only after a recorded merge: a bead a human closed by hand must not let an unmerged task tear down. */
export const recordBeadClosed = (taskId: string, at: number): RunEffect => onTask(taskId, (task) => {
  if (task.merged_at_ms !== null && task.bead_closed_at_ms === null) task.bead_closed_at_ms = at
})

/**
 * Converges every bead to the state its task's ledger implies. Runs after the
 * advance loop over every run file in the session, `done` and aborted ones
 * included, since their beads still need releasing. A held lock or the time
 * budget ends the pass; what is left is recomputed next tick.
 */
export async function syncBeads(runs: readonly Run[], deps: SyncDeps): Promise<void> {
  const started = deps.now()
  const overBudget = (): boolean => deps.now() - started >= deps.budgetMs
  const bySlug = new Map<string, Run[]>()
  for (const run of runs) {
    const slug = beadsSlug(run.repo_key)
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), run])
  }

  let stopped = false
  for (const [slug, slugRuns] of bySlug) {
    if (stopped) break
    if (!(await deps.hasStore(slug))) continue
    const bd = deps.bdFor(slug)
    const actual = new Map(bd.readExport().map((b) => [b.id, b]))
    let wrote = false

    for (const run of slugRuns) {
      if (stopped) break
      const effects: RunEffect[] = []
      for (const task of run.tasks) {
        const current = actual.get(task.bead)
        if (current === undefined) continue
        if (current.status === 'closed') effects.push(recordBeadClosed(task.task_id, deps.now()))

        const calls = callsFor(desiredBead(task, run), current, closeReason(task))
        if (calls.length === 0) continue
        let failure: BdFailure | null = null
        for (const call of calls) {
          if (overBudget()) {
            stopped = true
            break
          }
          const result = await applyCall(bd, task.bead, call)
          if (isBdFailure(result)) {
            failure = result
            break
          }
          wrote = true
        }
        if (failure?.reason === 'busy') stopped = true
        else if (failure !== null) {
          effects.push(recordSyncFailure(task.task_id, failure.error))
          deps.log(`beads ${slug}: ${task.task_id} (${task.bead}) did not sync: ${failure.error}`)
        } else if (!stopped) effects.push(recordSyncOk(task.task_id, deps.now()))
        if (stopped) break
      }
      if (effects.length === 0) continue
      const combined: RunEffect = (target) => { for (const apply of effects) apply(target) }
      combined(run)
      try {
        await deps.persist(run, combined)
      } catch (error) {
        deps.log(`beads ${slug}: run ${run.run_id}: sync state not saved (${error}); it is recomputed next tick`)
      }
    }

    if (wrote) {
      const exported = await bd.exportNow()
      if (isBdFailure(exported)) deps.log(`beads ${slug}: export failed (${exported.error}); the board lags until it succeeds`)
    }
  }
}
```

- [ ] **Step 4: Flag an out-of-sync bead in `hpipe status`**

In `src/lib/status.ts`, add the import:

```ts
import { beadOutOfSync } from './bead-desired'
```

and in `taskWarnings`, immediately after `for (const task of run.tasks) {` (line 272), insert:

```ts
    if (beadOutOfSync(task)) {
      lines.push(`  ⚠ ${task.task_id} bead ${task.bead} is out of sync after ${task.bead_sync.failures} ` +
        `failed Beads calls: ${task.bead_sync.last_error}`)
    }
```

- [ ] **Step 5: Wire the reconciler into the supervisor's tick**

In `src/supervisor/main.ts`, add the imports:

```ts
import { Bd } from '../lib/bd'
import { readBeadsProject } from '../lib/beads-project'
import { SYNC_BUDGET_MS, syncBeads } from './beads-sync'
```

and insert, after the closing brace of `for (const run of deliverFrom) { … }` (the settle loop that
ends at line 421) and before `// One binding, so the cap the candidates are built with`:

```ts
      // After the advance loop, over every run file — `done` and aborted ones too,
      // whose beads still need releasing. Its own read, because the runs above may
      // have been saved since this tick read them.
      try {
        const syncRuns = (await listRuns(stateDir, session))
          .filter(isCurrentSchemaRun)
          .filter((r) => config.REPOS_ALLOW.length === 0 || config.REPOS_ALLOW.includes(r.repo_key))
        await syncBeads(syncRuns, {
          bdFor: (slug) => new Bd({ stateDir, slug, lockWaitMs: 0, exportAfterWrites: false }),
          hasStore: async (slug) => (await readBeadsProject(stateDir, slug)) !== null,
          now: Date.now,
          budgetMs: SYNC_BUDGET_MS,
          persist: async (run, effect) => { await saveOrReapply(stateDir, run, [effect]) },
          log: (message) => console.error(`[pipeline] ${message}`),
        })
      } catch (error) {
        console.error('[pipeline] beads sync failed this tick:', error)
      }
```

- [ ] **Step 6: Run them to verify they pass**

Run: `bun test test/beads-sync.test.ts test/status.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/supervisor/beads-sync.ts src/supervisor/main.ts src/lib/status.ts test/beads-sync.test.ts test/status.test.ts
git commit -m "feat: the supervisor reconciles every bead to the state its ledger implies

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 9: Close — the supervisor's row, its stall variants, `hpipe close`

The close signal (`bead_closed_at_ms`), its clearing on rewind (Task 5) and the reconciler that sets
it (Task 8) are in place. This task makes the row the supervisor's.

**Files:**
- Modify: `src/lib/phases.ts:157-158`; `src/supervisor/tasks.ts` (`renderTaskPhasePrompt`'s `close` case)
- Delete: `prompts/close.md`
- Modify: `src/supervisor/stall.ts` (the `closed` branch Task 5 wrote)
- Modify: `src/cli.ts` (new `cmdClose`, usage, `VALUELESS_FLAGS`, argv)
- Test: `test/phases.test.ts:70-78`, `test/prompts.test.ts:18-22`, `test/tier-prompt.test.ts:113-116,140-143`,
  `test/tasks.test.ts`, `test/tick.test.ts`, `test/status.test.ts:392`, `test/stall.test.ts`, `test/table.test.ts`,
  `test/cli-commands.test.ts`, `test/cli-argv.test.ts:202-205`

- [ ] **Step 1: Write the failing tests**

In `test/table.test.ts`, append:

```ts
test('the close row is the supervisor\'s: no actor, no prompt, probed through the orchestrator', () => {
  const close = taskRow('close')
  expect(close.actor).toBeUndefined()
  expect(close.prompt).toBeUndefined()
  expect(close.probeTarget).toBe('orchestrator')
  expect(close.stallable).toBe(true)
})
```

In `test/phases.test.ts`, replace `test('the actorless and human-owned stallable rows name a probe target'` with:

```ts
test('the actorless and human-owned stallable rows name a probe target', () => {
  // table.test.ts counts only `orchestrator` and `worker` as resolving to a pane,
  // so these must declare one; merge resolves already.
  for (const phase of ['ci', 'close', 'teardown', 'escalated'] as const) {
    expect(taskRow(phase).probeTarget, `${phase} needs a probe target`).toBe('orchestrator')
  }
  expect(taskRow('merge').probeTarget).toBeUndefined()
})
```

In `test/prompts.test.ts`, remove `'close', ` from the `ALL` list (line 19).

In `test/tier-prompt.test.ts`, remove `'close'` from `COMMON_PROMPTS` (line 115) and from the
`phases` list in `test('every task render site carries the tier variables'` (line 142).

In `test/tasks.test.ts`, replace `test('close tells the orchestrator the supervisor closes the bead itself'` with:

```ts
test('close renders no prompt: the supervisor closes the bead itself', async () => {
  const run = mkRun([mkTask({ phase: 'close', pr: 42 })])
  expect(await promptForTaskPhase(run, run.tasks[0]!, deps(), 'merge')).toBe('')
})
```

In `test/tick.test.ts`, change:

```ts
  expect(at('close')).toBe('YOUR move: waiting for bead hp-1 to be closed by the supervisor')
```

to:

```ts
  expect(at('close')).toBe('nothing for you — the supervisor is driving')
```

In `test/status.test.ts`, in `test('waiting on you is ordered by task id, as the digest footer is'`, change
`mkTask({ task_id: 't1', phase: 'close' }),` to `mkTask({ task_id: 't1', phase: 'merge' }),` (a
`close` task no longer waits on you).

In `test/stall.test.ts`, replace `test('a close row waits on the supervisor\'s Beads close and names the merge rewind — #19'` with:

```ts
test('a close row with no merge recorded names the rewind into merge — #19', () => {
  const run = runWithTask({ phase: 'close', merged_at_ms: null })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.short).toBe('bead hp-1 to be closed by the supervisor')
  expect(a.clause).toContain('No merge is recorded for t1')
  expect(a.clause).toContain(`hp rewind ${run.run_id} merge --task t1`)
})

test('a close row the reconciler is still retrying says so and asks for nothing', () => {
  const run = runWithTask({
    phase: 'close', merged_at_ms: 5, bead_sync: { failures: 2, last_error: 'Error: database is locked', last_ok_at_ms: null },
  })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.clause).toContain('waiting on the Beads close of hp-1')
  expect(a.clause).not.toContain('hp close')
})

test('a close row past five failures quotes bd verbatim and names hpipe close and --force', () => {
  const refusal = 'cannot close hp-1: assignee is "bob", actor is "hpipe"'
  const run = runWithTask({
    phase: 'close', merged_at_ms: 5, bead_sync: { failures: 5, last_error: refusal, last_ok_at_ms: null },
  })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.clause).toContain(refusal)
  expect(a.clause).toContain('`hp close --task t1`')
  expect(a.clause).toContain('`--force`')
})
```

In `test/cli-commands.test.ts`, add `cmdClose` to the `../src/cli` import list and append:

```ts
const mergedInClose = (): Run =>
  runWithTasks([{ task_id: 't1', phase: 'close', pr: 7, merged_at_ms: 9_000, merge_commit: 'm3rg3' }])

test('close closes the task\'s bead with the merge as its reason, and writes no ledger field', async () => {
  await saveRun(dir, mergedInClose())
  const before = JSON.stringify((await listRuns(dir, 'personal'))[0])
  const asked: Array<[string, string, string, boolean]> = []

  const result = await cmdClose(ctx(), { taskId: 't1', repoKey: 'k', runId: null, force: false },
    async (repoKey, bead, reason, force) => { asked.push([repoKey, bead, reason, force]); return { ok: true } })

  expect(result.ok).toBe(true)
  expect(result.text).toContain('closed hp-1')
  expect(asked).toEqual([['k', 'hp-1', 'merged in PR #7 (m3rg3)', false]])
  expect(JSON.stringify((await listRuns(dir, 'personal'))[0])).toBe(before)
})

test('close --force forces; a refusal passes bd\'s words through and offers --force only when not forced', async () => {
  await saveRun(dir, mergedInClose())
  const forced: boolean[] = []
  const refuse = async (_k: string, _b: string, _r: string, force: boolean) => {
    forced.push(force)
    return { reason: 'exit' as const, error: 'cannot close hp-1: assignee is "bob", actor is "hpipe"' }
  }

  const plain = await cmdClose(ctx(), { taskId: 't1', repoKey: 'k', runId: null, force: false }, refuse)
  const strong = await cmdClose(ctx(), { taskId: 't1', repoKey: 'k', runId: null, force: true }, refuse)

  expect(forced).toEqual([false, true])
  expect(plain.ok).toBe(false)
  expect(plain.text).toContain('assignee is "bob"')
  expect(plain.text).toContain('--force')
  expect(strong.text).not.toContain('--force overrides')
})

test('close refuses a task with no merge recorded, and names the rewind that records it', async () => {
  const run = runWithTasks([{ task_id: 't1', phase: 'close', merged_at_ms: null }])
  await saveRun(dir, run)
  let calls = 0
  const result = await cmdClose(ctx(), { taskId: 't1', repoKey: 'k', runId: null, force: true },
    async () => { calls++; return { ok: true } })
  expect(result.ok).toBe(false)
  expect(result.text).toContain(`rewind ${run.run_id} merge --task t1`)
  expect(calls).toBe(0)
})
```

In `test/cli-argv.test.ts`, add `'close'` to `SUBCOMMANDS` (after `'forget'`).

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/table.test.ts test/phases.test.ts test/tasks.test.ts test/stall.test.ts test/cli-commands.test.ts`
Expected: FAIL — the close row still has `actor`/`prompt`, `cmdClose` is not exported.

- [ ] **Step 3: Make the close row the supervisor's and delete its prompt**

In `src/lib/phases.ts`, change lines 157-158 from:

```ts
  { phase: 'close', actor: 'orchestrator', signal: 'closed',
    onClear: 'teardown', prompt: 'close', stallable: true, holdsFiles: true },
```

to:

```ts
  // The supervisor's own row: the reconciler closes the bead once the merge is
  // recorded, so nobody is prompted and the probe goes to the orchestrator.
  { phase: 'close', signal: 'closed', onClear: 'teardown',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: true },
```

In `src/supervisor/tasks.ts`, delete from `renderTaskPhasePrompt`'s switch:

```ts
    case 'close':
      return renderPrompt(deps.pluginRoot, 'close', common)
```

Run: `git rm prompts/close.md`

- [ ] **Step 4: The close stall's three variants**

In `src/supervisor/stall.ts`, add the import:

```ts
import { beadOutOfSync } from '../lib/bead-desired'
```

and replace the `closed` branch with:

```ts
  if (row.signal === 'closed' && task) {
    if (task.merged_at_ms === null) {
      return {
        short: awaitedFor(task),
        clause: `No merge is recorded for ${task.task_id}, so the supervisor will not close bead ${task.bead} ` +
          `and this phase cannot clear: \`${hpipe} rewind ${run.run_id} merge --task ${task.task_id}\` records it.`,
      }
    }
    if (!beadOutOfSync(task)) {
      return {
        short: awaitedFor(task),
        clause: `This phase is waiting on the Beads close of ${task.bead}, which the supervisor retries every ` +
          'tick. Nothing is needed from you yet.',
      }
    }
    return {
      short: awaitedFor(task),
      clause: `The supervisor's Beads calls for ${task.bead} have failed ${task.bead_sync.failures} times; ` +
        `the last said:\n\n    ${task.bead_sync.last_error}\n\nFix what it names, or close the bead by hand: ` +
        `\`${hpipe} close --task ${task.task_id}\`. Add \`--force\` only to override bd's close guards, ` +
        'once you know why they fired.',
    }
  }
```

- [ ] **Step 5: `hpipe close --task tN [--force]`**

In `src/cli.ts`, add the import:

```ts
import { closeReason } from './supervisor/beads-sync'
```

Insert above `async function release(`:

```ts
export type CloseBead = (repoKey: string, bead: string, reason: string, force: boolean) => Promise<Done | BdFailure>

const cliCloseBead = (stateDir: string): CloseBead => (repoKey, bead, reason, force) =>
  withCliBd(stateDir, repoKey, (bd) => bd.close(bead, reason, { force }))

/**
 * The fallback the close stall names once the reconciler's own close keeps
 * failing. It writes no ledger field: the next reconciler pass sees the bead
 * closed and records the edge itself, and a forced close is never undone because
 * the desired state is `closed` too.
 */
export async function cmdClose(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null; force: boolean
}, close: CloseBead = cliCloseBead(ctx.stateDir)): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (task.merged_at_ms === null) {
    return fail(`no merge is recorded for ${task.task_id}, so its bead must not close yet — ` +
      `\`${hpipeCommand(ctx.pluginRoot)} rewind ${run.run_id} merge --task ${task.task_id}\` records it`)
  }
  const closed = await close(run.repo_key, task.bead, closeReason(task), input.force)
  if (isBdFailure(closed)) {
    return fail(`bd would not close ${task.bead}:\n  ${closed.error}` + (input.force
      ? ''
      : '\n  → --force overrides bd\'s close guards; use it only once you know why they fired'))
  }
  return ok(`closed ${task.bead}${input.force ? ' (forced)' : ''}; the next supervisor pass records it ` +
    `and tears ${task.task_id} down`)
}
```


Add to `USAGE` after `forget`:

```ts
  close: ['hpipe close --task <id> [--force] [--run <run-id>]'],
```

change `VALUELESS_FLAGS` to:

```ts
const VALUELESS_FLAGS = new Set(['--done', '--keep-worktree', '--force', ...HELP_FLAGS])
```

and add to the argv `switch`, before `case 'status':`:

```ts
    case 'close':
      out = await cmdClose(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
        force: rest.includes('--force'),
      })
      break
```

- [ ] **Step 6: Run them to verify they pass**

Run: `bun test test/table.test.ts test/phases.test.ts test/prompts.test.ts test/tier-prompt.test.ts test/tasks.test.ts test/tick.test.ts test/status.test.ts test/stall.test.ts test/cli-commands.test.ts test/cli-argv.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add -A src prompts test
git commit -m "feat: the close row is the supervisor's, with hpipe close as the manual fallback

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 10: Decisions — `hpipe escalate` and "waiting on you"

**Files:**
- Modify: `src/cli.ts` (new `cmdEscalate`, usage, argv); `src/lib/status.ts` (`moveFor`, lines 159-164)
- Modify: `prompts/decision.md` (after line 24)
- Test: `test/cli-commands.test.ts`, `test/status.test.ts`, `test/prompts.test.ts`, `test/cli-argv.test.ts` (`SUBCOMMANDS`)

- [ ] **Step 1: Write the failing tests**

In `test/cli-commands.test.ts`, add `cmdEscalate` to the `../src/cli` import list, change the
decisions import from:

```ts
import { openDecisionFor } from '../src/lib/decisions'
```

to:

```ts
import { escalatedUnanswered, openDecision, openDecisionFor } from '../src/lib/decisions'
```

and append:

```ts
async function seedAskedDecision(): Promise<Run> {
  const run = runWithTasks([{ task_id: 't1', phase: 'blocked-on-decision', decision_from: 'plan' }])
  openDecision(run.tasks[0]!, { question: 'Which store?', recommendation: 'sqlite' })
  await saveRun(dir, run)
  return run
}

const escalation = (over: Partial<Parameters<typeof cmdEscalate>[1]> = {}): Parameters<typeof cmdEscalate>[1] => ({
  taskId: 't1', decisionId: 'd1', recommendation: 'sqlite, for the tests', repoKey: 'k', runId: null, ...over,
})

const savedTask = async (): Promise<Task> => (await listRuns(dir, 'personal'))[0]!.tasks[0]!

test('escalate hands the open decision to the human with the orchestrator\'s recommendation', async () => {
  await seedAskedDecision()
  const result = await cmdEscalate(ctx(), escalation())
  expect(result.ok).toBe(true)
  expect(result.text).toContain('d1 on t1 is now with the human')
  const task = await savedTask()
  expect(task.decisions[0]!.escalated_at).toBeGreaterThan(0)
  expect(task.decisions[0]!.orchestrator_recommendation).toBe('sqlite, for the tests')
  expect(escalatedUnanswered(task)?.id).toBe('d1')
})

test('escalate refuses a bare escalation, an unknown decision, and a task not blocked on one', async () => {
  await seedAskedDecision()
  expect((await cmdEscalate(ctx(), escalation({ recommendation: ' ' }))).text).toContain('--recommend is required')
  expect((await cmdEscalate(ctx(), escalation({ decisionId: 'd9' }))).text).toContain('no such decision: d9')
  expect((await savedTask()).decisions[0]!.escalated_at).toBeNull()

  await cmdRewind(ctx(), { runId: (await listRuns(dir, 'personal'))[0]!.run_id, phase: 'plan', taskId: 't1' })
  expect((await cmdEscalate(ctx(), escalation())).text).toContain('is not blocked on a decision')
})

test('a second escalate changes nothing', async () => {
  await seedAskedDecision()
  await cmdEscalate(ctx(), escalation())
  const first = (await savedTask()).decisions[0]!.escalated_at
  const again = await cmdEscalate(ctx(), escalation({ recommendation: 'something else' }))
  expect(again.ok).toBe(true)
  expect(again.text).toContain('already with the human')
  expect((await savedTask()).decisions[0]).toMatchObject({ escalated_at: first, orchestrator_recommendation: 'sqlite, for the tests' })
})

test('an answer by the human ends the escalation', async () => {
  await seedAskedDecision()
  await cmdEscalate(ctx(), escalation())
  await cmdAnswer(ctx(), { task: 't1', decision: 'd1', answer: 'sqlite', by: 'human', repoKey: 'k', runId: null })
  expect(escalatedUnanswered(await savedTask())).toBeNull()
})

test('an answer by the orchestrator ends the escalation too', async () => {
  await seedAskedDecision()
  await cmdEscalate(ctx(), escalation())
  await cmdAnswer(ctx(), { task: 't1', decision: 'd1', answer: 'sqlite', by: 'orchestrator', repoKey: 'k', runId: null })
  expect(escalatedUnanswered(await savedTask())).toBeNull()
})
```

Append to `test/status.test.ts`:

```ts
test('a decision put to the human is listed under waiting on you with the command that records the ruling', () => {
  const now = 10_000_000
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'blocked-on-decision', decision_from: 'plan', decisions: [{
    id: 'd1', asked_at: 0, from_phase: 'plan', question: 'q', recommendation: 'r',
    answer: null, answered_by: null, answered_at: null, prompted_at: 1,
    escalated_at: now - 5 * 60_000, orchestrator_recommendation: 'r2',
  }] })]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now)
  expect(text).toContain('waiting on you:')
  expect(text).toContain(`decision d1 was put to the human 5m ago — record their ruling with ` +
    `\`${HP} answer --task t1 --decision d1 --answer "<their ruling>" --by human\``)
})
```

Append to `test/prompts.test.ts`:

```ts
test('the decision prompt has the orchestrator escalate whatever it puts to the human', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'decision.md')).text())
  expect(text).toContain('{{hpipe}} escalate --task {{task_id}} --decision {{decision_id}}')
  expect(text).toContain('--recommend')
  expect(text).toContain('the brief (`{{hpipe}} brief --task {{task_id}}`)')
})
```

In `test/cli-argv.test.ts`, add `'escalate'` to `SUBCOMMANDS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/cli-commands.test.ts test/status.test.ts test/prompts.test.ts`
Expected: FAIL — `Export named 'cmdEscalate' not found`; the status clause and the prompt text are absent.

- [ ] **Step 3: `hpipe escalate`**

In `src/cli.ts`, insert after `export const cmdAnswer = retryingOnStale(answer)`:

```ts
async function escalate(ctx: Ctx, input: {
  taskId: string; decisionId: string; recommendation: string
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  if (input.recommendation.trim().length === 0) {
    return fail('--recommend is required: the human gets your recommendation beside the worker\'s')
  }
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  const decision = task.decisions.find((d) => d.id === input.decisionId)
  if (!decision) return fail(`no such decision: ${input.decisionId}`)
  if (decision.answered_by !== null) {
    return fail(`decision ${decision.id} on ${task.task_id} is already ${decision.answered_by === 'abandoned' ? 'abandoned' : 'answered'}`)
  }
  if (task.phase !== 'blocked-on-decision') {
    return fail(`task ${task.task_id} is not blocked on a decision (phase: ${task.phase})`)
  }
  if (decision.escalated_at !== null) {
    return ok(`decision ${decision.id} on ${task.task_id} is already with the human; nothing changed`)
  }

  decision.escalated_at = Date.now()
  decision.orchestrator_recommendation = input.recommendation
  await saveRun(ctx.stateDir, run)
  return ok(`decision ${decision.id} on ${task.task_id} is now with the human; its bead shows blocked until ` +
    `\`${hpipeCommand(ctx.pluginRoot)} answer --task ${task.task_id} --decision ${decision.id} --by human\` records their ruling`)
}
export const cmdEscalate = retryingOnStale(escalate)
```

Add to `USAGE` after `answer`:

```ts
  escalate: ['hpipe escalate --task <id> --decision <id> --recommend <text> [--run <run-id>]'],
```

and to the argv `switch`, after the `answer` case:

```ts
    case 'escalate':
      out = await cmdEscalate(ctx, {
        taskId: flag(rest, 'task') ?? '',
        decisionId: flag(rest, 'decision') ?? '',
        recommendation: flag(rest, 'recommend') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break
```

- [ ] **Step 4: "waiting on you" names the escalated question**

In `src/lib/status.ts`, change the decisions import (line 2) to:

```ts
import { escalatedUnanswered, openDecisionFor } from './decisions'
```

and change the start of the `row.actor === 'orchestrator'` block in `moveFor` (lines 159-160) from:

```ts
  if (row.actor === 'orchestrator') {
    // A recorded answer is the supervisor's to deliver; the orchestrator has done its part.
```

to:

```ts
  if (row.actor === 'orchestrator') {
    const escalated = escalatedUnanswered(task)
    if (escalated !== null) {
      return yours(`decision ${escalated.id} was put to the human ` +
        `${ageMinutes(escalated.escalated_at ?? now, now)}m ago — record their ruling with ` +
        `\`${hpipe} answer --task ${task.task_id} --decision ${escalated.id} --answer "<their ruling>" --by human\``)
    }
    // A recorded answer is the supervisor's to deliver; the orchestrator has done its part.
```

- [ ] **Step 5: Tell the orchestrator to escalate**

In `prompts/decision.md`, insert after line 24 (the end of the "Otherwise put it to the human"
paragraph, `…is exactly the cost this pipeline exists to remove.`):

```markdown

Then hand it over, so the bead shows it blocked on them and `{{hpipe}} status` lists it under
"waiting on you":

    {{hpipe}} escalate --task {{task_id}} --decision {{decision_id}} \
                   --recommend "<the option you recommend, and why>"
```

- [ ] **Step 6: Run them to verify they pass**

Run: `bun test test/cli-commands.test.ts test/status.test.ts test/prompts.test.ts test/cli-argv.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/cli.ts src/lib/status.ts prompts/decision.md test/cli-commands.test.ts test/status.test.ts \
  test/prompts.test.ts test/cli-argv.test.ts
git commit -m "feat: hpipe escalate puts a decision to the human and blocks its bead

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 11: `hpipe bead show` and `hpipe next`

**Files:**
- Create: `src/lib/bead-view.ts`, `src/lib/next.ts`, `src/lib/bv.ts`
- Modify: `src/cli.ts` (new `cmdBeadShow`, `cmdNext`, usage, argv, `needsRepo`)
- Test: `test/bead-view.test.ts`, `test/next.test.ts`, `test/bv.test.ts`, `test/cli-commands.test.ts`, `test/cli-argv.test.ts` (`SUBCOMMANDS`)

- [ ] **Step 1: Write the failing tests**

Create `test/bead-view.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { formatBeadDetail } from '../src/lib/bead-view'

test('a bead prints its title, status, labels, description, acceptance and comments', () => {
  expect(formatBeadDetail({
    id: 'hp-3', title: 'Fix the meter', status: 'in_progress', assignee: 'hpipe', labels: ['ui', 'phase:plan'],
    description: 'It drifts.\n', acceptance_criteria: 'It holds.',
    comments: [{ text: 'Ruling by the human on t1/d1:\n\nsqlite\n\n[hpipe t1/d1/ruling]' }],
  })).toBe([
    'hp-3 [in_progress] Fix the meter',
    'labels:     ui, phase:plan',
    'assignee:   hpipe',
    '',
    'description:',
    'It drifts.',
    '',
    'acceptance:',
    'It holds.',
    '',
    'comments:',
    '- Ruling by the human on t1/d1:\n  \n  sqlite\n  \n  [hpipe t1/d1/ruling]',
  ].join('\n'))
})

test('a bare bead says none rather than printing blanks', () => {
  const text = formatBeadDetail({ id: 'hp-4', title: 'T', status: 'open' })
  expect(text).toContain('labels:     none')
  expect(text).toContain('assignee:   none')
  expect(text).toContain('description:\n(none)')
  expect(text).toContain('acceptance:\n(none)')
  expect(text).toContain('comments: none')
})
```

Create `test/next.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdNext } from '../src/cli'
import { newRun, saveRun } from '../src/lib/ledger'
import { formatNext, type TriageByTrack } from '../src/lib/next'
import type { Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'next-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

const TRIAGE: TriageByTrack = {
  status: {
    PageRank: { state: 'computed' },
    Cycles: { state: 'timeout', reason: 'budget exceeded' },
    Betweenness: { state: 'approx', reason: 'sampled 500 nodes' },
  },
  recommendations_by_track: [
    {
      track_id: 'A', reason: 'Independent work stream',
      top_pick: { id: 'hp-3', title: 'Meter', score: 0.82, reasons: ['unblocks 2'], unblocks: 2 },
      recommendations: [
        { id: 'hp-3', title: 'Meter', score: 0.82, labels: ['ui'], reasons: ['unblocks 2', 'P1'], unblocks_ids: ['hp-5', 'hp-6'], claimable: true },
        { id: 'hp-4', title: 'Tile', score: 0.5, labels: [], reasons: [], claimable: true },
      ],
    },
    {
      track_id: 'B',
      top_pick: { id: 'hp-7', title: 'Held one', score: 0.9, reasons: [], unblocks: 0 },
      recommendations: [{ id: 'hp-7', title: 'Held one', score: 0.9, labels: [], reasons: [], claimable: true }],
    },
  ],
  blockers_to_clear: [{ id: 'hp-2', title: 'Schema', unblocks_ids: ['hp-3', 'hp-4'] }],
  alerts: [{ type: 'stale', severity: 'warning', message: 'hp-9 untouched for 30 days' }],
}

const ALL = { limit: 5, label: null }

test('each track prints its top pick with score, reasons and what it unblocks, then its other ids', () => {
  expect(formatNext(TRIAGE, new Set(), ALL)).toBe([
    'warning: cycles: timeout — cycle-free not proven',
    'warning: betweenness: approx — sampled 500 nodes',
    'track A — Independent work stream',
    '  top: hp-3 "Meter" score 0.82 — unblocks hp-5, hp-6',
    '    why: unblocks 2; P1',
    '  also: hp-4',
    'track B',
    '  top: hp-7 "Held one" score 0.90',
    'blockers to clear:',
    '  hp-2 "Schema" — unblocks hp-3, hp-4',
    'alerts:',
    '  [warning] stale: hp-9 untouched for 30 days',
  ].join('\n'))
})

test('held beads are dropped: a held top pick yields to the next claimable bead, an emptied track goes', () => {
  const text = formatNext(TRIAGE, new Set(['hp-3', 'hp-7']), ALL)
  expect(text).toContain('track A — Independent work stream\n  top: hp-4 "Tile" score 0.50')
  expect(text).not.toContain('hp-3 "Meter"')
  expect(text).not.toContain('track B')
})

test('--label keeps only beads carrying it, and --limit caps the tracks', () => {
  expect(formatNext(TRIAGE, new Set(), { limit: 5, label: 'ui' })).not.toContain('hp-4')
  expect(formatNext(TRIAGE, new Set(), { limit: 1, label: null })).not.toContain('track B')
})

test('a track with nothing claimable says so, and an empty triage says nothing is there to pick up', () => {
  const blocked: TriageByTrack = {
    recommendations_by_track: [{ track_id: 'C', recommendations: [{ id: 'hp-8', title: 'x', score: 0.1, claimable: false }] }],
  }
  expect(formatNext(blocked, new Set(), ALL)).toBe('track C\n  no claimable pick\n  also: hp-8')
  expect(formatNext({}, new Set(), ALL)).toBe('nothing to pick up: every open bead is held, blocked or filtered out')
})

test('hpipe next filters by what live runs in any session hold', async () => {
  const run = newRun({ session: 'work', socketPath: '/s', repoKey: 'k2', repoRoot: '/r2', title: 'b' })
  run.tasks = [{
    task_id: 't1', branch: 'b', bead: 'hp-7', surface: 'core', depends_on: [], files: [], keep_worktree: false,
    workspace_id: null, pane_id: null, agent_status: 'unknown', phase: 'implement', phase_entered_at: 0,
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null, checkout_path: null,
    registered_at: 0, adopted_at: null, artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [], decision_from: null,
    pending_answer: null, delivery_attempts: 0, notes: '',
  } satisfies Task]
  await saveRun(dir, run)

  const result = await cmdNext(ctx(), { repoKey: 'k', limit: 5, label: null }, async () => TRIAGE)
  expect(result.ok).toBe(true)
  expect(result.text).not.toContain('track B')
})

test('hpipe next fails with the reason when triage cannot run, and refuses a bad --limit', async () => {
  const missing = await cmdNext(ctx(), { repoKey: 'k', limit: 5, label: null },
    async () => ({ reason: 'unavailable', error: 'bv did not run (ENOENT) — brew install dicklesworthstone/tap/bv' }))
  expect(missing.ok).toBe(false)
  expect(missing.text).toContain('brew install dicklesworthstone/tap/bv')

  const bad = await cmdNext(ctx(), { repoKey: 'k', limit: 0, label: null }, async () => TRIAGE)
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('--limit must be a positive whole number')
})
```

Create `test/bv.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsExportPath, beadsHome } from '../src/lib/beads-project'
import { bvTriage } from '../src/lib/bv'
import { makeFakeBin } from './helpers/fake-bin'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bv-'))
  mkdirSync(beadsHome(dir, 'r-abc123'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('bvTriage runs --robot-triage-by-track on the export and returns its triage', async () => {
  const bin = await makeFakeBin(dir, { '--robot-triage-by-track': { triage: { alerts: [] }, usage_hints: [] } })
  expect(await bvTriage(dir, 'r-abc123', { bin })).toEqual({ alerts: [] })
  expect(readFileSync(join(dir, 'calls.log'), 'utf8').trim())
    .toBe(`--robot-triage-by-track --db ${beadsExportPath(dir, 'r-abc123')}`)
})

test('a failing or silent bv is a failure, not a crash', async () => {
  const failing = await makeFakeBin(dir, { '--robot-triage-by-track': { error: { code: 'x', message: 'no db' } } })
  expect(await bvTriage(dir, 'r-abc123', { bin: failing })).toMatchObject({ reason: 'exit' })

  const silentDir = mkdtempSync(join(dir, 'silent-'))
  const silent = await makeFakeBin(silentDir, { '--robot-triage-by-track': 'not json' })
  expect(await bvTriage(dir, 'r-abc123', { bin: silent })).toEqual({ reason: 'output', error: 'bv printed no triage JSON' })
})
```

In `test/cli-commands.test.ts`, add `cmdBeadShow` to the `../src/cli` import list and append:

```ts
test('bead show prints the bead bd shows, and passes a failure through', async () => {
  const shown = await cmdBeadShow(ctx(), { repoKey: 'k', id: 'hp-3' },
    async (_repoKey, id) => openBead(id, { title: 'Fix the meter' }))
  expect(shown.ok).toBe(true)
  expect(shown.text).toStartWith('hp-3 [open] Fix the meter')

  const failed = await cmdBeadShow(ctx(), { repoKey: 'k', id: 'hp-404' },
    async () => ({ reason: 'exit', error: 'Error: issue hp-404 not found' }))
  expect(failed.ok).toBe(false)
  expect(failed.text).toContain('Error: issue hp-404 not found')

  expect((await cmdBeadShow(ctx(), { repoKey: 'k', id: '' })).text).toContain('usage: hpipe bead show <id>')
})
```

In `test/cli-argv.test.ts`, add `'bead'` and `'next'` to `SUBCOMMANDS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/bead-view.test.ts test/next.test.ts test/bv.test.ts test/cli-commands.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/bead-view'`, `'../src/lib/next'`, `'../src/lib/bv'`.

- [ ] **Step 3: Write the bead view, the triage formatter and the bv runner**

Create `src/lib/bead-view.ts`:

```ts
import type { BeadDetail } from './bd'

const orNone = (text: string | undefined): string => (text === undefined || text.trim() === '' ? '(none)' : text.trim())

export function formatBeadDetail(bead: BeadDetail): string {
  const labels = bead.labels ?? []
  const comments = bead.comments ?? []
  return [
    `${bead.id} [${bead.status}] ${bead.title}`,
    `labels:     ${labels.length > 0 ? labels.join(', ') : 'none'}`,
    `assignee:   ${bead.assignee || 'none'}`,
    '',
    'description:',
    orNone(bead.description),
    '',
    'acceptance:',
    orNone(bead.acceptance_criteria),
    '',
    comments.length === 0 ? 'comments: none' : 'comments:',
    ...comments.map((comment) => `- ${comment.text.trim().replace(/\n/g, '\n  ')}`),
  ].join('\n')
}
```

Create `src/lib/next.ts`:

```ts
/** The parts of `bv --robot-triage-by-track` hpipe reads (bv `pkg/analysis/triage.go`). */
export interface MetricState {
  state: string
  reason?: string
}

export interface TriageRecommendation {
  id: string
  title: string
  score: number
  labels?: string[]
  reasons?: string[]
  unblocks_ids?: string[]
  claimable?: boolean
}

/** bv's top pick carries `unblocks` as a count; the IDs come from the matching recommendation. */
export interface TriagePick {
  id: string
  title: string
  score: number
  reasons?: string[]
  unblocks?: number
}

export interface TriageTrack {
  track_id: string
  reason?: string
  top_pick?: TriagePick | null
  recommendations?: TriageRecommendation[]
}

export interface TriageBlocker {
  id: string
  title: string
  unblocks_ids?: string[]
}

export interface TriageAlert {
  type: string
  severity: string
  message: string
}

export interface TriageByTrack {
  /** Keyed by bv's Go field names (`PageRank`, `Cycles`, …): the struct carries no JSON tags. */
  status?: Record<string, MetricState>
  recommendations_by_track?: TriageTrack[]
  blockers_to_clear?: TriageBlocker[]
  alerts?: TriageAlert[]
}

export interface NextOptions {
  limit: number
  label: string | null
}

const unblocking = (ids: string[] | undefined): string =>
  (ids ?? []).length > 0 ? ` — unblocks ${ids!.join(', ')}` : ''

function metricWarnings(status: Record<string, MetricState> | undefined): string[] {
  return Object.entries(status ?? {})
    .filter(([, metric]) => metric.state !== 'computed')
    .map(([name, metric]) => {
      const key = name.toLowerCase()
      const consequence = key === 'cycles'
        ? ' — cycle-free not proven'
        : metric.reason === undefined ? '' : ` — ${metric.reason}`
      return `warning: ${key}: ${metric.state}${consequence}`
    })
}

/**
 * Tracks share no dependency, but bv knows nothing about files: two picks from
 * different tracks still serialise with `--files` when they touch the same ones.
 */
export function formatNext(triage: TriageByTrack, held: ReadonlySet<string>, options: NextOptions): string {
  const lines = metricWarnings(triage.status)
  const wanted = (rec: TriageRecommendation): boolean =>
    !held.has(rec.id) && (options.label === null || (rec.labels ?? []).includes(options.label))
  const tracks = (triage.recommendations_by_track ?? [])
    .map((track) => ({ track, recommendations: (track.recommendations ?? []).filter(wanted) }))
    .filter(({ recommendations }) => recommendations.length > 0)
    .slice(0, options.limit)

  if (tracks.length === 0) lines.push('nothing to pick up: every open bead is held, blocked or filtered out')
  for (const { track, recommendations } of tracks) {
    lines.push(`track ${track.track_id}${track.reason === undefined ? '' : ` — ${track.reason}`}`)
    const top = recommendations.find((rec) => rec.id === track.top_pick?.id)
      ?? recommendations.find((rec) => rec.claimable === true)
    if (top === undefined) {
      lines.push('  no claimable pick')
    } else {
      lines.push(`  top: ${top.id} "${top.title}" score ${top.score.toFixed(2)}${unblocking(top.unblocks_ids)}`)
      if ((top.reasons ?? []).length > 0) lines.push(`    why: ${top.reasons!.join('; ')}`)
    }
    const others = recommendations.filter((rec) => rec !== top).map((rec) => rec.id)
    if (others.length > 0) lines.push(`  also: ${others.join(', ')}`)
  }

  const blockers = triage.blockers_to_clear ?? []
  if (blockers.length > 0) {
    lines.push('blockers to clear:', ...blockers.map((b) => `  ${b.id} "${b.title}"${unblocking(b.unblocks_ids)}`))
  }
  const alerts = triage.alerts ?? []
  if (alerts.length > 0) {
    lines.push('alerts:', ...alerts.map((a) => `  [${a.severity}] ${a.type}: ${a.message}`))
  }
  return lines.join('\n')
}
```

Create `src/lib/bv.ts`:

```ts
import type { BdFailure } from './bd'
import { beadsExportPath, beadsHome, beadsSpawnEnv } from './beads-project'
import type { TriageByTrack } from './next'
import { runBounded } from './spawn'
import { bvBin } from './tools'

export const BV_TIMEOUT_MS = 30_000

/** `--db <file>` keeps bv on hpipe's export and off Dolt; the two flags keep it off the network and the repo. */
export function bvSpawnEnv(stateDir: string, slug: string): Record<string, string | undefined> {
  return { ...beadsSpawnEnv(stateDir, slug), BV_NO_UPDATE_CHECK: '1', BV_NO_GITIGNORE: '1' }
}

export async function bvTriage(
  stateDir: string, slug: string, options: { bin?: string; timeoutMs?: number } = {},
): Promise<TriageByTrack | BdFailure> {
  const timeoutMs = options.timeoutMs ?? BV_TIMEOUT_MS
  const out = await runBounded(
    [options.bin ?? bvBin(), '--robot-triage-by-track', '--db', beadsExportPath(stateDir, slug)],
    { cwd: beadsHome(stateDir, slug), env: bvSpawnEnv(stateDir, slug), timeoutMs },
  )
  if (out.timedOut) return { reason: 'timeout', error: `bv was killed after ${timeoutMs / 1000}s` }
  if (out.code !== 0) return { reason: 'exit', error: out.stderr.trim() || `bv exited ${out.code}` }
  try {
    const parsed = JSON.parse(out.stdout) as { triage?: TriageByTrack }
    if (parsed.triage !== undefined) return parsed.triage
  } catch {
    // Falls through to the output failure below.
  }
  return { reason: 'output', error: 'bv printed no triage JSON' }
}
```

- [ ] **Step 4: The two commands**

In `src/cli.ts`, add the imports:

```ts
import { formatBeadDetail } from './lib/bead-view'
import { beadHolds } from './lib/held'
import { formatNext, type TriageByTrack } from './lib/next'
import { bvTriage } from './lib/bv'
```

(`heldBy` is already imported from `./lib/held`; put `beadHolds` in the same import), and add
`bvProblem`/`checkBv` to the `./lib/tools` import.

Insert above `export async function cmdStatus(`:

```ts
export type ShowBead = RegistrationBeads['show']

/** The only way an agent reads Beads: agents never run `bd`. */
export async function cmdBeadShow(ctx: Ctx, input: { repoKey: string; id: string },
  show: ShowBead = cliRegistrationBeads(ctx.stateDir).show): Promise<CmdResult> {
  if (input.id.trim().length === 0) return fail(commandUsage(USAGE.bead ?? []))
  const bead = await show(input.repoKey, input.id.trim())
  if (isBdFailure(bead)) return fail(`bd show ${input.id} failed:\n  ${bead.error}`)
  return ok(formatBeadDetail(bead))
}

export type TriageFor = (repoKey: string) => Promise<TriageByTrack | BdFailure>

const cliTriage = (stateDir: string): TriageFor => async (repoKey) => {
  const bd = await cliBd(stateDir, repoKey)
  if (isBdFailure(bd)) return bd
  const bvBroken = bvProblem(await checkBv())
  if (bvBroken !== null) return { reason: 'unavailable', error: bvBroken }
  // A failed refresh still leaves the last good export to triage, a write or two behind.
  await bd.refreshExport()
  return bvTriage(stateDir, beadsSlug(repoKey))
}

export async function cmdNext(ctx: Ctx, input: { repoKey: string; limit: number; label: string | null },
  triage: TriageFor = cliTriage(ctx.stateDir)): Promise<CmdResult> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    return fail(`--limit must be a positive whole number, got: ${input.limit}`)
  }
  const result = await triage(input.repoKey)
  if (isBdFailure(result)) return fail(result.error)
  const held = new Set((await beadHolds(ctx.stateDir)).keys())
  return ok(formatNext(result, held, { limit: input.limit, label: input.label }))
}
```

`commandUsage` and `USAGE` are declared further down the file as `const`s; they are only read when
the function runs, after module load, so the forward reference is safe.

Add to `USAGE` after `show`:

```ts
  bead: ['hpipe bead show <id>'],
  next: ['hpipe next [--limit <n>] [--label <label>]'],
```

Replace the `needsRepo` lines:

```ts
  const needsRepo = command === 'start' ||
    (!byIdOrNothing.includes(command ?? '') && flag(rest, 'run') === null)
```

with:

```ts
  // These address a repo's Beads store, never a run, so --run cannot stand in for the repo.
  const storeCommands = ['bead', 'next']
  const needsRepo = command === 'start' || storeCommands.includes(command ?? '') ||
    (!byIdOrNothing.includes(command ?? '') && flag(rest, 'run') === null)
```

and add to the argv `switch`, before `case 'status':`:

```ts
    case 'bead': {
      const [subcommand, id] = positionals(rest)
      if (subcommand !== 'show') {
        console.error(commandUsage(usage))
        return 1
      }
      out = await cmdBeadShow(ctx, { repoKey: repo!.repoKey, id: id ?? '' })
      break
    }

    case 'next':
      out = await cmdNext(ctx, {
        repoKey: repo!.repoKey,
        limit: Number(flag(rest, 'limit') ?? '5'),
        label: flag(rest, 'label'),
      })
      break
```

- [ ] **Step 5: Run them to verify they pass**

Run: `bun test test/bead-view.test.ts test/next.test.ts test/bv.test.ts test/cli-commands.test.ts test/cli-argv.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/bead-view.ts src/lib/next.ts src/lib/bv.ts src/cli.ts test/bead-view.test.ts test/next.test.ts \
  test/bv.test.ts test/cli-commands.test.ts test/cli-argv.test.ts
git commit -m "feat: hpipe bead show and hpipe next, the orchestrator's read paths into Beads

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 12: Discovered work — `hpipe discover` and `hpipe discoveries [--file]`

**Files:**
- Modify: `src/cli.ts` (new `cmdDiscover`, `cmdDiscoveries`, usage, `VALUELESS_FLAGS`, argv)
- Modify: `prompts/worker-brief.md` (after `Never run `bd` or `bv` yourself.`), `prompts/branch-review.md` (after line 10)
- Test: `test/cli-commands.test.ts`, `test/prompts.test.ts`, `test/cli-argv.test.ts` (`SUBCOMMANDS`)

- [ ] **Step 1: Write the failing tests**

In `test/cli-commands.test.ts`, add `cmdDiscover, cmdDiscoveries` to the `../src/cli` import list,
add `readFileSync` to the `node:fs` import, and append:

```ts
async function seedWorkingTask(): Promise<Run> {
  const run = runWithTasks([{ task_id: 't1', bead: 'hp-1', phase: 'implement' }])
  await saveRun(dir, run)
  return run
}

const discovery = (title: string, body: string) => {
  const bodyFile = join(repoDir, `${title.replace(/\W+/g, '-')}.md`)
  writeFileSync(bodyFile, body)
  return { taskId: 't1', title, bodyFile, repoKey: 'k', runId: null }
}

test('discover records the work and keeps a copy of its body beside the run', async () => {
  const run = await seedWorkingTask()
  const first = await cmdDiscover(ctx(), discovery('Flaky clock test', 'It fails at midnight.\n'))
  const second = await cmdDiscover(ctx(), discovery('Dead helper', 'nothing calls it\n'))

  expect(first.ok).toBe(true)
  expect(first.text).toContain('t1/x1')
  expect(second.text).toContain('t1/x2')
  const task = (await listRuns(dir, 'personal'))[0]!.tasks[0]!
  expect(task.discoveries.map((d) => [d.id, d.title, d.filed_bead])).toEqual([
    ['x1', 'Flaky clock test', null], ['x2', 'Dead helper', null],
  ])
  const copy = task.discoveries[0]!.body_path
  expect(copy).toBe(join(dir, 'runs', 'personal', `${run.run_id}.discoveries`, 't1-x1.md'))
  expect(readFileSync(copy, 'utf8')).toBe('It fails at midnight.\n')
})

test('discover refuses an empty title or a body that is not a file, recording nothing', async () => {
  await seedWorkingTask()
  expect((await cmdDiscover(ctx(), { ...discovery('x', 'b'), title: ' ' })).ok).toBe(false)
  expect((await cmdDiscover(ctx(), { ...discovery('y', 'b'), bodyFile: join(repoDir, 'nope.md') })).text)
    .toContain('--body-file is not a file')
  expect((await listRuns(dir, 'personal'))[0]!.tasks[0]!.discoveries).toEqual([])
})

test('discoveries lists each one with whether it is filed', async () => {
  await seedWorkingTask()
  await cmdDiscover(ctx(), discovery('Flaky clock test', 'It fails at midnight.\n'))
  const listed = await cmdDiscoveries(ctx(), { repoKey: 'k', runId: null, file: false })
  expect(listed.ok).toBe(true)
  expect(listed.text).toContain('t1/x1 unfiled — Flaky clock test')
})

test('discoveries --file files each unfiled one as a discovered bead, once', async () => {
  await seedWorkingTask()
  await cmdDiscover(ctx(), discovery('Flaky clock test', 'It fails at midnight.\n'))
  await cmdDiscover(ctx(), discovery('Dead helper', 'nothing calls it\n'))
  const filed: BeadCreateInput[] = []
  const fileBead = async (_repoKey: string, input: BeadCreateInput) => {
    filed.push(input)
    return { id: `hp-${10 + filed.length}` }
  }

  const first = await cmdDiscoveries(ctx(), { repoKey: 'k', runId: null, file: true }, fileBead)
  const again = await cmdDiscoveries(ctx(), { repoKey: 'k', runId: null, file: true }, fileBead)

  expect(first.ok).toBe(true)
  expect(first.text).toContain('t1/x1 filed as hp-11 — Flaky clock test')
  expect(first.text).toContain('t1/x2 filed as hp-12 — Dead helper')
  expect(again.ok).toBe(true)
  expect(filed).toEqual([
    { title: 'Flaky clock test', body: 'It fails at midnight.\n', labels: ['hpipe:discovered'], depsDiscoveredFrom: 'hp-1' },
    { title: 'Dead helper', body: 'nothing calls it\n', labels: ['hpipe:discovered'], depsDiscoveredFrom: 'hp-1' },
  ])
})

test('a failed filing stops there, keeps what was filed, and says which one failed', async () => {
  await seedWorkingTask()
  await cmdDiscover(ctx(), discovery('One', 'a\n'))
  await cmdDiscover(ctx(), discovery('Two', 'b\n'))
  let calls = 0
  const result = await cmdDiscoveries(ctx(), { repoKey: 'k', runId: null, file: true }, async () => {
    calls++
    return calls === 1 ? { id: 'hp-11' } : { reason: 'exit', error: 'Error: database is locked' }
  })
  expect(result.ok).toBe(false)
  expect(result.text).toContain('filing t1/x2 failed')
  expect(result.text).toContain('Error: database is locked')
  const discoveries = (await listRuns(dir, 'personal'))[0]!.tasks[0]!.discoveries
  expect(discoveries.map((d) => d.filed_bead)).toEqual(['hp-11', null])
})
```

Append to `test/prompts.test.ts`:

```ts
test('the worker sends out-of-scope work to discover, and the branch review files it', async () => {
  const brief = prose(await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text())
  expect(brief).toContain('{{hpipe}} discover --task {{task_id}} --title "<title>" --body-file <path>')
  expect(brief).toContain('not into this PR')
  const review = prose(await Bun.file(join(ROOT, 'prompts', 'branch-review.md')).text())
  expect(review).toContain('{{hpipe}} discoveries')
  expect(review).toContain('{{hpipe}} discoveries --file')
})
```

In `test/cli-argv.test.ts`, add `'discover'` and `'discoveries'` to `SUBCOMMANDS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/cli-commands.test.ts test/prompts.test.ts`
Expected: FAIL — `Export named 'cmdDiscover' not found`; the prompt lines are absent.

- [ ] **Step 3: The two commands**

In `src/cli.ts`, change the `node:fs` import to:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
```

and add:

```ts
import { DISCOVERED_LABEL } from './lib/bead-desired'
```

Insert after `export const cmdEscalate = retryingOnStale(escalate)`:

```ts
/** The worker's way to keep an out-of-scope find out of its PR. No Beads access: the orchestrator files it. */
async function discover(ctx: Ctx, input: {
  taskId: string; title: string; bodyFile: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  if (input.title.trim().length === 0) return fail('--title is required')
  if (input.title.startsWith('--')) {
    return fail(`--title got a flag where the title belongs: "${input.title}" — the value after --title is missing`)
  }
  const bodyPath = resolve(input.bodyFile)
  if (input.bodyFile.trim().length === 0 || !isReadableFile(bodyPath)) return fail(`--body-file is not a file: ${bodyPath}`)

  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  const id = `x${task.discoveries.length + 1}`
  const dir = join(ctx.stateDir, 'runs', run.session, `${run.run_id}.discoveries`)
  mkdirSync(dir, { recursive: true })
  const bodyCopy = join(dir, `${task.task_id}-${id}.md`)
  copyFileSync(bodyPath, bodyCopy)
  task.discoveries.push({ id, title: input.title, body_path: bodyCopy, filed_bead: null })
  await saveRun(ctx.stateDir, run)
  return ok(`recorded ${task.task_id}/${id}; the orchestrator files it after the run — keep it out of this PR`)
}
export const cmdDiscover = retryingOnStale(discover)

function discoveryList(run: Run): string {
  const lines = run.tasks.flatMap((task) => task.discoveries.map((d) =>
    `${task.task_id}/${d.id} ${d.filed_bead === null ? 'unfiled' : `filed as ${d.filed_bead}`} — ${d.title} (${d.body_path})`))
  return lines.length === 0 ? `no discoveries recorded in ${run.run_id}` : lines.join('\n')
}

/** Saved the moment a bead exists, so a retry finds it filed and files nothing twice. Returns why it was not saved, or null. */
async function recordFiled(
  ctx: Ctx, runId: string, taskId: string, discoveryId: string, bead: string,
): Promise<string | null> {
  try {
    await retryOnStaleRun(async () => {
      const run = await runById(ctx.stateDir, ctx.session, runId)
      const found = run?.tasks.find((t) => t.task_id === taskId)?.discoveries.find((d) => d.id === discoveryId)
      if (!run || !found) throw new Error(`${taskId}/${discoveryId} is gone from the ledger`)
      found.filed_bead = bead
      await saveRun(ctx.stateDir, run)
    })
    return null
  } catch (error) {
    if (isUnlandedSave(error)) return 'the ledger kept changing under the save'
    return error instanceof Error ? error.message : String(error)
  }
}

export type FileDiscovery = RegistrationBeads['create']

export async function cmdDiscoveries(ctx: Ctx, input: {
  repoKey: string | null; runId: string | null; file: boolean
}, fileBead: FileDiscovery = cliRegistrationBeads(ctx.stateDir).create): Promise<CmdResult> {
  const found = await resolveFor(ctx, {
    runId: input.runId, repoKey: input.repoKey, phases: null, taskId: null, reach: 'finished-if-named',
  }, '--run <run-id> lists them anyway')
  if (!found.ok) return found.result
  const runId = found.value.run_id
  if (!input.file) return ok(discoveryList(found.value))

  const pending = found.value.tasks.flatMap((task) =>
    task.discoveries.filter((d) => d.filed_bead === null).map((d) => ({ taskId: task.task_id, discoveryId: d.id })))
  for (const { taskId, discoveryId } of pending) {
    const run = await runById(ctx.stateDir, ctx.session, runId)
    const task = run?.tasks.find((t) => t.task_id === taskId)
    const current = task?.discoveries.find((d) => d.id === discoveryId)
    if (!run || !task || !current || current.filed_bead !== null) continue
    const created = await fileBead(run.repo_key, {
      title: current.title, body: readFileSync(current.body_path, 'utf8'),
      labels: [DISCOVERED_LABEL], depsDiscoveredFrom: task.bead,
    })
    if (isBdFailure(created)) {
      const now = (await runById(ctx.stateDir, ctx.session, runId)) ?? run
      return fail(`${discoveryList(now)}\nfiling ${taskId}/${discoveryId} failed; nothing after it was filed:\n  ${created.error}`)
    }
    const unsaved = await recordFiled(ctx, runId, taskId, discoveryId, created.id)
    if (unsaved !== null) {
      return fail(`${taskId}/${discoveryId} was filed as ${created.id}, but ${unsaved} — do not file it again`)
    }
  }
  const after = await runById(ctx.stateDir, ctx.session, runId)
  return ok(discoveryList(after ?? found.value))
}
```

Add to `USAGE` after `escalate`:

```ts
  discover: ['hpipe discover --task <id> --title <title> --body-file <path> [--run <run-id>]'],
  discoveries: ['hpipe discoveries [--file] [--run <run-id>]'],
```

change `VALUELESS_FLAGS` to:

```ts
const VALUELESS_FLAGS = new Set(['--done', '--keep-worktree', '--force', '--file', ...HELP_FLAGS])
```

and add to the argv `switch`, after the `escalate` case:

```ts
    case 'discover':
      out = await cmdDiscover(ctx, {
        taskId: flag(rest, 'task') ?? '',
        title: flag(rest, 'title') ?? '',
        bodyFile: flag(rest, 'body-file') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'discoveries':
      out = await cmdDiscoveries(ctx, {
        repoKey: repo?.repoKey ?? null, runId: flag(rest, 'run'), file: rest.includes('--file'),
      })
      break
```

- [ ] **Step 4: The two prompt lines**

In `prompts/worker-brief.md`, after the line `Never run `bd` or `bv` yourself.`, add:

```markdown

Out-of-scope bugs and follow-ups you find go to
`{{hpipe}} discover --task {{task_id}} --title "<title>" --body-file <path>`, not into this PR.
```

In `prompts/branch-review.md`, after line 10 (`contracts the work claimed to fulfil.`), add:

```markdown

Before you write the verdict, read what the workers found out of scope:

    {{hpipe}} discoveries

Each line is a bug or a follow-up a worker recorded instead of fixing it in its PR. File them as
beads with `{{hpipe}} discoveries --file`, which files every unfiled one, each linked to the bead it
came from; name in the review any you think are not worth doing.
```

- [ ] **Step 5: Run them to verify they pass**

Run: `bun test test/cli-commands.test.ts test/prompts.test.ts test/cli-argv.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/cli.ts prompts/worker-brief.md prompts/branch-review.md test/cli-commands.test.ts test/prompts.test.ts \
  test/cli-argv.test.ts
git commit -m "feat: workers record out-of-scope work with hpipe discover; branch review files it

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 13: The board tab — one per repo with a live run

**Files:**
- Modify: `src/lib/herdr.ts:201-208` (`pluginPaneOpen` options, new `paneRename`)
- Create: `src/lib/boards.ts`, `src/supervisor/boards.ts`, `src/board.ts`, `src/actions/board.ts`
- Modify: `src/startup.ts` (`clearStrayPanes` exemptions, `readWorkspaceId`, `main`)
- Modify: `src/supervisor/main.ts` (board upkeep after the reconciler)
- Modify: `herdr-plugin.toml` (an action and a pane)
- Test: `test/board.test.ts`, `test/herdr.test.ts`, `test/startup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/herdr.test.ts`:

```ts
test('a plugin pane opens with its cwd and env when given them', async () => {
  const bin = await makeFakeBin(dir, { 'plugin pane open': { result: {} } })
  await new Herdr(bin).pluginPaneOpen('stein.pipeline', 'board', 'w1', {
    cwd: '/state/beads/meter-abc123', env: { HPIPE_BEADS_SLUG: 'meter-abc123' },
  })
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe(
    'plugin pane open --plugin stein.pipeline --entrypoint board --workspace w1 --placement tab --no-focus ' +
      '--cwd /state/beads/meter-abc123 --env HPIPE_BEADS_SLUG=meter-abc123',
  )
})

test('paneRename renames the pane to the label it is given', async () => {
  const bin = await makeFakeBin(dir, { 'pane rename': { result: {} } })
  expect((await new Herdr(bin).paneRename('w1:p3', 'Board: meter abc123')).ok).toBe(true)
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('pane rename w1:p3 Board: meter abc123')
})
```

Append to `test/startup.test.ts`:

```ts
test('clearStrayPanes spares a board, by label or by its recorded pane, and closes the rest', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [
      { pane_id: 'w3:p1', label: 'Pipeline supervisor' },
      { pane_id: 'w3:p2', label: 'Board' },
      { pane_id: 'w3:p3', label: 'Board: meter abc123' },
      { pane_id: 'w3:p4', label: 'zsh' },
      { pane_id: 'w3:p5', label: null },
    ] } },
    'pane close': { result: {} },
  })
  expect(await clearStrayPanes(new Herdr(bin), 'w3', new Set(['w3:p4']))).toEqual(['w3:p5'])
})
```

Create `test/board.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsHome, beadsSlug } from '../src/lib/beads-project'
import { boardLabel, isBoardLabel, readBoards, updateBoards } from '../src/lib/boards'
import type { PaneInfo, PaneOpenOptions } from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import type { Run } from '../src/lib/types'
import { type BoardDeps, syncBoards } from '../src/supervisor/boards'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const REPO = '/code/meter'
const SLUG = beadsSlug(REPO)

function runIn(phase: Run['phase']): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: REPO, repoRoot: REPO, title: 'a' })
  run.phase = phase
  return run
}

function fakeHerdr(panes: PaneInfo[], shellPids: Record<string, number | undefined> = {}) {
  const calls: string[] = []
  const herdr: BoardDeps['herdr'] = {
    paneList: async () => panes,
    paneShellPid: async (paneId) => shellPids[paneId],
    paneClose: async (paneId) => { calls.push(`close ${paneId}`); return { ok: true } },
    pluginPaneOpen: async (pluginId, entrypoint, workspaceId, options?: PaneOpenOptions) => {
      calls.push(`open ${pluginId} ${entrypoint} ${workspaceId} ${options?.cwd} ${JSON.stringify(options?.env)}`)
      return { ok: true }
    },
  }
  return { herdr, calls }
}

function deps(herdr: BoardDeps['herdr'], over: Partial<BoardDeps> = {}): BoardDeps {
  return {
    stateDir: dir, session: 'personal', pluginId: 'stein.pipeline', workspaceId: 'w9',
    now: () => 100_000, hasStore: async () => true, herdr, ...over,
  }
}

const OPEN = (): string => `open stein.pipeline board w9 ${beadsHome(dir, SLUG)} {"HPIPE_BEADS_SLUG":"${SLUG}"}`
const BOARD_PANE: PaneInfo = { pane_id: 'w9:p4', label: boardLabel(SLUG) }

test('a repo with a live run and no board gets one, recorded as booting before it is opened', async () => {
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([OPEN()])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: { pane_id: null, shell_pid: null, opened_at_ms: 100_000 } })
})

test('a booting board is left alone inside its grace, and opened again past it', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: null, shell_pid: null, opened_at_ms: 90_000 } })
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([])
  await syncBoards([runIn('execute')], deps(herdr, { now: () => 130_001 }))
  expect(calls).toEqual([OPEN()])
})

test('a board whose shell is the one it recorded stays; one whose shell changed is a ghost and is replaced', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const same = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('execute')], deps(same.herdr))
  expect(same.calls).toEqual([])

  const restarted = fakeHerdr([BOARD_PANE], { 'w9:p4': 999 })
  await syncBoards([runIn('execute')], deps(restarted.herdr))
  expect(restarted.calls).toEqual(['close w9:p4', OPEN()])
})

test('a shell pid herdr cannot report is not taken for a ghost', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], {})
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([])
})

test('a recorded board whose pane is gone is opened again', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([OPEN()])
})

test('a board whose repo has no live run left is closed and forgotten', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('done')], deps(herdr))
  expect(calls).toEqual(['close w9:p4'])
  expect(await readBoards(dir, 'personal')).toEqual({})
})

test('no Beads store, no board', async () => {
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr, { hasStore: async () => false }))
  expect(calls).toEqual([])
})

test('a board is labelled with its repo and hash, and only board labels read as boards', () => {
  expect(boardLabel('meter-abc123')).toBe('Board: meter abc123')
  expect(isBoardLabel('Board')).toBe(true)
  expect(isBoardLabel('Board: meter abc123')).toBe(true)
  for (const label of ['Pipeline supervisor', 'Boards', '', undefined, null]) expect(isBoardLabel(label)).toBe(false)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/board.test.ts test/herdr.test.ts test/startup.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/boards'`; `paneRename` is not a function; the third
`clearStrayPanes` argument is ignored, so it closes the boards too.

- [ ] **Step 3: Herdr can open a pane with cwd and env, and rename one**

In `src/lib/herdr.ts`, insert above `export class Herdr {`:

```ts
export interface PaneOpenOptions {
  cwd?: string
  env?: Record<string, string>
}
```

and replace `pluginPaneOpen` (lines 201-208) with:

```ts
  async pluginPaneOpen(
    pluginId: string, entrypoint: string, workspaceId: string, options: PaneOpenOptions = {},
  ): Promise<CallResult<unknown>> {
    return this.call([
      'plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint,
      '--workspace', workspaceId, '--placement', 'tab', '--no-focus',
      ...(options.cwd === undefined ? [] : ['--cwd', options.cwd]),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ])
  }

  async paneRename(paneId: string, label: string): Promise<CallResult<unknown>> {
    return this.call(['pane', 'rename', paneId, label])
  }
```

- [ ] **Step 4: The board registry**

Create `src/lib/boards.ts`:

```ts
import { join } from 'node:path'
import { readJson, withFileLock, writeJson } from './store'

/**
 * `pane_id: null` is a board the supervisor has asked herdr for and `board.ts`
 * has not recorded yet; `shell_pid` is how a herdr restart's plain shell, which
 * keeps the label, is told from the board that was there.
 */
export interface BoardRecord {
  pane_id: string | null
  shell_pid: number | null
  opened_at_ms: number
}

export type BoardRegistry = Record<string, BoardRecord>

export const BOARD_PANE_TITLE = 'Board'
/** Longer than `board.ts` takes to start and record itself; a placeholder older than this is a board that never came up. */
export const BOARD_OPEN_GRACE_MS = 30_000
const SLUG_HASH_SUFFIX = 7

const boardsPath = (stateDir: string, session: string): string => join(stateDir, `boards.${session}.json`)

/** A slug is `<repo>-<hash6>`, so its last seven characters are the dash and the hash. */
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
```

- [ ] **Step 5: The per-slug lifecycle**

Create `src/supervisor/boards.ts`:

```ts
import { beadsHome, beadsSlug } from '../lib/beads-project'
import { BOARD_OPEN_GRACE_MS, type BoardRecord, readBoards, updateBoards } from '../lib/boards'
import type { Herdr } from '../lib/herdr'
import type { Run } from '../lib/types'

export interface BoardDeps {
  stateDir: string
  session: string
  pluginId: string
  workspaceId: string
  now: () => number
  hasStore: (slug: string) => Promise<boolean>
  herdr: Pick<Herdr, 'paneList' | 'paneShellPid' | 'paneClose' | 'pluginPaneOpen'>
}

/** Written before the pane is asked for, so `board.ts` recording itself always lands after it. */
export async function openBoard(slug: string, deps: Omit<BoardDeps, 'hasStore'>): Promise<void> {
  await updateBoards(deps.stateDir, deps.session, (boards) => {
    boards[slug] = { pane_id: null, shell_pid: null, opened_at_ms: deps.now() }
  })
  const opened = await deps.herdr.pluginPaneOpen(deps.pluginId, 'board', deps.workspaceId, {
    cwd: beadsHome(deps.stateDir, slug), env: { HPIPE_BEADS_SLUG: slug },
  })
  if (opened.ok) return
  console.error(`[pipeline] could not open the board for ${slug}: ${opened.code} ${opened.message}`)
  await updateBoards(deps.stateDir, deps.session, (boards) => {
    if (boards[slug]?.pane_id === null) delete boards[slug]
  })
}

async function isLive(board: BoardRecord, listed: ReadonlySet<string>, deps: BoardDeps): Promise<boolean> {
  if (board.pane_id === null) return deps.now() - board.opened_at_ms < BOARD_OPEN_GRACE_MS
  if (!listed.has(board.pane_id)) return false
  const shellPid = await deps.herdr.paneShellPid(board.pane_id)
  // Unknown is not dead: closing a pane that cannot be identified could close a live board.
  return shellPid === undefined || shellPid === board.shell_pid
}

/** Exactly one live board per repo with a live run in this session, and none for any other. */
export async function syncBoards(runs: readonly Run[], deps: BoardDeps): Promise<void> {
  const wanted = new Set<string>()
  for (const slug of new Set(runs.filter((r) => r.phase !== 'done').map((r) => beadsSlug(r.repo_key)))) {
    if (await deps.hasStore(slug)) wanted.add(slug)
  }
  const recorded = await readBoards(deps.stateDir, deps.session)
  const listed = new Set((await deps.herdr.paneList(deps.workspaceId)).map((pane) => pane.pane_id))

  for (const [slug, board] of Object.entries(recorded)) {
    if (wanted.has(slug)) continue
    if (board.pane_id !== null && listed.has(board.pane_id)) await deps.herdr.paneClose(board.pane_id)
    await updateBoards(deps.stateDir, deps.session, (boards) => { delete boards[slug] })
  }
  for (const slug of wanted) {
    const board = recorded[slug]
    if (board !== undefined && await isLive(board, listed, deps)) continue
    if (board?.pane_id != null && listed.has(board.pane_id)) await deps.herdr.paneClose(board.pane_id)
    await openBoard(slug, deps)
  }
}
```

- [ ] **Step 6: The board pane's own process, the action, and the manifest**

Create `src/board.ts`:

```ts
import { beadsExportPath, beadsHome } from './lib/beads-project'
import { boardLabel, updateBoards } from './lib/boards'
import { bvSpawnEnv } from './lib/bv'
import { Herdr } from './lib/herdr'
import { sessionKey } from './lib/session'
import { BV_INSTALL_HINT, bvBin } from './lib/tools'

async function main(): Promise<number> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const slug = process.env.HPIPE_BEADS_SLUG
  const paneId = process.env.HERDR_PANE_ID
  if (!stateDir || !slug) {
    console.error('[pipeline] the board needs HERDR_PLUGIN_STATE_DIR and HPIPE_BEADS_SLUG')
    return 1
  }
  if (paneId) {
    await new Herdr().paneRename(paneId, boardLabel(slug))
    // The pane's shell is this process's parent; a herdr restart brings the pane back
    // as a fresh shell under another pid, which is how the supervisor spots a ghost.
    await updateBoards(stateDir, sessionKey(), (boards) => {
      boards[slug] = { pane_id: paneId, shell_pid: process.ppid, opened_at_ms: Date.now() }
    })
  }
  if (Bun.which(bvBin()) === null) {
    console.error(`[pipeline] bv is not installed — ${BV_INSTALL_HINT}`)
    return 1
  }
  const bv = Bun.spawn([bvBin(), '--db', beadsExportPath(stateDir, slug)], {
    cwd: beadsHome(stateDir, slug), env: bvSpawnEnv(stateDir, slug),
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  return bv.exited
}

if (import.meta.main) process.exit(await main())
```

Create `src/actions/board.ts`:

```ts
import { beadsSlug, readBeadsProject } from '../lib/beads-project'
import { readBoards, updateBoards } from '../lib/boards'
import { loadConfig } from '../lib/config'
import { Herdr } from '../lib/herdr'
import { repoContext } from '../lib/repo'
import { sessionKey } from '../lib/session'
import { ensureWorkspace } from '../startup'
import { openBoard } from '../supervisor/boards'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
if (!stateDir || !configDir) process.exit(0)

const repo = await repoContext()
if (!repo) {
  console.error('[pipeline] "Open board" must be invoked from a pane inside a git repository')
  process.exit(1)
}
const slug = beadsSlug(repo.repoKey)
if ((await readBeadsProject(stateDir, slug)) === null) {
  console.error('[pipeline] this repo has no Beads store yet — run "Set up Beads for this repo" first')
  process.exit(1)
}

const session = sessionKey()
const config = await loadConfig(configDir)
const herdr = new Herdr()
const workspaceId = await ensureWorkspace(herdr, stateDir, session, config.PIPELINE_WORKSPACE_LABEL)
if (!workspaceId) {
  console.error('[pipeline] could not resolve the pipeline workspace')
  process.exit(1)
}

const recorded = (await readBoards(stateDir, session))[slug]
if (recorded?.pane_id) await herdr.paneClose(recorded.pane_id)
await updateBoards(stateDir, session, (boards) => { delete boards[slug] })
await openBoard(slug, { stateDir, session, pluginId, workspaceId, now: Date.now, herdr })
console.log(`[pipeline] board opened for ${slug}`)
```

In `herdr-plugin.toml`, insert after the `beads-setup` action:

```toml

[[actions]]
id = "board"
title = "Open board"
contexts = ["pane"]
command = ["bun", "run", "src/actions/board.ts"]
```

and append after the `supervisor` pane:

```toml

[[panes]]
id = "board"
title = "Board"
placement = "tab"
command = ["sh", "-c", "bun run src/board.ts; exec \"${SHELL:-/bin/sh}\""]
```

- [ ] **Step 7: Spare boards at startup, and keep them in the supervisor's tick**

In `src/startup.ts`, add the import:

```ts
import { isBoardLabel, readBoards } from './lib/boards'
```

insert below `const workspaceIdPath = …`:

```ts
export async function readWorkspaceId(stateDir: string, session: string): Promise<string | null> {
  const recorded = Bun.file(workspaceIdPath(stateDir, session))
  if (!(await recorded.exists())) return null
  const id = (await recorded.text()).trim()
  return id.length === 0 ? null : id
}
```

replace `clearStrayPanes` (lines 128-139) with:

```ts
/**
 * Clears the shell pane `workspace create` opens alongside the supervisor. It must
 * run AFTER the supervisor pane exists: closing a workspace's last pane destroys
 * the workspace, so clearing it at creation time deletes the very workspace the
 * supervisor was about to open into. Boards are spared by label — `Board` before
 * `board.ts` renames itself — and by record, so the supervisor's first tick may
 * open one before this runs.
 */
export async function clearStrayPanes(
  herdr: Herdr, workspaceId: string, keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const panes = await herdr.paneList(workspaceId)
  if (panes.length <= 1) return []

  const closed: string[] = []
  for (const pane of panes) {
    if (pane.label === SUPERVISOR_LABEL || isBoardLabel(pane.label) || keep.has(pane.pane_id)) continue
    await herdr.paneClose(pane.pane_id)
    closed.push(pane.pane_id)
  }
  return closed
}
```

and in `main()`, change:

```ts
  const strays = await clearStrayPanes(herdr, workspaceId)
```

to:

```ts
  const boardPanes = Object.values(await readBoards(stateDir, session))
    .map((board) => board.pane_id).filter((id): id is string => id !== null)
  const strays = await clearStrayPanes(herdr, workspaceId, new Set(boardPanes))
```

In `src/supervisor/main.ts`, add the imports:

```ts
import { readWorkspaceId } from '../startup'
import { syncBoards } from './boards'
```

(`crashLogPath, reapSupervisorSiblings` already come from `'../startup'`; extend that import), and in
the reconciler block Task 8 added, after the `await syncBeads(syncRuns, { … })` call and still inside
its `try`, add:

```ts
        const pipelineWorkspace = await readWorkspaceId(stateDir, session)
        if (pipelineWorkspace !== null) {
          await syncBoards(syncRuns, {
            stateDir, session, pluginId, workspaceId: pipelineWorkspace, now: Date.now,
            hasStore: async (slug) => (await readBeadsProject(stateDir, slug)) !== null,
            herdr,
          })
        }
```

- [ ] **Step 8: Run them to verify they pass**

Run: `bun test test/board.test.ts test/herdr.test.ts test/startup.test.ts test/prompts.test.ts`
Expected: PASS (`prompts.test.ts` checks the new action's script exists).

- [ ] **Step 9: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add src/lib/herdr.ts src/lib/boards.ts src/supervisor/boards.ts src/board.ts src/actions/board.ts src/startup.ts \
  src/supervisor/main.ts herdr-plugin.toml test/board.test.ts test/herdr.test.ts test/startup.test.ts
git commit -m "feat: a bv board tab per repo with a live run, kept by the supervisor

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---
### Task 14: Docs — the orchestrator's prompts, the skill, the README

`CHANGELOG.md` is release-please's and is not touched.

**Files:**
- Modify: `prompts/intake.md` (whole file), `prompts/dispatch.md:51-59`, `prompts/dispatch-registering.md` (whole file),
  `prompts/branch-review.md:7-10`
- Modify: `skills/herdr-pipeline/SKILL.md:3,10,35-57`, tables at `:66-73` and `:77-86`
- Modify: `README.md:6-13,29-30,52-57,118-128,145,161-163`, new `## Beads` section after `## Review tiers`,
  `:181-189` (Upgrading), Getting-out table rows
- Test: `test/prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/prompts.test.ts`, in `test('the dispatch prompt names every header line a dispatching task prints'`,
change `'issue:'` to `'bead:'` in the `for (const line of [...])` list, and change the comment line
`// Named rather than counted: \`issue:\` appears only when --title filed one, and` to
`// Named rather than counted: \`bead:\` appears only when --title filed one, and`.

Append:

```ts
test('intake and registration start from the backlog, adopt with --bead, and never run bd or bv', async () => {
  for (const name of ['intake', 'dispatch-registering']) {
    const text = prose(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text())
    expect(text, name).toContain('{{hpipe}} next')
    expect(text, name).toContain('--bead <id>')
    expect(text, name).toContain('--acceptance-file <path>')
    expect(text, name).toContain('Never run `bd` or `bv` yourself')
    expect(text, name).toContain('know nothing about files')
    expect(text, name).not.toContain('gh issue')
    expect(text, name).not.toContain('--issue')
  }
  const intake = prose(await Bun.file(join(ROOT, 'prompts', 'intake.md')).text())
  expect(intake).toContain('`bead: <id> (filed)`')
  expect(intake).toContain('{{hpipe}} bead show <id>')
})

test('dispatch says the bead\'s captured brief is the brief, and that dispatch claims the bead', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text())
  expect(text).toContain('the bead\'s brief, captured at registration, is the brief')
  expect(text).toContain('claims the task\'s bead first')
  expect(text).not.toContain('issue')
})

test('the branch review finds the run\'s PRs in the ledger, not by searching GitHub issues', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'branch-review.md')).text())
  expect(text).toContain('`{{hpipe}} show --task <id>` prints each task\'s `pr:`')
  expect(text).not.toContain('gh pr list')
})

test('the skill teaches the Beads commands and the rule against running bd', async () => {
  const skill = await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text()
  for (const needle of [
    'hpipe next', 'hpipe bead show <id>', '--bead <id>', '--prefix', 'hpipe escalate --task',
    'hpipe discoveries --file', 'hpipe close --task', 'Never run `bd` or `bv` yourself',
  ]) {
    expect(skill, needle).toContain(needle)
  }
  expect(skill).not.toContain('GitHub issue')
  expect(skill).not.toContain('--issue')
})

test('the README documents Beads setup, backups, the br warning and bv\'s licence rider', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  for (const needle of [
    '## Beads', 'brew install beads', 'brew install dicklesworthstone/tap/bv', 'Set up Beads for this repo',
    'hpipe start --prefix', 'Back up `$HERDR_PLUGIN_STATE_DIR/beads`', 'Never install `br`', 'Open board',
    '"Restricted Parties" means OpenAI, L.L.C.; Anthropic, PBC;',
    'https://github.com/Dicklesworthstone/beads_viewer/blob/main/LICENSE',
  ]) {
    expect(readme, needle).toContain(needle)
  }
  expect(readme).not.toContain('--issue <n>')
  expect(readme).not.toContain('gh issue create')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/prompts.test.ts`
Expected: FAIL — the new needles are missing.

- [ ] **Step 3: Rewrite `prompts/intake.md`**

Replace the whole file with:

````markdown
# Intake — {{title}} ({{run_id}})

You are the orchestrator. Intake is yours: understand the problem, cut it into tasks, back each task
with one bead, and register them. You do **not** write specs or plans — each worker researches, specs
and plans its own bead.

1. **Understand the problem first.** If the user handed you a report, verify it against the code
   before you decompose: the files that actually own the behaviour, what already exists, what is
   really broken. A task cut from an unverified report sends a worker down a path nobody checked.

2. **Cut it into tasks** that can be worked independently. Two tasks that must touch the same file
   are serialized, not parallel — say so with `--files` (the plugin holds the second one until the
   first lands) or with `--depends-on` when the second genuinely needs the first's result. App tasks
   depend on the `core` task that builds what they consume.

3. **Back every task with one bead, no exceptions.** Start from the backlog: `{{hpipe}} next` ranks
   this repo's open beads that no live task holds, by what each unblocks, grouped into tracks that
   share no dependency. Adopt one that fits with `--bead <id>`, and file new work only for what the
   backlog does not already hold; `{{hpipe}} bead show <id>` reads a bead. A new bead's body is the
   worker's entire brief: the goal, the constraints, and `file:line` pointers to where the work
   belongs, with the acceptance criteria in a file of their own. The brief is captured when the task
   is registered — the worker reads that snapshot, never your message and never a later edit to the
   bead. Never run `bd` or `bv` yourself.

4. **Register each one:**

       {{hpipe}} task --branch <branch> --bead <id> --surface <surface> \
                  [--tier light|standard|heavy] \
                  [--depends-on <id,id>] [--files <prefix,prefix>] \
                  [--notes "<batch context that does not belong in the bead>"]

   Not in the backlog yet? `--title "<title>" --body-file <path> [--acceptance-file <path>]` in
   place of `--bead <id>` files the bead with that brief and registers it in one step, and prints
   `bead: <id> (filed)`. The body file is the same brief step 3 asks for — write it just as carefully.

   Tracks from `{{hpipe}} next` share no dependency, but they know nothing about files: two tasks
   that touch the same files still serialize with `--files`, whichever tracks they came from.

   `--tier` decides which reviews the task runs. `light` skips `plan-review` and gets one combined
   PR review; `standard` keeps `plan-review` and the combined PR review; `heavy` runs every review,
   with the PR reviewed in two separate stages. Pick it from the brief:

   - **light** — one surface, a handful of files, and the brief already pins down the exact change:
     no API, contract or schema decision left open.
   - **heavy** — changes a contract another surface consumes, migrates data, touches security or
     auth, concurrency, or state-machine code; or you are not sure.
   - **standard** — everything else.

   When unsure, pick the higher tier: under-review is the costly mistake. With no `--tier` a task is
   `standard`, and a bead labelled `pipeline:tier-<name>` overrides `--tier`. Never lower a tier
   once the task is running; a worker or a decision that finds it too low raises it.

   `--surface` routes the worker to `.claude/agents/<surface>-dev.md` and is rejected if no such file
   exists. `--files` and `--depends-on` are **comma-separated**: a value containing whitespace is
   rejected, and repeating either flag adds to it rather than replacing it. `{{hpipe}} task` prints the
   task id, then a `tier:` line naming the tier it recorded and why, then a `files:` line echoing
   exactly what it recorded (or `files: none`) — check both say what you meant — and then either the
   worker brief to dispatch or `queued: waiting on …`, which is correct, and you will be told when
   that task is ready. A brief to dispatch comes with a `base: <commit> (…)` line: cut that task's
   worktree from that commit (`herdr worktree create … --base <commit>`), never from your local
   `main`, which is only as new as your last pull. Under it, `dispatch, in order:` lists the whole
   dispatch with that commit already filled in — worktree, bootstrap,
   `agent start … -- --dangerously-skip-permissions`, `dispatch --task` — so run it as printed,
   filling in the pane and path the create response returns.

5. **When the last task is registered, close intake:**

       {{hpipe}} dispatch --done

   Nothing infers that you are finished. Until you run it the run cannot complete, and the supervisor
   keeps a finished batch open waiting for a task you were never going to add.

Register every task, close intake, then stop.
````

- [ ] **Step 4: `dispatch.md`, `dispatch-registering.md`, `branch-review.md`**

In `prompts/dispatch.md`, replace lines 51-59 (from `The brief is rendered for that task` through
`` `agent start`. ``) with:

```markdown
The brief is rendered for that task and carries the bead id, the brief captured at registration, the
surface, the artifact paths the supervisor watches and the task id the worker needs for
`{{hpipe}} decide`. Do not summarise it or send the worker task text of your own: the bead's brief,
captured at registration, is the brief, and anything you say here instead of in it is lost. The copy
you were shown is for you to read; `dispatch --task` sends its own, and claims the task's bead first —
if bd refuses the claim, nothing is sent and the refusal says why. When it came from `{{hpipe}} task`,
the header lines above it — `task_id:`, `tier:`, `bead:` when it filed one, `files:`, `bootstrap:`,
`base:` and the `dispatch, in order:` block — are yours: confirm the `tier:` and `files:` lines match
what you declared, then run the block, which cuts the worktree from the `base:` commit and runs what
`bootstrap:` names in the new checkout before `agent start`.
```

Replace `prompts/dispatch-registering.md` with:

```markdown
**Still registering?** Every new task is backed by a bead — run `{{hpipe}} next` and adopt one where
it fits:

    {{hpipe}} task --branch <branch> --bead <id> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] \
               [--notes "<batch context that does not belong in the bead>"]

or let `--title "<title>" --body-file <path> [--acceptance-file <path>]` in place of `--bead <id>`
file one with that brief and register it in one step. There is no `--text` flag: whatever the worker
needs goes in the bead's brief. Never run `bd` or `bv` yourself. Never run two agents against the
same files in parallel — serialize them with `--files`, or with `--depends-on` when one needs the
other's result; tracks from `{{hpipe}} next` share no dependency, but they know nothing about files.

**When the last task is registered:**

    {{hpipe}} dispatch --done

Nothing infers that the batch is complete, and the run cannot finish until you say so.
```

In `prompts/branch-review.md`, replace lines 7-10 (from `There is no run-level spec` through
`contracts the work claimed to fulfil.`) with:

```markdown
There is no run-level spec to review against: each task carried its own, on its own branch. Start
from this run's merged PRs — `{{hpipe}} show --task <id>` prints each task's `pr:` — and read each
one's spec and plan under `docs/superpowers/specs/` and `docs/superpowers/plans/`. Those are the
contracts the work claimed to fulfil.
```

- [ ] **Step 5: The skill**

In `skills/herdr-pipeline/SKILL.md`, change line 3's `a batch of GitHub issues` to
`a batch of Beads issues (beads)`, add `next, bead show, escalate, discover, discoveries, close` to the
command list in its parentheses (after `forget`), and change line 10's `The plugin turns a batch of
issues into` to `The plugin turns a batch of beads into`.

Replace lines 35-50 (step 1 and step 2 of "Running a batch") with:

```markdown
1. `hpipe start "<title>" [--prefix <p>]` — the first start in a repo sets up its Beads store (needs
   `bd` ≥ 1.3.1) and prints the intake prompt. Follow it.
2. One bead per task; **the bead's brief is the worker's entire brief** (goal, acceptance criteria,
   `file:line` pointers), captured when the task is registered. Check the backlog first: `hpipe next`
   ranks open beads no live task holds by what they unblock, and `hpipe bead show <id>` reads one.
   Register: `hpipe task --branch <b> --bead <id> --surface <s> [--depends-on t1,t2] [--files a/,b/c.ts]`
   — or `--title "<t>" --body-file <path> [--acceptance-file <path>]` instead of `--bead` to file a
   new bead in the same step; it prints `bead: <id> (filed)`. Never run `bd` or `bv` yourself.
   `--files` / `--depends-on` are comma-separated, no spaces. `--files` are path prefixes: two tasks
   whose prefixes overlap never implement at the same time (the second waits in `blocked-on-files`),
   so to keep a task off t3's files, declare prefixes overlapping t3's. Plans can widen them later.
   `hpipe next`'s tracks share no dependency but know nothing about files, so they never replace `--files`.
   Pick a tier with `--tier light|standard|heavy` (default `standard`). **light**: one surface, a
   handful of files, the brief pins the exact change. **heavy**: a contract another surface
   consumes, a data migration, security/auth, concurrency or state-machine code — or you are
   unsure. **standard**: the rest. When unsure, go higher. A `pipeline:tier-<name>` bead label
   overrides `--tier`; two tier labels are refused. The `tier:` line under `task_id:` says what was
   recorded and why. light skips `plan-review`; light and standard get one combined `pr-review`;
   heavy runs `pr-review-intent` then `pr-review-quality`.
```

In step 3, after `` `hpipe dispatch --task <id> --pane <root pane>`, which submits the brief and confirms it landed. ``
add the sentence `It claims the task's bead first; if bd refuses, nothing is sent.`

In the "While it runs" table, replace the row starting `| A decision only the owner can make` with:

```markdown
| A decision only the owner can make (product, licence, scope) | Relay question + worker's recommendation + yours to the user, and run `hpipe escalate --task <id> --decision <d> --recommend "…"` so its bead shows blocked on them; record their reply with `--by human` |
```

and add after the `| "Ready to merge — PR #n" |` row:

```markdown
| Workers recorded out-of-scope work (`hpipe discover`) | At branch review: `hpipe discoveries` lists it, `hpipe discoveries --file` files it as beads |
```

In the "Recovery" table, add after the `| Task blocked behind a failed sibling's `--files` |` row:

```markdown
| A task sits in `close` and status shows its bead out of sync | Fix what bd's error names, or `hpipe close --task <id>` (`--force` only to override bd's close guards) |
| `hpipe start` refuses on bd's version | `brew upgrade beads` (the user's call — ask first); bd ≥ 1.3.1 is required |
```

- [ ] **Step 6: The README**

Replace lines 6-13 (the two paragraphs from `One **worker** agent owns each GitHub issue` through
`escalates the rest to you with a recommendation already formed.`) with:

```markdown
One **worker** agent owns each bead end to end: research → spec → adversarial review → plan →
adversarial review → implement → PR review → CI → merge → close → teardown, with the reviews a task
runs set by its **tier** (below). The **orchestrator** keeps intake (pick or file the bead, dispatch),
decision triage, merge, and the whole-branch review at the end. The backlog lives in
[Beads](https://github.com/gastownhall/beads), one database per repo (see **Beads** below); GitHub
keeps the PRs, CI and merges.

Workers surface **decisions, not drafts**. When one hits a choice it should not make alone, it calls
`hpipe decide` with a question *and a recommendation*; the orchestrator answers what it can from the
brief or the existing code, and escalates the rest to you with a recommendation already formed.
```

Replace lines 29-30:

```markdown
Requires herdr 0.9.0+, bun, and gh. No build step, and no runtime dependencies —
`@types/bun` and `typescript` are devDependencies for `bun run typecheck` only.
```

with:

```markdown
Requires herdr 0.9.0+, bun, gh, and `bd` 1.3.1+ (`brew install beads`); `bv` 0.25.2+ for the board
and `hpipe next` (see **Beads** below). No build step, and no runtime dependencies — `@types/bun` and
`typescript` are devDependencies for `bun run typecheck` only.
```

In the actions table, add after the `| Drain pending events | force a queue drain |` row:

```markdown
| Set up Beads for this repo | create the repo's Beads store (run from a pane in the repo) |
| Open board | reopen the repo's `bv` board tab |
```

Replace lines 118-128 (from `The orchestrator is then prompted to research the work, open one GitHub issue per task`
through `passed, and registers the task under the new number.`) with:

```markdown
The first `hpipe start` in a repo sets up its Beads store. The orchestrator is then prompted to
research the work, run `hpipe next` over the repo's backlog, and back each task with one bead —
**the bead's brief, captured when the task is registered, is the worker's brief** — registering each
with:

    hpipe task --branch <branch> --bead <id> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] [--notes <batch context>] \
               [--run <run-id>]

Work the backlog does not hold yet is filed and registered in one step: `--title <title>
--body-file <path> [--acceptance-file <path>]` in place of `--bead <id>` creates the bead after every
other check has passed, and registers the task under its id.
```

In the `hpipe show` table row (line 145), change `branch, issue, surface` to `branch, bead, surface`,
and add a row after the `hpipe brief` row:

```markdown
| `hpipe bead show <id>` | A bead as Beads holds it now: status, labels, description, acceptance, comments |
| `hpipe next [--limit <n>] [--label <label>]` | The unheld beads `bv` ranks claimable now (parallel when their `--files` are disjoint), then the later dependency layers that wait on them |
```

In "Review tiers", change (lines 161-163):

```markdown
`standard`. An issue labelled `pipeline:tier-light`, `pipeline:tier-standard` or `pipeline:tier-heavy`
overrides `--tier`, and an issue carrying two tier labels is refused. Labels are read once, at
```

to:

```markdown
`standard`. A bead labelled `pipeline:tier-light`, `pipeline:tier-standard` or `pipeline:tier-heavy`
overrides `--tier`, and a bead carrying two tier labels is refused. Labels are read once, at
```

Insert a new section immediately before `## Models`:

```markdown
## Beads

Each repo's backlog is its own [Beads](https://github.com/gastownhall/beads) database, kept in the
plugin's state dir at `$HERDR_PLUGIN_STATE_DIR/beads/<repo>-<hash>/` — never in your repo, and out of
reach of every worker worktree. hpipe is its only writer: every write runs as actor `hpipe`, one call
at a time under a lock, and the supervisor converges each bead to what the run's ledger says — claimed
while its task is worked, blocked while a decision waits on you, released if the task is abandoned or
the run aborted, closed once its PR merges.

**Install** `bd` 1.3.1 or newer (`brew install beads`; older releases lack the close guards this
relies on) and, for the board and `hpipe next`, `bv` 0.25.2 or newer
(`brew install dicklesworthstone/tap/bv` — read its licence first, below). `BD_BIN` / `BV_BIN` point
at other binaries. `hpipe start` refuses without a working `bd`; without `bv` the pipeline runs and
only the board and `hpipe next` are off. `hpipe status` prints a `tools:` line when either is missing
or too old.

**Setup** happens on the first `hpipe start` in a repo, or on demand with the **Set up Beads for this
repo** action from a pane in it. Bead ids are `<prefix>-<n>`; the prefix defaults to the repo's name
cut to eight characters. `hpipe start --prefix <p>` picks another (for the action, set
`HPIPE_BEADS_PREFIX`). Setup refuses a prefix another repo's store already uses, and one whose
`<prefix>-<n>` names already appear under `docs/superpowers/`.

**Back up `$HERDR_PLUGIN_STATE_DIR/beads`.** It is the only copy of every backlog, and it cannot be
rebuilt from the repo: set up again, a store restarts its counter at `<prefix>-1`.

**Do not run `bd` yourself while a run is live.** The store takes one writer at a time and a second
fails fast; read a bead with `hpipe bead show <id>` instead.

**The board.** Each repo with a live run gets a `Board: <repo> <hash>` tab in the pipeline
workspace, running `bv` on the export hpipe writes after every change; press `b` for the kanban. The
**Open board** action reopens it. It is read-only by construction. **Never install `br` alongside
`bv`**: bv's edit path shells out to `br`, which would write to the store behind hpipe's back; with
no `br` installed that path fails harmlessly.

**bv's licence.** bv is MIT-licensed with a rider. Its
[LICENSE](https://github.com/Dicklesworthstone/beads_viewer/blob/main/LICENSE) says, among other things:

> "Restricted Parties" means OpenAI, L.L.C.; Anthropic, PBC; any of their respective Affiliates; and
> any person or entity acting directly or indirectly on behalf of, for the benefit of, or under the
> direction of any of the foregoing (including any officer, director, employee, contractor, agent,
> consultant, service provider, or representative).
>
> Notwithstanding any other provision of this License, no rights are granted to any Restricted Party.
>
> You may not provide, disclose, distribute, sublicense, sell, lease, lend, host, make available, or
> otherwise permit access to the Software or any derivative work of the Software (as defined in
> applicable copyright law) (collectively, "Derivative Works") to or for any Restricted Party.
>
> For purposes of this rider, "use" includes, without limitation: copying, modifying, merging,
> publishing, distributing, sublicensing, selling, transferring, making available, hosting,
> deploying, executing, benchmarking, testing, analyzing, indexing, or incorporating the Software or
> any Derivative Works into any dataset, training corpus, evaluation harness, or pipeline for machine
> learning or other automated systems.

Read the whole licence and judge for yourself whether the rider applies to you — `hpipe next` runs
`bv` on an agent's behalf — before you install it. This plugin vendors and forks none of bv's code; it
only runs the binary you install, and everything but the board and `hpipe next` works without it.
```

In "Upgrading", append after its paragraph:

```markdown

The Beads release moves the ledger to `schema_version: 3`. Runs started before it are not migrated
and are no longer advanced: finish them on the previous release, then upgrade and restart the
supervisor. They do not block `hpipe start`.
```

In the "Getting out" table, change the row:

```markdown
| A run from an older plugin version | It is refused, not migrated. `hpipe abort <id>` to release the repo |
```

to:

```markdown
| A run from an older plugin version | It is not migrated or advanced, and does not block `hpipe start`. Finish it on the release that started it, or `hpipe abort <id>` |
| A task's bead will not close | `hpipe status` shows bd's error once it has failed five times; fix that, or `hpipe close --task <id>` (`--force` only to override bd's close guards) |
```

- [ ] **Step 7: Run them to verify they pass**

Run: `bun test test/prompts.test.ts`
Expected: PASS (including the older README and skill needles: `## Review tiers`, `pipeline:tier-light`,
`Restart the supervisor after upgrading`, `There is nothing else to install`, `bin/hpipe`).

- [ ] **Step 8: Typecheck, the whole suite, commit**

Run: `bun test && bun run typecheck` — all green.

```bash
git add prompts/intake.md prompts/dispatch.md prompts/dispatch-registering.md prompts/branch-review.md \
  skills/herdr-pipeline/SKILL.md README.md test/prompts.test.ts
git commit -m "docs: Beads in the orchestrator's prompts, the skill and the README

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

### Task 15: The live smoke runbook section

**Files:**
- Modify: `test/integration/smoke.md` (new section `## 8. Beads — the issue store`, inserted before
  `## What to do when a step fails`)

This is a document for a human-run live smoke; it has no unit test.

- [ ] **Step 1: Confirm no test reads the runbook**

Run: `grep -rn "smoke.md" test/*.ts`
Expected: no output (`test/smoke.test.ts` only checks that the types module loads).

- [ ] **Step 2: Add the section**

Insert before the line `## What to do when a step fails`:

````markdown
## 8. Beads — the issue store

Runs on **bd ≥ 1.3.1** and **bv ≥ 0.25.2**, installed by you (the board and `hpipe next` steps run
the real `bv`; an agent does not run it — see the README's licence note). Use a scratch repo with
a GitHub remote and CI, as in Setup, and a fresh herdr session.

### 8a. Setup

    bd version && bv --version
    cd <scratch repo> && hpipe start "beads smoke" --prefix bsm

Expect `beads: created <state>/beads/<repo>-<hash> with prefix bsm`, then the intake prompt.
Check: `ls <state>/beads/<repo>-<hash>/` holds `.beads/`, `project.json`; `.beads/issues.jsonl`
exists; `git -C <state> status` is unchanged if the state dir sits in a repo. A `Board: <repo> <hash>`
tab appears in the pipeline workspace within a tick or two.

### 8b. One task to close

    printf 'Add a NOTES.md line saying hello.\n' > /tmp/bsm-body.md
    printf 'NOTES.md contains hello.\n' > /tmp/bsm-acc.md
    hpipe task --branch smoke/bsm-1 --title "Say hello" --body-file /tmp/bsm-body.md \
      --acceptance-file /tmp/bsm-acc.md --surface core --tier light

Expect `bead: bsm-1 (filed)`. `hpipe bead show bsm-1` shows `[open]` with label
`hpipe:run=<run>`, `phase:research` after the supervisor's next pass. Run the printed
`dispatch, in order:` block; after `hpipe dispatch --task t1`, `hpipe bead show bsm-1` shows
`[in_progress]`, assignee `hpipe`. On the board (watch it, press `b`): the card moves to
in-progress and its `phase:` label follows the task through `spec`, `plan`, `implement`.

Merge the PR when prompted. Within a tick or two: `hpipe bead show bsm-1` shows `[closed]` with
the reason `merged in PR #<n> (<sha>)`; the task moves `close → teardown → done`; the board moves the
card to closed.

### 8c. `hpipe next`

    hpipe task --branch smoke/bsm-2 --title "Second" --body-file /tmp/bsm-body.md --surface core
    hpipe next

Expect the warning lines (if any metric was not `computed`), then one track whose `top:` is **not**
`bsm-2` (it is held by t2) — with only bsm-2 open, `nothing to pick up: …`.

### 8d. Abort releases, resume re-claims

    hpipe abort <run-id>

Within a tick or two: `hpipe bead show bsm-2` shows `[open]`, no assignee, label `phase:aborted`,
and `hpipe next` now offers `bsm-2`.

    hpipe resume <run-id>

Within a tick or two `bsm-2` is `[in_progress]`, assignee `hpipe`, `phase:<its phase>` again, and
`hpipe next` drops it.

### 8e. Teardown

`hpipe abort <run-id>`; close the scratch PRs; `rm -rf <state>/beads/<repo>-<hash>` only if this was
a throwaway store.

### Findings — Beads

| Step | Result | Notes |
|---|---|---|
| 8a setup, board tab appears | | |
| 8b claim on dispatch, phase labels on the board | | |
| 8b close on merge, teardown follows | | |
| 8c `hpipe next` hides the held bead | | |
| 8d abort releases, resume re-claims | | |
````

- [ ] **Step 3: Run the suite**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/integration/smoke.md
git commit -m "docs: live smoke steps for the Beads issue store

Claude-Session: https://claude.ai/code/session_017f4SJJZw1f2CKvKgL49PEJ"
```

---

## Spec coverage

| Spec section | Task(s) |
|---|---|
| Header: on-disk format change, version floor | 5 (schema v3, `runForRepo`), 2 (`BD_MIN_VERSION`), 4 (start refuses), 14 (README Upgrading), 15 (smoke on ≥ 1.3.1) |
| Decisions 1–9 | 1–13 as below; 7 (agents never run bd) in 11, 14; 8 (only hpipe exports) in 2, 11, 13 |
| §1 Layout, slug, prefix, project.json | 1 |
| §1 Git isolation (ceiling on every spawn, guard without it) | 1 (`beadsSpawnEnv`), 4 (`insideGitWorkTree`) |
| §1 Init commands, triggers, setup action | 2 (`initStore`), 4 |
| §1 Binaries, version checks, `tools:` line, startup warning | 2 (`tools.ts`), 4 |
| §1 Durability scan, backup advice | 1 (`prefixCollisions`), 4, 14 |
| §2 `Bd`: argv, env/cwd, stdout-only, 30 s kill, per-call lock, export, `export.dirty`, methods, `readExport` | 2 |
| §3 Ledger fields, schema v3, `runForRepo` | 5 |
| §3 Artifact stems, verdict prefix, display sites, tier label source, prompt variables | 5 |
| §3 Held predicate | 3 |
| §4 Filing `--title`/`--bead`, memoised, adoption refusals | 5 |
| §4 `hpipe next`, `hpipe bead show` | 11 |
| §4 Prompts (intake, dispatch, dispatch-registering, SKILL, README, worker-brief, the 10 review/phase templates) | 5 (templates rendering `{{issue}}`, `dispatch.md:44`), 14 (the rest) |
| §4 Dispatch claim | 7 |
| §4 Board columns (status + `phase:` label) | 6 (labels), 0 (spike 2) |
| §5 Reconciler: desired state, convergence, budget, failures, ledger writes | 6, 8 |
| §6 Decisions: no decision beads, `hpipe escalate`, "waiting on you", un-block, ruling comments, `decision.md` | 5 (`decision.md:15`), 6, 10 |
| §7 Discovered work | 12 |
| §8 PR body `Refs`, close on merge, why guards do not fire | 5 (prompts), 6, 8 |
| §8 Close row, signal, rewind clearing, stall variants, `hpipe close` | 5 (signal, rewind), 8 (sets the field), 9 |
| §8 Releases, branch review from the ledger | 6, 8, 14 |
| §9 Board pane, open, lifetime, cleanup, action, read-only | 13, 14 (README) |
| §10 Failure handling | 2 (timeout, busy, export), 4 (start refuses), 5 (create/show), 7 (claim), 8 (reconciler), 9 (close), 11 (`bv` missing, metrics), 13 (board hint) |
| §11 Verify before implementing | 0 |
| §12 Tests | 1–13 as each task names; `test/integration/smoke.md` in 15 |
| README and licence | 14 |
