# Beads as the issue store — design

Pass 1. Written against `main` at `31e6b2d`. Not yet reviewed.

GitHub Issues stops being hpipe's issue store. [Beads](https://github.com/gastownhall/beads) (`bd`,
v1.3.1) replaces it outright: one embedded Dolt database per project, kept in the plugin's state
dir, written only by hpipe code. [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)
(`bv`, v0.25.2) gives the human a live kanban/graph tab beside the supervisor and gives the
orchestrator a deterministic triage engine (`hpipe next`). `gh` stays for PRs, CI and merge.

**On-disk format change.** The ledger moves to `schema_version: 3` (`task.issue: number` becomes
`task.bead: string`). The supervisor already ignores runs whose schema it does not know
(`src/supervisor/main.ts:50-52,200-203`), so v2 runs are not migrated: finish or `hpipe forget` them
before upgrading, and restart the supervisor after.

## Evidence

Facts this design rests on, from the tools' sources at the tagged versions (cloned read-only on
2026-10-02):

| Fact | Source |
|---|---|
| Embedded mode (`bd init`) keeps data in `.beads/embeddeddolt/`, needs no `dolt` binary, and is documented single-writer | beads `docs/architecture/dolt.md` |
| The embedded store holds no lock outside `bd init`; concurrent processes rely on the Dolt driver | beads `internal/storage/embeddeddolt/store.go:151-153` |
| `BEADS_DIR` is authoritative: no walk-up if the named dir has no project | beads `internal/beads/beads.go:772` |
| A linked git worktree auto-discovers the main checkout's `.beads` through the git common dir | beads `docs/reference/worktrees.md` |
| Plain `bd init` writes AGENTS.md, Claude/Codex/Cursor files and git hooks into the repo, then `git commit`s them; `--skip-agents --skip-hooks --non-interactive` suppresses that | beads `cmd/bd/init.go:2093-2190` |
| Beads recommends one database per project, each with its own `--prefix`; there is no project field | beads `docs/reference/faq.md` |
| `issue_id_mode counter` gives sequential IDs (`hp-12`) instead of hashes | beads `docs/reference/configuration.md` |
| Issue types include `decision`; `bd human list/respond` works on issues labelled `human` | beads `internal/types/types.go`, `docs/workflows/gates.md` |
| `bd update --claim` atomically sets assignee + `in_progress`, idempotent for the same actor | beads `docs/cli-reference/update.md` |
| `export.auto` is throttled (60 s floor), so a fresh JSONL needs an explicit `bd export -o` | beads `cmd/bd/export_auto.go` |
| `bd export` writes atomically (temp + fsync + rename) | beads `cmd/bd/export.go` |
| In a Dolt-backed workspace bv runs `bd export` itself before every load, unless given an explicit file via `--db <file>` / `BEADS_DB` | bv `pkg/loader/loader.go:486-540`, `internal/datasource/load.go:161,241` |
| bv watches the JSONL's parent dir with fsnotify (Write/Create/Rename), 200 ms TUI debounce | bv `pkg/watcher/watcher.go:199-410` |
| bv's multi-repo workspace mode has no live reload | bv `cmd/bv/main.go:2714` |
| bv "claimable" = open, unblocked, unassigned, not deferred, not an epic | bv `pkg/analysis/triage.go`, `cmd/bv/robot_registry.go:2343` |
| `--robot-triage-by-track` groups recommendations by independent dependency track | bv `cmd/bv/robot_registry.go` |
| Every metric in robot output carries `status{state: pending|computed|timeout|skipped}`; a skipped cycle check proves nothing | bv README "Robot mode" |
| The TUI's `O` edit path shells out to `br update`, never `bd` | bv `pkg/ui/model.go:262-283,2455-2525` |
| bv's licence is MIT plus a rider barring OpenAI/Anthropic and anyone acting for their benefit; derivative works must carry it | bv `LICENSE` |

And hpipe today (all GitHub-issue touchpoints):

