# Beads as the issue store — design

Pass 3. Written against `main` at `31e6b2d`. Reviewed adversarially twice:
`docs/superpowers/reviews/2026-10-02-beads-issue-store-adversarial-1.md` (pass 1: BLOCKER, 1/8/11) and
`…-adversarial-2.md` (pass 2: CLEAR, 0/5/11). Pass 3 replaces pass 2's bead outbox with a
desired-state reconciler, which is what four of pass 2's five MAJORs traced back to. The tables at
the end map every finding of both reviews to where it landed.

GitHub Issues stops being hpipe's issue store. [Beads](https://github.com/gastownhall/beads) (`bd`
≥ 1.3.1) replaces it outright: one embedded Dolt database per project, kept in the plugin's state
dir, written only by hpipe code. [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)
(`bv` ≥ 0.25.2) gives the human a live kanban/graph tab per project and gives the orchestrator a
deterministic triage engine (`hpipe next`). `gh` stays for PRs, CI and merge.

**On-disk format change.** The ledger moves to `schema_version: 3`. The supervisor already ignores
runs whose schema it does not know (`src/supervisor/main.ts:50-52,200-203`). v2 runs are not
migrated: finish them on the previous release before upgrading, then restart the supervisor.

**Version floor matters.** bd 1.3.1 added close guards (assignee match, open children, open
blockers) that earlier releases lack. Behaviour below 1.3.1 is unsupported, and the smoke test must
run on ≥ 1.3.1 (the machine this was written on has 1.0.4).

## Evidence

From the tools' sources at the tagged versions (cloned read-only on 2026-10-02; both reviews
re-verified each):

| Fact | Source |
|---|---|
| Embedded mode keeps data in `.beads/embeddeddolt/`, needs no `dolt` binary, and is single-writer: each bd process takes an exclusive non-blocking lock on `embeddeddolt/.lock` and fails fast ("database is locked") when it is held; the kernel drops it when the process dies | beads `docs/architecture/dolt.md:163,521-525`, `cmd/bd/store_factory.go:127-140` |
| An explicit `BEADS_DIR` is authoritative, never walked up from | beads `internal/beads/beads.go:772-785` |
| `bd init` with an explicit `BEADS_DIR` in a non-git cwd skips `git init`; its auto-commit is gated on `!stealth && isGitRepo() && useLocalBeads`; it trims a trailing `-` from the prefix | beads `cmd/bd/init.go:1123,2152,2765` |
| A linked git worktree auto-discovers the main checkout's `.beads` through the git common dir | beads `docs/reference/worktrees.md` |
| Beads recommends one database per project with its own `--prefix`; there is no project field | beads `docs/reference/faq.md` |
| `issue_id_mode counter` gives sequential IDs | beads `docs/reference/configuration.md:300,338` |
| `close` refuses when the actor is not the assignee, when the target has open parent-child dependents (even if already closed), or an open `blocks` edge; `--force` bypasses the policy; `discovered-from` is not a blocker | beads `cmd/bd/close_direct.go:83-87`, `internal/validation/issue.go:165-175`, `internal/storage/issueops/close.go:120-160` |
| Re-closing a closed issue and re-claiming your own claim are exit-0 no-ops; `--claim` only claims from `open` | beads `cmd/bd/close.go:178-200`, `issueops/claim.go:61-69,147-160` |
| `bd unclaim` refuses closed, unassigned and non-`open`/`in_progress` beads (not idempotent) | beads `issueops/unclaim.go:46-53,83,100` |
| A plain `update --assignee ""` by the holder's own actor is allowed; only a different actor clearing a live `in_progress` claim is refused | beads `internal/validation/issue.go:177-210` (`AssigneeNotStolen`) |
| `reopen` sets `open` and leaves the assignee | beads `issueops/reopen.go:63-67` |
| `create --acceptance` takes a string; `close --reason-file` and `comment --file` take files; `dep add` defaults to `--type blocks` and refuses a cycle or a different-type edge on the same pair | beads `cmd/bd/flags.go:32`, `close.go:491`, `comment.go:62`, `dep.go:1534`, `dependencies.go:245,279` |
| `show` returns only `dependent_count` unless `--include-dependents` | beads `cmd/bd/show.go:318-325` |
| `bd export` writes issues with their labels, dependencies and comments, atomically; `export.auto` defaults to false | beads `cmd/bd/export.go:28,119,230`, `internal/config/config.go:330` |
| bv loads an explicit `.jsonl` given by `--db` directly, before the bd bridge that would run `bd export` | bv `cmd/bv/main.go:1937-1943`, `internal/datasource/load.go:150-154,306-311` |
| bv watches the JSONL's parent dir with fsnotify, 200 ms TUI debounce; its multi-repo mode has no live reload | bv `pkg/watcher/watcher.go:199-410`, `cmd/bv/main.go:2714` |
| bv "claimable" = open, unblocked, unassigned, not deferred, not an epic | bv `cmd/bv/robot_registry.go:2343` |
| `--robot-triage-by-track` emits `triage.status`, `alerts`, `blockers_to_clear`, `recommendations_by_track[].top_pick{reasons, unblocks_ids}` | bv `cmd/bv/robot_registry.go:1674`, `pkg/analysis/triage.go:41-52,129-133,442-447` |
| The TUI's `O` edit path shells out to `br`, never `bd` | bv `pkg/ui/model.go:262-283` |
| bv's licence is MIT plus a rider that withholds all rights from, and forbids making the software available to or for, OpenAI, Anthropic and anyone acting on their behalf or for their benefit; "use" includes executing | bv `LICENSE` |
| `herdr plugin pane open` takes `--workspace`, `--cwd`, `--env KEY=VALUE`; `herdr pane rename` exists | `herdr plugin pane open --help`, `herdr pane --help` (herdr 0.9.x) |
| After a herdr restart a plugin pane comes back as a plain shell keeping its label; `exec $SHELL` is a silent no-op when `SHELL` is unset | base spec `2026-09-13-herdr-pipeline-plugin-design.md` "Verified herdr facts" |