| Where | What |
|---|---|
| `src/lib/gh.ts:111-137` | `issueView`, `issueLabels`, `issueCreate` |
| `src/cli.ts:223-226,237-457` | filing and label reads in `registerTask` / `cmdTask` |
| `src/lib/tiers.ts:25-60` | `pipeline:tier-<name>` label override |
| `src/supervisor/main.ts:307-313`, `tasks.ts:393-410` | `issueView` wired into `TaskDeps`; merge snapshots `issueClosed`, close waits on it |
| `src/lib/machine.ts:229-251` | `issue_closed_at_entry`; close advances on `issueClosed && (atEntry || closedAtMs >= merged_at_ms)` |
| `src/supervisor/stall.ts:341-352` | stall clause tells the orchestrator to `gh issue view` / close by hand |
| `src/cli.ts:335-336`, `src/lib/verdict-path.ts:19-21` | artifact stems `…-issue-<n>` |
| `prompts/` | `intake`, `dispatch`, `dispatch-registering`, `worker-brief` (incl. the `Closes #N` rule at 67-71), `implement` (22-27), `research`, `spec`, `spec-review`, `pr-review`, `pr-review-intent`, `decision`, `close`, `branch-review` (8) |
| `skills/herdr-pipeline/SKILL.md` | "batch of GitHub issues", `--issue <n>`, tier label |
| `src/startup.ts:128-139` | `clearStrayPanes` closes every pipeline-workspace pane not labelled "Pipeline supervisor" |

## Decisions

1. **Replace, don't abstract.** Beads is the only issue backend. No `IssueBackend` interface, no
   per-repo switch; every prompt states one way to read a brief.
2. **One database per project.** A shared database with a `project:` label was rejected: every `bd`
   and `bv` call would need the filter, bv's PageRank/critical-path/tracks would score across
   projects, all projects would share one prefix, and one missed filter dispatches another repo's
   work. Beads recommends per-project. A shared Dolt server (`--shared-server`, one database per
   prefix) was deferred: it only buys concurrent writers, which the lock below makes unnecessary, and
   costs a server process plus a pinned `dolt` 2.2.0. It is an init flag, so adopting it later is
   not a redesign.
3. **The database lives in the plugin state dir**, not the repo:
   `$STATE/beads/<repo-slug>/.beads`. Worker worktrees cannot discover it, `bd init` cannot touch the
   repo, and the repo stays clean. Cost accepted: issues do not travel with the code, and bv's
   git-backed views (`--robot-diff`, `--robot-history`, `--as-of`) are unavailable.
4. **Writes are split by role, through one locked module.** The orchestrator's hpipe commands write
   content and lifecycle (create, claim, decision beads, rulings). The supervisor writes state it
   already owns (phase label, close on merge). Agents never invoke `bd` to write; the orchestrator
   agent reads only through `hpipe next`, `hpipe brief` and `bd show`.
5. **The supervisor closes the bead on merge.** GitHub auto-closed the issue on `Closes #N`; making
   the orchestrator do it adds a prompt round-trip and a stall mode for a mechanical step. This is
   the one write that is lifecycle rather than state, and is taken by the supervisor deliberately.
6. **Only hpipe exports.** bv is always launched with `--db <file>`, so it never runs `bd export`
   or opens Dolt; `export.auto` stays off.

## 1. Storage and setup

**Layout.** `$STATE` is `HERDR_PLUGIN_STATE_DIR` (fallback `~/.local/state/herdr/plugins/stein.pipeline`,
`src/cli.ts:1085-1086`).

```
$STATE/beads/<repo-slug>/
  .beads/                  bd workspace (embeddeddolt/, config.yaml, metadata.json)
  .beads/issues.jsonl      export read by bv
  hpipe.lock               the Bd module's lock
  project.json             { repo_root, prefix, created_at }
```

`<repo-slug>` is the repo root's basename plus a 6-char hash of the absolute `repo_root`
(`repoKey`, `src/lib/repo.ts:17-25`), so two clones of the same name do not collide. `project.json`
records `repo_root` so the slug is reversible for `status`.

**Prefix.** Defaults to a sanitised repo basename, truncated to 8 chars; overridable with
`--prefix`. Setup refuses a prefix already recorded in another `project.json` under
`$STATE/beads/`.

**Init.** Run with `cwd = $STATE/beads/<slug>` (not a git repo) and `BEADS_DIR` set:

```
bd init --prefix <p> --skip-agents --skip-hooks --non-interactive
bd config set issue_id_mode counter
bd config set status.custom ""          # none; see §4
```

`export.auto` is left at its default (off). Then one `bd export -o .beads/issues.jsonl` so bv has a
file to watch from the first second.