And hpipe today:

| Where | What |
|---|---|
| `src/lib/gh.ts:111-137` | `issueView`, `issueLabels`, `issueCreate` |
| `src/cli.ts:223-226,237-457` | filing and the label read (`cli.ts:226,323`) in `registerTask` / `cmdTask`; `fileIssueOnce` memo across stale retries |
| `src/lib/tiers.ts:25-60` | `registrationTier` parses `pipeline:tier-<name>` from labels it is handed |
| `src/supervisor/main.ts:196-483` | the serial tick; `advanceTasks` at 301-324; per-run `saveOrReapply` at 375, inside a loop over `pickOneAdvance(runs)` that never contains `done` runs (`tick.ts:531-541`) |
| `src/supervisor/tasks.ts:143-144,393-410` | close prompt render; merge/close signals via `issueView` |
| `src/lib/machine.ts:229-251` | `issue_closed_at_entry`; close advances on `issueClosed && (atEntry || closedAtMs >= merged_at_ms)` |
| `src/lib/phases.ts:152-162` | `ci`/`teardown` rows carry `probeTarget: 'orchestrator'`; `merge` and `close` rows carry `actor: 'orchestrator'`; close names `prompt: 'close'` |
| `test/table.test.ts:34-40` | every stallable row must resolve to a pane or name a `probeTarget` |
| `src/lib/gating.ts:7-14,137-153` | `TERMINAL_OK = {done}`, `TERMINAL_BAD`; a dependent starts only once every dependency is `done`; rewinding to `failed` is the documented abandon path |
| `src/lib/decisions.ts` | `openDecision`, `answerDecision`, `abandonDecisions`; no "awaiting human" state |
| `src/cli.ts:205,713-761` | rewind: terminal rewinds call `abandonDecisions`; rewind bypasses `enterTaskPhase`; rewind into `PHASES_BEFORE_A_PR` resets PR fields and `issue_closed_at_entry` |
| `src/cli.ts:505-545` | `dispatch`; a task enters `research` at registration, the worker is briefed later |
| `src/cli.ts:949-997` | `abort` (run → `done`, resumable), `resume`, `forget` (unbinds a workspace only) |
| `src/lib/ledger.ts:7-9,153-165` | run files live at `runs/<session>/<run_id>.json` and are never deleted |
| `src/lib/models.ts:1-6` | the CLI loads no config; only the supervisor does |
| `src/lib/render.ts:8-13` | `render()` throws on an unresolved placeholder |
| `prompts/*.md` | 14 templates render `{{issue}}`: `research`, `spec`, `spec-review`, `plan`, `plan-review`, `implement`, `pr-review`, `pr-review-intent`, `pr-review-quality`, `ci-red`, `merge`, `close`, `decision`, `worker-brief` |
| `prompts/worker-brief.md:8,67-71`, `implement.md:22-27` | `gh issue view {{issue}}`; the `Closes #N` rule (prompt text only — no code checks it) |
| `prompts/intake.md:24-30`, `dispatch.md:44,51-55`, `dispatch-registering.md`, `branch-review.md:8` | `--issue <n>`, `gh issue create`, "the issue body is the brief", the `issue: #<n> (filed)` header, PR search by issue |
| `skills/herdr-pipeline/SKILL.md`, `README.md:118,127` | "batch of GitHub issues", `--issue`, `gh issue create` |
| `src/startup.ts:45-71,128-139,177-189` | `reapGhostPanes` (supervisor label, by shell pid); `clearStrayPanes` closes every pipeline-workspace pane not labelled "Pipeline supervisor"; the supervisor pane opens before `clearStrayPanes` runs |
| `herdr-plugin.toml:77-81` | supervisor pane command ends `exec "${SHELL:-/bin/sh}"` |

## Decisions

1. **Replace, don't abstract.** Beads is the only issue backend.
2. **One database per project.** A shared database with a `project:` label was rejected: every `bd`
   and `bv` call would need the filter, bv's graph metrics would score across projects, all
   projects would share a prefix, and one missed filter dispatches another repo's work. A shared
   Dolt server is deferred (an init flag, adoptable later without redesign).
3. **The database lives in the plugin state dir** (`$STATE/beads/<slug>/.beads`). Worker worktrees
   cannot discover it and the repo stays untouched. Costs accepted: issues do not travel with the
   code; bv's git-backed views are unavailable; the state dir is the only copy (§1 Durability).