**Triggers.**
- `hpipe start` runs setup when `project.json` is absent for the repo, before `newRun`.
- A new herdr action **Set up Beads for this repo** (`src/actions/beads-setup.ts`) runs it on demand
  and accepts a prefix.
- `startup.ts` checks `bd version` ≥ 1.3.1 and `bv --version` ≥ 0.25.2 and logs a warning;
  `hpipe status` shows a `tools:` line when either is missing or too old. `hpipe start` refuses
  without `bd`; it proceeds without `bv` (no board tab, `hpipe next` errors with the install hint).

**Config.** New keys in `config.env` mirroring `GH_BIN` (`src/lib/config.ts:23,48,95`): `BD_BIN`
(default `bd`), `BV_BIN` (default `bv`). Code reads them from `config`, never from raw env — the
existing `cli.ts:223-226` `new Gh(undefined, …)` bypass of `config.GH_BIN` is not repeated.

## 2. The `Bd` module

`src/lib/bd.ts`, a class shaped like `Gh` (`src/lib/gh.ts:35-55`): binary from config, every call
with `env.BEADS_DIR = <slug>/.beads`, `cwd = <slug>`, `--json`, `--actor <actor>`. A spawn failure
returns code -1 the way `Gh.run` does.

**Lock.** Every call — read or write — holds an exclusive lock on `<slug>/hpipe.lock`, with a 10 s
acquire timeout. The lock is advisory between hpipe processes only (CLI invocations and the
supervisor); it makes the undocumented two-process behaviour of embedded Dolt irrelevant. Bun has no
`flock` binding, so the lock reuses the `src/lib/pidfile.ts` primitive (exclusive create + holder
pid + start time), and a holder whose pid is dead or whose start time no longer matches is reclaimed
the way the supervisor reclaims a stale pid file (`src/supervisor/main.ts:94-110`).

**Export after write.** Each public write method runs its `bd` command(s) and then
`bd export -o <slug>/.beads/issues.jsonl` inside the same lock hold. A failed export is logged and
sets `<slug>/export.dirty`; the next `Bd` write or supervisor tick that sees the marker re-exports
and clears it. The board can lag; the ledger never depends on the export.

**Methods** (each returns a typed result or a `BdFailure`):

| Method | `bd` call | Caller |
|---|---|---|
| `create({title, bodyFile, acceptanceFile?, labels, parent?, type?})` | `create --title --body-file [--acceptance] -l … [--parent] [-t]` | `hpipe task`, decision escalation, `discoveries --file` |
| `show(id)` | `show <id> --include-comments` | `hpipe task --bead`, tier read, `brief` refresh |
| `claim(id)` | `update <id> --claim` | `hpipe dispatch` |
| `setStatus(id, status)` | `update <id> -s <status>` | decision escalate/answer |
| `setPhase(id, row)` | label swap: `update <id> --remove-label phase:<old> --add-label phase:<new>` (or `set-state`, §11) | supervisor |
| `comment(id, file)` | `comment <id> --file <f>` | `hpipe answer --by orchestrator` |
| `depAdd(from, to)` | `dep add <from> <to>` | `hpipe task --depends-on` |
| `close(id, reason)` | `close <id> -r <reason>` | supervisor on merge; `hpipe close` |
| `export()` | `export -o …` | internal |

Actors: `hpipe:orchestrator` for CLI writes, `hpipe:supervisor` for supervisor writes, so
`bd history` shows which layer did what.

## 3. Ledger changes (`schema_version: 3`)

In `src/lib/types.ts`:

- `Task.issue: number` → `Task.bead: string`.
- `Task.issue_closed_at_entry` → removed (a bead cannot be closed by anything but hpipe; see §6).
- New `Task.brief: { title, description, acceptance, labels, captured_at_ms }` — snapshot of the
  bead at registration.
- New `Task.bead_synced_row: string | null` — last phase row written to the bead's label.
- New `Task.bead_closed_at_ms: number | null`.
- New `Task.discoveries: { title, body_path, recorded_at_ms }[]` (§7).
- `Run.schema_version` → 3 (`src/lib/ledger.ts:40`), checked at `src/supervisor/main.ts:50-52`.

Artifact stems: `${date}-issue-${issue}` (`src/cli.ts:335-336`) → `${date}-${bead}`; verdict prefix
`issue-${task.issue}` (`src/lib/verdict-path.ts:19-21`) → `${task.bead}`. Display sites that render
`#${task.issue}` (`status.ts`, `tick.ts`, `deliver.ts`, `awaiting.ts`, `tasks.ts:221`) render the
bead ID. Template var `{{issue}}` is renamed `{{bead}}` (`tasks.ts:118,594`, `worker-prompt.ts:23`).

**Tier override.** `src/lib/tiers.ts` reads the `pipeline:tier-<name>` label from `Bd.show(id)`
instead of `gh issue view --json labels`. Same label, same precedence.

**v2 runs.** Not migrated. `hpipe status` lists any v2 run file it finds under a "needs forget"
heading with the `hpipe forget` command; `hpipe start` refuses while one exists for the repo.

## 4. Intake and triage

**Filing.**
`hpipe task --branch <b> (--bead <id> | --title <t> --body-file <p> [--acceptance-file <p>]) --surface <s> [--tier] [--depends-on tN,…] [--files] [--notes] [--keep-worktree] [--run]`

- `--title` path: validation first, then `Bd.create` last (the existing "file last, after every
  check" ordering in `cmdTask`, `src/cli.ts:405-457`, and its memoisation across stale retries, are
  kept). Labels: `hpipe:run=<run_id>`.
- `--bead` path (replaces `--issue`): `Bd.show`; refuses a bead that is closed, or that another live
  run's ledger already holds. Adds the `hpipe:run=<run_id>` label.
- `--depends-on tN`: in addition to the existing ledger gate, `Bd.depAdd(<this bead>, <tN's bead>)`
  so bv's graph and `bd ready` agree with hpipe's own gate.
- The brief snapshot (§3) is captured from `Bd.show` after the write.

**`hpipe next [--limit N] [--label L]`** — new, read-only, orchestrator-facing.

1. Runs `bv --robot-triage-by-track --db <slug>/.beads/issues.jsonl` (env `BV_NO_UPDATE_CHECK=1`,
   `BV_NO_GITIGNORE=1`) in `cwd = <slug>`. Re-exports first if `export.dirty` exists.
2. Drops every recommendation whose ID any live run's ledger already holds.
3. If any metric in `status` is not `computed`, prints that as a warning line (`cycles: timeout —
   cycle-free not proven`).
4. Prints, per track: the top pick (ID, title, score, `reasons`, `unblocks_ids`), then the rest of the
   track's IDs on one line; then `blockers_to_clear` and `alerts` if non-empty. Compact text, not
   JSON — this lands in the orchestrator's context.

`prompts/intake.md` tells the orchestrator to run `hpipe next` before filing new work, to adopt
existing beads with `--bead` where they fit, and to treat separate tracks as parallel-safe
**only after** checking `--files` overlap (bv tracks are dependency components and know nothing about
files). It says never to run bare `bv` or `bv --robot-*` directly.

**Dispatch.** `hpipe dispatch --task tN --pane <p>` calls `Bd.claim(bead)` before sending the brief.
The bead goes to `in_progress` with assignee `hpipe:orchestrator`, so bv stops listing it as
claimable. A claim failure (another actor holds it) refuses the dispatch.

**Phase on the board.** The board's columns are bd statuses (open / in_progress / blocked / closed);
the fine phase is the `phase:<row>` label on the card. No custom statuses are added: bv's board
appears to render only the built-in statuses as columns, so a custom status risks leaving cards in no
column. That is unverified; §11 item 3 checks it, and if custom statuses render, phase can move from
a label to a status in a follow-up.

## 5. Phase mirroring (supervisor)

After `advanceTasks` (`src/supervisor/main.ts:297-318`) saves the ledger, for each task where
`task.row !== task.bead_synced_row`: `Bd.setPhase(bead, row)`, then set `bead_synced_row = row` and
save. Failures leave `bead_synced_row` unchanged, so the next tick retries; they never block
advancement and never touch the phase machine. Terminal rows: `done` and `orphaned` remove the phase
label; `escalated`/`failed` set `phase:escalated` / `phase:failed`.

This runs after the ledger save, so a crash between the two leaves the label one transition behind
and the next tick repairs it.

## 6. Decisions

Worker-side `hpipe decide` / `hpipe answer` and `task.decisions[]` (`src/lib/decisions.ts`,
`src/cli.ts:811-887`) are unchanged.