4. **The orchestrator authors, the supervisor reconciles.** The orchestrator's hpipe commands
   change the *ledger*; from the ledger the supervisor derives the state every bead should be in and
   converges Beads to it (§5). Only three Beads calls run synchronously in a CLI command, because
   their answer is needed on the spot: `create` (the ID), the adoption `show`, and the dispatch
   `claim` (a refused claim must refuse the dispatch). There is no queue of Beads operations: what a
   bead should look like is always recomputed from the latest ledger, so nothing can be lost
   between saves, jam behind a failure, or apply out of order.
5. **One actor, `hpipe`, for every write.** bd 1.3.1 refuses a close by anyone but the assignee; the
   claim and the close must share an actor. Which layer acted is in the ledger history.
6. **The supervisor closes the bead on merge**, without `--force`. The design keeps the close guards
   from firing (§8); the manual fallback may `--force`, explicitly.
7. **Agents never run `bd`.** Not workers, not the orchestrator. Reads go through `hpipe` commands.
   bv reads only the exported file.
8. **Only hpipe exports.** bv is always launched with `--db <file>`; `export.auto` stays off.
9. **The board is per project, not per run**: one tab per repo slug with a live run in the session.

## 1. Storage and setup

**Layout.** `$STATE` is `HERDR_PLUGIN_STATE_DIR` (fallback `~/.local/state/herdr/plugins/stein.pipeline`,
`src/cli.ts:1085-1086`).

```
$STATE/beads/<slug>/
  .beads/                  bd workspace (embeddeddolt/, config.yaml, metadata.json)
  .beads/issues.jsonl      the export: bv's input and the reconciler's view of actual state
  hpipe.lock               the Bd lock (§2)
  project.json             { repo_root, prefix, created_at }
```

`<slug>` is new code (`src/lib/beads-project.ts`): the repo root's sanitised basename, `-`, and the
first 6 hex chars of sha256(`repoKey`), where `repoKey` is the absolute repo root
(`src/lib/repo.ts:17-25`).

**Prefix.** Default: sanitised basename truncated to 8 chars, then trailing `-` trimmed (bd trims it
too; `project.json` must record what the store uses). `hpipe start --prefix <p>` and the setup
action's input override it. Setup refuses a prefix recorded in another `project.json`, naming
`--prefix` as the remedy.

**Git isolation.** Every `bd` and `bv` spawn — init included — runs with
`cwd = $STATE/beads/<slug>`, `BEADS_DIR` set, and `GIT_CEILING_DIRECTORIES=$STATE/beads`, so none can
find a git work tree around `$STATE` (e.g. a dotfiles repo at `$HOME`). Setup first runs
`git rev-parse --is-inside-work-tree` in that cwd **without** the ceiling, and warns in its output
when it finds an enclosing work tree (the ceiling makes it harmless; the warning says why the
state dir is in a repo at all).

**Init.**

```
bd init --prefix <p> --skip-agents --skip-hooks --non-interactive
bd config set issue_id_mode counter
bd export -o .beads/issues.jsonl
```

**Triggers.** `hpipe start` runs setup when `project.json` is absent, before `newRun`. A herdr action
**Set up Beads for this repo** (`src/actions/beads-setup.ts`) runs it on demand.

**Binaries.** `bd` and `bv` resolve from `PATH` in every process; env `BD_BIN` / `BV_BIN` override
(as `GH_BIN` does for tests). No `config.env` keys: the CLI loads no config
(`src/lib/models.ts:1-6`), and a key only the supervisor honoured would let two bd versions write
one store. The CLI (`hpipe start`, `status`) and startup check `bd version` ≥ 1.3.1 and
`bv --version` ≥ 0.25.2. `hpipe start` refuses without a good `bd`; it proceeds without `bv` (no
board, `hpipe next` errors with the install hint). `hpipe status` shows a `tools:` line when either
is missing or too old.

**Durability.** The state dir is the only copy of the backlog. If it is lost, re-running setup
restarts the counter at `<prefix>-1`, and new artifact names would collide with ones already
committed. Setup therefore scans the repo's `docs/superpowers/` for names matching `<prefix>-<n>`
and refuses the prefix if any exist, naming `--prefix`. The README recommends backing up
`$STATE/beads`.

## 2. The `Bd` module

`src/lib/bd.ts`, a class in the shape of `Gh` (`src/lib/gh.ts:35-55`): every call runs
`<bd> --json --actor hpipe …` with the env and cwd of §1, and parses **stdout only** (outside git,
bd prints a `beads.role` warning on stderr). A spawn failure returns code -1 like `Gh.run`. Every
spawn is killed after 30 s and returns `BdFailure{timeout}`.

**Lock, per call.** `hpipe.lock` is taken around **each single `bd` invocation** (plus its export,
when it writes), never around a batch, so the longest anyone waits is one call. It is built on the
`src/lib/pidfile.ts` primitive and reclaimed when the holder is dead, as the supervisor's pid file is
(`src/supervisor/main.ts:94-110`). It exists to make hpipe processes queue instead of tripping bd's
own fail-fast Dolt lock; it does not track `bd` children — bd's kernel lock already stops a second
writer while an orphaned child lives.

- **CLI:** waits up to 10 s, then fails with "Beads is busy, retry".
- **Supervisor:** try-lock, no wait; a held lock ends this tick's Beads work.

**Export.** A write method runs its command, then exports through a private unlocked `#export()`
inside the same lock hold. The reconciler (§5) uses unexporting internals and exports once at the
end of its pass. A failed export sets `<slug>/export.dirty`; the next hold re-exports and clears it.

**Methods** (each returns a typed result or `BdFailure`):

| Method | `bd` call |
|---|---|
| `create({title, body, acceptance?, labels, depsDiscoveredFrom?})` | `create --title <t> --body-file <tmp> [--acceptance <string>] -l … [--deps discovered-from:<id>]` |
| `show(id)` | `show <id> --include-comments --include-dependents` |
| `claim(id)` | `update <id> --claim` |
| `update(id, {status?, assignee?, addLabels?, removeLabels?})` | one `update <id> [-s] [--assignee] [--add-label …] [--remove-label …]` |
| `reopen(id)` | `reopen <id>` |
| `comment(id, file)` | `comment <id> --file <f>` |
| `depAdd(from, to)` | `dep add <from> <to> --type blocks` |
| `close(id, reasonFile, {force})` | `close <id> --reason-file <f> [--force]` |
| `readExport()` | parses `.beads/issues.jsonl` (no spawn, no lock) |

`bd unclaim` is not used: it is not idempotent. A release is `update --assignee "" -s open`, which
the holder's own actor may always do.

## 3. Ledger changes (`schema_version: 3`)

In `src/lib/types.ts`:

- `Task.issue: number` → `Task.bead: string`.
- `Task.issue_closed_at_entry` → removed.
- New `Task.brief: { title, description, acceptance, labels, captured_at_ms }`, captured at
  registration. It is the worker's brief for the life of the run; later edits to the bead do not
  reach a running task.
- New `Task.bead_closed_at_ms: number | null` (§8).
- New `Task.bead_sync: { failures: number, last_error: string | null, last_ok_at_ms: number | null }`
  — `failures` is monotone.
- New `Task.discoveries: { id, title, body_path, filed_bead: string | null }[]` (§7).
- New `Decision.escalated_at: number | null` (§6).
- `Run.schema_version` → 3 (`src/lib/ledger.ts:40`); `runForRepo` (`ledger.ts:349-361`) ignores v2
  files so `hpipe start` is not blocked by them.

No ledger field records Beads operations: the reconciler needs none.

Artifact stems `${date}-issue-${issue}` (`src/cli.ts:335-336`) → `${date}-${bead}`; verdict prefix
`issue-${task.issue}` (`src/lib/verdict-path.ts:19-21`) → `${task.bead}`. Display sites rendering
`#${task.issue}` (`status.ts`, `tick.ts`, `deliver.ts`, `awaiting.ts`, `tasks.ts:221`) render the
bead ID.