- **Escalated to the human.** When the orchestrator escalates (the existing path that leaves a
  decision awaiting `--by human`), hpipe runs `Bd.create({type: 'decision', parent: <task bead>,
  labels: ['human', 'hpipe:decision=<id>'], title: <question>, body: <question + recommendation>})`
  and `Bd.setStatus(<task bead>, 'blocked')`. The decision bead ID is stored on the ledger decision
  (`decision.bead`). `bd human list` and the board's Blocked column now show what is waiting on you.
- **Answered by the human.** `hpipe answer --by human` closes the decision bead with the answer as
  the reason and sets the task bead back to `in_progress`.
- **Answered by the orchestrator.** `hpipe answer --by orchestrator` adds `Bd.comment(<task bead>,
  "Ruling on <decision id>: <answer>")`. This replaces the hand-written ruling comments cited in
  earlier specs (e.g. `2026-09-18-issue-19-design.md:6-7`).

Answers are delivered to workers exactly as today; the bead writes are a mirror, and a failed mirror
write is logged and does not block delivery.

## 7. Discovered work

- **Worker:** `hpipe discover --task tN --title <t> --body-file <p>` appends to
  `task.discoveries[]` and copies the body into `$STATE/runs/<session>/<run_id>.discoveries/`. No bd
  call; the worker never writes to Beads.
- **Orchestrator:** `prompts/branch-review.md` adds a step: `hpipe discoveries` lists them;
  `hpipe discoveries --file` creates one bead per discovery (`labels: ['hpipe:discovered']`) and a
  `discovered-from` dependency to the originating task's bead, then marks each filed. They land in
  the backlog for the next run's `hpipe next`.
- `prompts/worker-brief.md` gains one line: out-of-scope bugs and follow-ups go to `hpipe discover`,
  not into the current PR.

## 8. PRs and close

**PR body.** `prompts/worker-brief.md:67-71` and `prompts/implement.md:22-27` drop the `Closes #N`
requirement; the PR body ends `Refs <bead>` instead. The check that treats a missing closing keyword
as a failure is removed. `pr-review.md`, `pr-review-intent.md` and `spec-review.md` read the brief
with `hpipe brief --task tN` instead of `gh issue view`.

**Close on merge.** In `src/supervisor/tasks.ts:393-410`, when `prView` reports merged during
`merge`, the supervisor records `merged_at_ms` / `merge_commit` (unchanged) and calls
`Bd.close(bead, "merged in PR #<pr> (<merge_commit>)")`. On success it sets
`bead_closed_at_ms = now`.

The `close` row's signal (`src/lib/machine.ts:240-250`) becomes
`bead_closed_at_ms !== null && bead_closed_at_ms >= merged_at_ms`. It is still an edge — set once,
by the write that followed the observed merge — and a bead closed before the merge cannot satisfy it.
`issue_closed_at_entry` and the `issueView` dependency in `TaskDeps` go away.

If `Bd.close` fails, the task stays in `close` and the supervisor retries each tick. After 5
consecutive failures (a monotone counter, `task.bead_close_failures`, per the README's retry-counter
rule) the stall clause (`src/supervisor/stall.ts:341-352`, rewritten) tells the orchestrator to run
**`hpipe close --task tN`**, a new command that does the same `Bd.close` and sets
`bead_closed_at_ms`. `prompts/close.md` is deleted; the close row no longer delivers a prompt.

**Branch review.** `prompts/branch-review.md:8` lists the run's PRs from the ledger
(`hpipe show` already prints each task's `pr`) instead of
`gh pr list --state merged --search "<issues>"`.

## 9. The board tab

**Pane.** A new `[[panes]]` entry in `herdr-plugin.toml`, `id = "board"`, `placement = "tab"`,
command `sh -c "bun run src/board.ts; exec $SHELL"` (same crash-to-shell pattern as the supervisor
pane, `herdr-plugin.toml:77-81`).

`src/board.ts` resolves which repo it is for (§11 item 4 decides how the slug reaches it), then
`exec`s:

```
BV_NO_UPDATE_CHECK=1 BV_NO_GITIGNORE=1 bv --db $STATE/beads/<slug>/.beads/issues.jsonl
```

with `cwd = $STATE/beads/<slug>`. If `bv` is missing it prints the install command
(`brew install dicklesworthstone/tap/bv`) and drops to the shell.

**Lifecycle.**
- `hpipe start` opens one board tab for the run, labelled `Board: <repo basename>`.
- The run reaching `done` closes it (supervisor, on the run's transition to `done`).
- `startup.ts` reopens a board for every live v3 run in the session that has none.
- A new action **Open board** (pattern of `src/actions/supervisor.ts:21-30`) reopens it by hand.
- `clearStrayPanes` (`src/startup.ts:128-139`) and `reapGhostPanes` (`src/startup.ts:45-71`) skip
  panes whose label starts with `Board: ` — today both would kill the tab on the next startup.

**Read-only by construction.** `--db <file>` keeps bv off Dolt (Decision 6). The TUI's `O` edit
path calls `br`, not `bd`; with no `br` installed it fails harmlessly. The README notes not to
install `br` alongside, since bv would then write through it to a store hpipe does not read. The
kanban is one keypress away (`b`); bv has no start-in-board flag.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| `bd` missing | `hpipe start` / `task` / `dispatch` refuse with the spawn error; `status` shows `tools:` |
| `bd` write fails in a CLI command | the command fails with bd's stderr; `cmdTask` keeps its file-last ordering, so nothing half-registers |
| `setPhase` fails | logged; `bead_synced_row` unchanged; retried next tick; never blocks |
| `close` fails | task holds in `close`; retried each tick; after 5, stall clause → `hpipe close` |
| decision mirror fails | logged; delivery proceeds |
| lock not acquired in 10 s | the call fails as a `BdFailure` and follows the rows above |
| export fails | `export.dirty` set; re-export on next write/tick; board lags |
| `bv` missing | no board tab (install hint in the tab); `hpipe next` errors with the hint; pipeline unaffected |
| `bv` metric not `computed` | `hpipe next` prints the warning; recommendations still shown |

## 11. Verify before implementing

These are step 1 of the plan; each either confirms the design or changes the named section.

1. `bd init` with `BEADS_DIR` and `cwd` in the state dir writes nothing under the repo and runs no
   git command against it (§1).
2. Two concurrent `bd` processes on one embedded database: observe the failure mode, so the lock's
   necessity is documented rather than assumed (§2).
3. bv's board with a custom status present, and with `phase:` labels: do custom-status cards
   disappear, and are labels legible on cards (§4, §5)?
4. Whether `herdr plugin pane open` can pass an argument or env var to the pane command. If not,
   `board.ts` resolves the repo by asking which run's board is missing, keyed by the pane label set
   right after open (§9).
5. Label swap vs `bd set-state phase=<row>`: which produces cleaner `bd history` and bv display (§2,
   §5).

## 12. Tests

- `test/bd.test.ts`: `Bd` against `makeFakeBin` (`test/helpers/fake-bin.ts`) — argv per method,
  `BEADS_DIR`/`cwd`, export after every write, `export.dirty` set and cleared, lock acquired and
  released (two concurrent calls serialise), timeout path.
- `test/cli-commands.test.ts`, `test/cli-argv.test.ts`: `--bead` / `--title` filing via the injected
  filer (replacing the `fileIssue` stub), `--depends-on` dep add, dispatch claim and claim-refusal,
  `answer` decision mirroring, `discover` / `discoveries --file`, `close`.
- `test/tasks.test.ts`, `test/table.test.ts`: `TaskDeps` gains `closeBead`/`setPhase`; close row
  advances only on `bead_closed_at_ms >= merged_at_ms` (a bead closed before the merge does not
  advance it); close retry counter is monotone; `setPhase` failure does not block advancement.
- `test/next.test.ts`: `hpipe next` over recorded bv JSON fixtures — ledger filtering, non-`computed`
  metric warning, empty-track output.
- `test/startup.test.ts`: `clearStrayPanes` / `reapGhostPanes` spare `Board: ` panes.
- `test/integration/smoke.md`: a live section with real `bd` and `bv` against a scratch repo — setup,
  one task through to close, the board updating, `hpipe next` output.

## Out of scope

- GitHub Issues as a backend, or importing existing GitHub issues into Beads.
- Cross-project boards (bv workspace mode has no live reload).
- Dolt remotes, `bd dolt push/pull`, and the shared server.
- Migrating v2 runs.
- Beads formulas/molecules/gates as the phase engine — the supervisor's phase table stays the source
  of truth.
- Vendoring or forking any bv code (licence rider).