**Tier override.** The labels handed to `registrationTier` (`src/lib/tiers.ts:25-60`) come from the
bead (`Bd.show`, or the create's own input) instead of `gh issue view --json labels`
(`src/cli.ts:226,323`). Same label `pipeline:tier-<name>`, same precedence.

**Prompt variables.** `{{issue}}` is removed. `{{bead}}` (the ID) and `{{brief}}` (the snapshot,
rendered as title, description, acceptance) are added, set by `tasks.ts:118,594` and
`worker-prompt.ts:23`.

**"Held".** A bead is *held* when some task carries it, that task's phase is not in `TERMINAL_OK` or
`TERMINAL_BAD` (`gating.ts:7-14`), and its run's `phase !== 'done'`, scanning run files of **all**
sessions (`$STATE/runs/*/`). Adoption, `hpipe next` and the reconciler's release rule all use this
one predicate (`src/lib/held.ts`).

## 4. Intake, triage and briefs

**Filing.**
`hpipe task --branch <b> (--bead <id> | --title <t> --body-file <p> [--acceptance-file <p>]) --surface <s> [--tier] [--depends-on tN,…] [--files] [--notes] [--keep-worktree] [--run]`

- `--title` path: every validation first, then `Bd.create` last, memoised across stale retries as
  `fileIssueOnce` is today. The acceptance file is read and passed as a string. The brief is the
  create's own input.
- `--bead` path (replaces `--issue`): `Bd.show`, memoised the same way. Refuses a bead that is
  closed, assigned, held, has an open `blocks` dependency, or has open child beads (parent-child
  dependents — an epic or a human-made parent would trip the open-children close guard). The brief comes from that show.
- Nothing else in `cmdTask` touches Beads: the run label and the `blocks` edges for `--depends-on`
  are desired state the reconciler applies (§5).

**`hpipe next [--limit N] [--label L]`** — read-only, orchestrator-facing.

1. Re-exports under the lock if `export.dirty` exists, then runs
   `bv --robot-triage-by-track --db <slug>/.beads/issues.jsonl` with the §1 env/cwd plus
   `BV_NO_UPDATE_CHECK=1`, `BV_NO_GITIGNORE=1`, killed after 30 s.
2. Drops recommendations for held beads (§3).
3. Prints a warning line for any `triage.status` metric that is not `computed`
   (`cycles: timeout — cycle-free not proven`).
4. Prints compact text per track — top pick (ID, title, score, `reasons`, `unblocks_ids`), then the
   track's other IDs — then `blockers_to_clear` and `alerts` if non-empty.

**`hpipe bead show <id>`** — read-only, locked; prints title, status, labels, description,
acceptance and comments. The only way an agent reads Beads.

**Prompts.**
- `intake.md:24-30`, `dispatch-registering.md`, `SKILL.md`, `README.md:118,127`: `--issue`/`gh issue
  create` become `hpipe task --title/--bead`; `hpipe task`'s header prints `bead: <id> (filed)` and
  the prompts quote that; the orchestrator runs `hpipe next` before filing new work and adopts
  existing beads where they fit; bv tracks are dependency-independent but know nothing about files,
  so parallel dispatch still requires disjoint `--files`; never run `bd` or `bv` directly.
- `dispatch.md:44,51-55`: "reading `gh issue view` against a different repo's issues" becomes
  "reading a different repo"; "the issue body is the brief" becomes "the bead's brief, captured at
  registration, is the brief"; `issue:` in the header list becomes `bead:`.
- `worker-brief.md` inlines `{{brief}}` in place of `gh issue view` (line 8). `hpipe brief --task
  tN` prints that rendered brief, so the snapshot is the single source.
- `research.md`, `spec.md`, `plan.md`, `plan-review.md`, `spec-review.md`, `pr-review.md`,
  `pr-review-intent.md`, `pr-review-quality.md`, `ci-red.md`, `merge.md`: `#{{issue}}` becomes
  `{{bead}}`; every `gh issue view` becomes `hpipe brief --task {{task_id}}`.

**Dispatch.** `hpipe dispatch --task tN --pane <p>` runs `Bd.claim(bead)` synchronously before
sending the brief; a refused claim refuses the dispatch with bd's message. If the bead is `blocked`
or assigned-but-`open` (left so by an earlier life of the task), `Bd.update(status: open)` precedes
the claim. The reconciler would reach the same state; doing it here lets the dispatch report a real
refusal.

**Board columns.** Status shows open / in_progress / blocked / closed; the fine phase is a
`phase:<name>` label on the card. No custom statuses (whether bv renders them as columns is
unverified; §11).

## 5. The reconciler

`src/supervisor/beads-sync.ts`. Runs once per tick, **after** the per-run advance loop, in its own
loop over every run file in the session — `done` and aborted runs included, since their beads still
need releasing — grouped by slug.

**Desired state**, a pure function `desiredBead(task, run, decisions)` in `src/lib/bead-desired.ts`:

| Ledger condition (first match wins) | status | assignee | labels |
|---|---|---|---|
| `merged_at_ms !== null` | `closed` | `hpipe` | `hpipe:run=<id>` |
| task in `TERMINAL_BAD`, or run `done` and task not `done` | `open` | — | `hpipe:run=<id>`, `phase:<phase>` (or `phase:aborted`) |
| an escalated, unanswered decision | `blocked` | `hpipe` | `hpipe:run=<id>`, `phase:<phase>`, `hpipe:awaiting-human` |
| task dispatched: phase is not `queued` and `awaiting_brief !== true` (set on entering `research` from `queued`, cleared by `dispatch`, `cli.ts:602-603`, `machine.ts:104-105`) | `in_progress` | `hpipe` | `hpipe:run=<id>`, `phase:<phase>` |
| otherwise (registered, not yet dispatched) | `open` | — | `hpipe:run=<id>`, `phase:<phase>` |

Plus, regardless of row: a `blocks` edge to each `depends_on` task's bead; and one comment per
escalated decision (question, worker's and orchestrator's recommendations) and per answered decision
(the ruling), each ending in a marker `[hpipe <task_id>/<decision_id>/<asked|ruling>]`. Labels in
the `hpipe:` and `phase:` namespaces not in the desired set are removed; other labels are left
alone.

**Actual state** comes from `Bd.readExport()` — no spawn, no lock.

**Convergence.** For each task whose actual bead differs from desired, the minimal calls, in this
order: `reopen` (closed → not closed); one `update` folding status, assignee and label changes;
`depAdd` per missing edge; `comment` per missing marker; `close` (→ closed, §8). Each call is
idempotent against the desired state, so a crash at any point simply recomputes the remainder next
tick. Comments are idempotent through their marker: the reconciler posts one only when the export
shows no comment carrying it.

**Budget.** The pass stops after 2 s of wall time or at the first lock it cannot take, and resumes
next tick. The lock is per call (§2), so a CLI command waits at most one call. One export closes
the pass. A registration burst therefore spreads over a few ticks instead of stalling one.

**Failures.** A failed call increments `task.bead_sync.failures` (monotone), stores `last_error`,
and moves on to the next task; it never blocks phase advancement except through the close row
(§8). `hpipe status` shows any task whose bead has been out of sync for more than 5 failures, with
`last_error`. The reconciler's ledger writes (`bead_sync`, `bead_closed_at_ms`) are saved with
`saveOrReapply` as replayable effects.

**Why races are gone.** `resume` after `abort`, a rewind out of `failed`, a re-dispatch: each
changes the ledger, and the next pass computes the new desired state from it. There is no older
release waiting to undo a newer claim.

## 6. Decisions

Worker-side `decide` / `answer` and `task.decisions[]` are unchanged. **No decision beads are
created** — a child bead would block the parent's close. Decisions show on the task's own bead,
through the desired state of §5.

- **New `hpipe escalate --task tN --decision dN`.** `decision.md` tells the orchestrator to run it
  when it puts a question to the human (today that step is prose only). It sets
  `decision.escalated_at`; the reconciler then blocks the bead, adds `hpipe:awaiting-human` and
  posts the question comment. `hpipe status` lists escalated, unanswered decisions under "waiting
  on you".
- **Any answer** (`--by human` or `--by orchestrator`), an abandoned decision, or a rewind out of
  `blocked-on-decision` ends "escalated, unanswered", so the bead un-blocks with no extra rule. An
  answered decision gets its ruling comment. This replaces the hand-written ruling comments of
  earlier specs.
- `decision.md:15` reads "the brief (`hpipe brief --task {{task_id}}`)" instead of "issue #N".

## 7. Discovered work

- **Worker:** `hpipe discover --task tN --title <t> --body-file <p>` appends to `task.discoveries[]`
  and copies the body into `$STATE/runs/<session>/<run_id>.discoveries/`. No Beads access.
- **Orchestrator:** `branch-review.md` adds a step: `hpipe discoveries` lists them;
  `hpipe discoveries --file` runs `Bd.create` per unfiled discovery with
  `labels: ['hpipe:discovered']` and `depsDiscoveredFrom: <task bead>` (non-blocking), storing
  `filed_bead` in the same save so a retry files nothing twice.
- `worker-brief.md` gains one line: out-of-scope bugs and follow-ups go to `hpipe discover`, not
  into the current PR.

## 8. PRs, close and releases

**PR body.** The `Closes #N` rule in `worker-brief.md:67-71` and `implement.md:22-27` becomes "the PR
body ends `Refs {{bead}}`". It was prompt text only; no code changes.

**Close on merge.** The merge signal (`tasks.ts:393-405`, `machine.ts:229-238`) still records
`merged_at_ms` / `merge_commit`. That flips the desired status to `closed`, and the reconciler runs
`Bd.close(bead, "merged in PR #<pr> (<merge_commit>)")` without `--force`. When a pass observes
the bead closed in the export while `merged_at_ms !== null`, it sets `bead_closed_at_ms`.

Why the guards do not fire:
- **Assignee:** claim and close both run as `hpipe`.
- **Open children:** hpipe creates no child beads (§6); adoption refuses beads with open child beads
  (§4); discovered beads link with non-blocking `discovered-from`.
- **Open blockers:** adoption refuses beads with open blockers, and a dependent is only dispatched
  once every dependency is `done` (`gating.ts:137-153`), by which point its bead is closed.

**Close row.** In `src/lib/phases.ts:157-158` the `close` row loses `actor` and `prompt` and gains
`probeTarget: 'orchestrator'` (as `ci` and `teardown` have, so `table.test.ts:34-40` holds);
`tasks.ts:143-144` stops rendering it; `prompts/close.md` is deleted. Its signal
(`machine.ts:240-250`) becomes `task.bead_closed_at_ms !== null`. The field is set only by a pass
that saw the bead closed *after* a merge was recorded, and any rewind that clears `merged_at_ms`
also clears `bead_closed_at_ms` (`cli.ts:755-761`) — the desired state flips back to not-closed and
the reconciler reopens and re-claims the bead. So it is an edge, with no clock comparison, and no
stale close can outlive a rewind.

**Close stall.** The row is `stallable`; the probe is time-based (`TASK_STALL_MINUTES`), and its
clause (`src/supervisor/stall.ts:341-352`, rewritten) reads the task:
- `merged_at_ms === null` (a rewind straight into `close`): "no merge recorded — rewind into
  `merge`", as today.
- `bead_sync.failures < 5`: "waiting on the Beads close".
- otherwise: `last_error` verbatim, and **`hpipe close --task tN [--force]`**, which runs `Bd.close`
  synchronously (forced only with `--force`). The next pass sees it closed and sets
  `bead_closed_at_ms`; a forced close is never undone, because desired is `closed` too.

**Releases** follow from the desired-state table. A task in `TERMINAL_BAD` (including a rewind to
`failed`, the documented abandon path) or in an aborted run gets an `open`, unassigned bead with its
`phase:` label showing why, and stops being held, so `hpipe next` offers it again. `resume`,
rewinding out of `failed`, and re-dispatch flip it back. `orphaned` is post-merge
(`teardown.ts:186`), so its `merged_at_ms` keeps the bead `closed`. `escalated` keeps the claim (the
human may resume). `hpipe forget` touches no bead.

**Branch review.** `branch-review.md:8` lists the run's PRs from the ledger (`hpipe show` prints each
task's `pr`) instead of `gh pr list --search "<issues>"`.

## 9. The board tab

**Pane.** A `[[panes]]` entry in `herdr-plugin.toml`: `id = "board"`, `placement = "tab"`,
`title = "Board"`, command
`["sh", "-c", "bun run src/board.ts; exec \"${SHELL:-/bin/sh}\""]` (the supervisor pane's pattern,
`herdr-plugin.toml:81`).

**Open.** `herdr plugin pane open --plugin <id> --entrypoint board --placement tab --no-focus
--workspace <pipeline workspace id> --cwd $STATE/beads/<slug> --env HPIPE_BEADS_SLUG=<slug>`.
`src/board.ts` renames its own pane (`HERDR_PANE_ID`) to `Board: <basename> <hash6>`, records
`{slug: {pane_id, shell_pid}}` in `$STATE/boards.<session>.json`, then spawns `bv --db
$STATE/beads/<slug>/.beads/issues.jsonl` (with the §1 env and `BV_NO_UPDATE_CHECK=1`,
`BV_NO_GITIGNORE=1`) as a child with inherited stdio and exits with its code. If `bv` is missing it
prints `brew install dicklesworthstone/tap/bv` and exits non-zero, dropping to the shell.

**Lifetime: per slug.** Once per tick the supervisor keeps exactly one live board per slug with a
live (not `done`) v3 run in this session:
- a slug with a live run and no recorded board, or whose recorded pane is gone, or whose pane's
  shell pid differs from the recorded one (a herdr restart brings panes back as plain shells keeping
  their labels), gets its pane closed if present and a fresh one opened;
- a recorded board whose slug has no live run is closed and unrecorded.

**Cleanup.** `clearStrayPanes` (`startup.ts:128-139`) spares panes labelled exactly `Board` (just
opened, not yet renamed), labelled `Board: …`, or recorded in `boards.<session>.json`. The
supervisor's first tick can run before `clearStrayPanes` (`startup.ts:177-189`); with this
exemption that ordering no longer matters. Ghost boards are handled by the pid rule above, so
`reapGhostPanes` is unchanged. An **Open board** action (pattern of `src/actions/supervisor.ts:21-30`)
forces a reopen.

**Read-only by construction.** `--db <file>` keeps bv off Dolt. The TUI's `O` edit path calls `br`;
with no `br` installed it fails harmlessly. The README says not to install `br` alongside. The kanban
is one keypress away (`b`).

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| `bd` missing or < 1.3.1 | `start` refuses; `task` / `dispatch` / `bead show` fail with the version error; `status` shows `tools:` |
| synchronous create / show / claim fails | the command fails with bd's message; nothing is registered or dispatched |
| a reconciler call fails | `bead_sync.failures`/`last_error` recorded; next task proceeds; retried next tick; shown in `status` past 5; blocks only the close row |
| close keeps failing | stall clause at 5 failures → `hpipe close --task tN [--force]` with bd's error verbatim |
| CLI cannot get the lock in 10 s | "Beads is busy, retry" (at most one call ahead of it) |
| supervisor cannot get the lock | ends this tick's pass; resumes next tick |
| `bd` hangs | killed at 30 s → `BdFailure{timeout}` |
| an outside process holds Dolt (a human's `bd`) | bd fails fast "database is locked" → `BdFailure`, handled as above; the README tells humans to use `hpipe bead show` |
| export fails | `export.dirty`; re-export on next hold; board and reconciler view lag, then catch up |
| `bv` missing | board tab shows the install hint; `hpipe next` errors with it; pipeline unaffected |
| bv metric not `computed` | `hpipe next` warns; recommendations still shown |

## 11. Verify before implementing

Step 1 of the plan. Each confirms the design or changes the named section.

1. On bd ≥ 1.3.1, as actor `hpipe`: create, claim, `update` folding status/assignee/labels,
   `update --assignee "" -s open` on an `in_progress` claim, `reopen` then `claim`, `dep add`,
   `comment --file`, close without `--force` — all succeed; and the export carries labels, deps and
   comment text (§2, §5, §8).
2. bv's board with `phase:` labels: are labels legible on cards; does a custom status render as a
   column (§4)?
3. `herdr plugin pane open` with `--env`/`--cwd`: the env reaches the pane, `HERDR_PANE_ID` is set,
   and `herdr pane rename` works on a plugin pane (§9).

## 12. Tests

- `test/bd.test.ts`: `Bd` against `makeFakeBin` (`test/helpers/fake-bin.ts`) — argv per method,
  `--actor hpipe`, env/cwd incl. `GIT_CEILING_DIRECTORIES`, stdout-only parsing, export after writes
  via the unlocked helper, `export.dirty`, per-call lock (CLI 10 s wait vs supervisor try-lock), 30 s
  kill, and a fake bd that refuses a close by a mismatched actor.
- `test/bead-desired.test.ts`: every row of the desired-state table, edges, comment markers, label
  namespaces; `orphaned` stays closed; aborted run releases; resume re-claims.
- `test/beads-sync.test.ts`: diff → minimal call list and order; crash mid-pass converges next tick;
  2 s budget carries over; one export per pass; failures counted monotonically without blocking
  other tasks; `done` and aborted runs are visited; `bead_closed_at_ms` set only after a recorded
  merge and cleared by rewind.
- `test/held.test.ts`: the held predicate across sessions and terminal phases.
- `test/cli-commands.test.ts`, `test/cli-argv.test.ts`: `--title` / `--bead` (memoised; adoption
  refusals incl. open child beads and another session's live run), dispatch claim and refusal,
  `escalate`, `answer` both ways, `abort` / `resume`, `rewind` after merge and to `failed`,
  `discover` / `discoveries --file` (no double filing), `close [--force]`, `bead show`, `--prefix`.
- `test/tasks.test.ts`, `test/table.test.ts`: close row has `probeTarget` and no actor or prompt;
  advances only on `bead_closed_at_ms !== null`; stall clause variants.
- `test/prompts.test.ts`: every template under `prompts/` renders with the new variable set.
- `test/next.test.ts`: `hpipe next` over bv JSON fixtures — held filtering, non-`computed` warning,
  empty tracks.
- `test/startup.test.ts`, `test/board.test.ts`: `clearStrayPanes` spares `Board`, `Board: …` and
  recorded panes; the per-slug lifecycle reopens a ghost by pid and closes a board with no live run.
- `test/integration/smoke.md`: live section on **bd ≥ 1.3.1** and bv ≥ 0.25.2 with a scratch repo —
  setup, one task to close, the board updating, `hpipe next`, an abort releasing the bead and a
  resume re-claiming it.

## README and licence

The README replaces the GitHub-issue setup with the Beads setup, the backup recommendation, the
"never install `br` alongside" note, and states bv's licence rider as written, linking `LICENSE`, so
each user can judge whether it applies to them. No bv code is vendored or forked.

## Out of scope

- GitHub Issues as a backend, or importing existing GitHub issues.
- Cross-project boards (bv workspace mode has no live reload).
- Dolt remotes, `bd dolt push/pull`, the shared server.
- Migrating v2 runs.
- Beads formulas/molecules/gates as the phase engine.

## Pass-1 findings

| Finding | Resolution |
|---|---|
| BLOCKER 1 close guards | Decision 5 (one actor), §6 (no child beads), §4 (adoption refuses open child beads and blockers), §8 (why guards don't fire; `--force` only in `hpipe close`), §11.1, §12 |
| MAJOR 1 escalation path | §6 `hpipe escalate`; shown on the task bead via desired state |
| MAJOR 2 brief / prompt list | §3 `{{brief}}`/`{{bead}}`; §4 every template incl. `dispatch.md`; prompts render test |
| MAJOR 3 agent `bd show` | Decision 7, `hpipe bead show`, §10 outside-process row |
| MAJOR 4 config unreachable from CLI | §1 Binaries |
| MAJOR 5 stale-retry idempotency | Decision 4: only create/show/claim are synchronous (memoised or idempotent); everything else is derived desired state |
| MAJOR 6 lock/timeouts | §2 30 s kill, per-call lock, supervisor try-lock; §5 2 s budget |
| MAJOR 7 claims never released | §5 desired-state table, §3 held predicate, §8 Releases |
| MAJOR 8 board tab | §9 |
| MINOR 1 clock comparison | §8 signal `!== null`, cleared by rewind |
| MINOR 2 close row wiring | §8 close row: no actor/prompt, `probeTarget`; stall clause variants |
| MINOR 3 untyped dep | §2 `depAdd` is `blocks`; discovered uses `--deps discovered-from` |
| MINOR 4 citations / init auto-commit | Evidence corrected; §1 Git isolation |
| MINOR 5 flag shapes | §2 |
| MINOR 6 local bd 1.0.4 | header, §12 smoke on ≥ 1.3.1 |
| MINOR 7 counter restart | §1 Durability |
| MINOR 8 scope | Kept: the user asked for bv triage and approved discovered work |
| MINOR 9 cross-session claims | §3 held predicate scans all sessions |
| MINOR 10 `--prefix` | §1 Prefix |
| MINOR 11 licence | README and licence |

## Pass-2 findings

| Finding | Resolution |
|---|---|
| MAJOR 1 releases fail and wedge the outbox | outbox removed (Decision 4, §5); release is `update --assignee "" -s open`, not `unclaim`; failures never block other work; `orphaned` stays closed; `hpipe close` needs no op bookkeeping |
| MAJOR 2 released beads held forever | §3 held predicate excludes terminal tasks and done runs |
| MAJOR 3 appends after save lose ops | nothing is appended: desired state is derived from the ledger the command already saved |
| MAJOR 4 claims race releases | §5 "Why races are gone"; resume/rewind/re-dispatch just change the ledger; dispatched predicate (`awaiting_brief`) replaces "past research"; rewind to `failed` releases |
| MAJOR 5 drain blocks the tick | §2 per-call lock, §5 2 s budget, folded `update`, one export per pass |
| MINOR 1 close row `probeTarget` | §8 |
| MINOR 2 rewind into `close` / stale close | §8 stall variants; desired state flips on rewind, no pending close exists |
| MINOR 3 `reopen` leaves assignee | §5 desired `in_progress`+`hpipe` after reopen; §11.1 checks reopen→claim |
| MINOR 4 un-block paths | §6: any end of "escalated, unanswered" un-blocks |
| MINOR 5 adopted parents | §4 `--include-dependents`, refuse open child beads |
| MINOR 6 `dispatch.md` | §4 Prompts |
| MINOR 7 board lifecycle | §9 exact-`Board` exemption, pid-based ghost rule, `${SHELL:-/bin/sh}`, `bv` as a child |
| MINOR 8 ceiling scope | §1 Git isolation: every spawn; guard runs without it |
| MINOR 9 drain placement | §5 own loop after the advance loop, own `saveOrReapply` |
| MINOR 10 child-pid lock | §2 dropped |
| MINOR 11 small inaccuracies | one `phase:` label (no `outcome`); no `unclaim`; prefix trim |
