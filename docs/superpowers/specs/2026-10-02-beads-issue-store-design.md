# Beads as the issue store — design

Pass 2. Written against `main` at `31e6b2d`. Pass 1 was reviewed adversarially in
`docs/superpowers/reviews/2026-10-02-beads-issue-store-adversarial-1.md` (BLOCKER, 1/8/11). Every
finding is resolved below; the table at the end maps each to where it landed.

GitHub Issues stops being hpipe's issue store. [Beads](https://github.com/gastownhall/beads) (`bd`
≥ 1.3.1) replaces it outright: one embedded Dolt database per project, kept in the plugin's state
dir, written only by hpipe code. [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)
(`bv` ≥ 0.25.2) gives the human a live kanban/graph tab per project and gives the orchestrator a
deterministic triage engine (`hpipe next`). `gh` stays for PRs, CI and merge.

**On-disk format change.** The ledger moves to `schema_version: 3`. The supervisor already ignores
runs whose schema it does not know (`src/supervisor/main.ts:50-52,200-203`). v2 runs are not
migrated: finish them on the previous release before upgrading, then restart the supervisor.

**Version floor matters.** bd 1.3.1 added close guards (assignee match, open children, open blockers)
that earlier releases lack; behaviour below 1.3.1 is not supported and the smoke test must run on
≥ 1.3.1 (the machine this was written on has 1.0.4).

## Evidence

From the tools' sources at the tagged versions (cloned read-only on 2026-10-02; pass-1 review
re-verified each):

| Fact | Source |
|---|---|
| Embedded mode keeps data in `.beads/embeddeddolt/`, needs no `dolt` binary, and is single-writer, "enforced via file lock"; the symptom of a second process is "database is locked" | beads `docs/architecture/dolt.md:163,521-525` |
| An explicit `BEADS_DIR` is authoritative, never walked up from | beads `internal/beads/beads.go:772-785` |
| `bd init` with an explicit `BEADS_DIR` in a non-git cwd skips `git init`; its auto-commit is gated on `!stealth && isGitRepo() && useLocalBeads`, not on `--skip-agents/--skip-hooks` | beads `cmd/bd/init.go:1123,2152` |
| A linked git worktree auto-discovers the main checkout's `.beads` through the git common dir | beads `docs/reference/worktrees.md` |
| Beads recommends one database per project with its own `--prefix`; there is no project field | beads `docs/reference/faq.md` |
| `issue_id_mode counter` gives sequential IDs | beads `docs/reference/configuration.md:300,338` |
| `close` refuses when the actor is not the assignee (`AssigneeMatches`), when the target has open parent-child dependents, or an open `blocks` edge; `--force` bypasses the policy | beads `cmd/bd/close_direct.go:83-87`, `internal/validation/issue.go:165-175`, `internal/storage/issueops/close.go:120-160` |
| Re-closing a closed issue and re-claiming your own claim are exit-0 no-ops | beads `cmd/bd/close.go:178-200`, `internal/storage/issueops/claim.go:148-150` |
| `--claim` only claims from `open` | beads `issueops/claim.go:61-69,148-160` |
| `bd unclaim` and `bd reopen` exist | beads `cmd/bd/unclaim.go:13`, `cmd/bd/reopen.go:16` |
| `create --acceptance` takes a string; `close --reason-file` and `comment --file` take files; `dep add` defaults to `--type blocks`; `--parent` inherits labels unless `--no-inherit-labels` | beads `cmd/bd/flags.go:32`, `close.go:491`, `comment.go:62`, `dep.go:1534`, `create.go:935` |
| `export.auto` defaults to false; `bd export -o` writes atomically | beads `internal/config/config.go:330`, `cmd/bd/export.go:119` |
| bv loads an explicit `.jsonl` given by `--db` directly, before the bd bridge that would run `bd export` | bv `cmd/bv/main.go:1937-1943`, `internal/datasource/load.go:150-154,306-311` |
| bv watches the JSONL's parent dir with fsnotify, 200 ms TUI debounce; its multi-repo mode has no live reload | bv `pkg/watcher/watcher.go:199-410`, `cmd/bv/main.go:2714` |
| bv "claimable" = open, unblocked, unassigned, not deferred, not an epic | bv `cmd/bv/robot_registry.go:2343` |
| `--robot-triage-by-track` emits `triage.status`, `alerts`, `blockers_to_clear`, `recommendations_by_track[].top_pick{reasons, unblocks_ids}` | bv `cmd/bv/robot_registry.go:1674`, `pkg/analysis/triage.go:41-52,129-133,442-447` |
| The TUI's `O` edit path shells out to `br`, never `bd` | bv `pkg/ui/model.go:262-283` |
| bv's licence is MIT plus a rider that withholds all rights from, and forbids making the software available to or for, OpenAI, Anthropic and anyone acting on their behalf or for their benefit; "use" includes executing | bv `LICENSE` |
| `herdr plugin pane open` takes `--workspace`, `--cwd`, `--env KEY=VALUE` | `herdr plugin pane open --help` (herdr 0.9.x) |

And hpipe today:

| Where | What |
|---|---|
| `src/lib/gh.ts:111-137` | `issueView`, `issueLabels`, `issueCreate` |
| `src/cli.ts:223-226,237-457` | filing and the label read (`cli.ts:226,323`) in `registerTask` / `cmdTask`; `fileIssueOnce` memo across stale retries |
| `src/lib/tiers.ts:25-60` | `registrationTier` parses `pipeline:tier-<name>` from labels it is handed |
| `src/supervisor/main.ts:301-324,375` | `advanceTasks`; the tick's `saveOrReapply` |
| `src/supervisor/tasks.ts:143-144,393-410` | close prompt render; merge/close signals via `issueView` |
| `src/lib/machine.ts:229-251` | `issue_closed_at_entry`; close advances on `issueClosed && (atEntry || closedAtMs >= merged_at_ms)` |
| `src/lib/phases.ts:155-158` | `merge` and `close` rows, both `actor: 'orchestrator'`, `holdsFiles: true`; close names `prompt: 'close'` |
| `src/lib/gating.ts:137-153` | a dependent starts only once every dependency is `TERMINAL_OK` |
| `src/lib/decisions.ts` | `openDecision`, `answerDecision`, `abandonDecisions`; no "awaiting human" state |
| `src/cli.ts:205,755-761` | rewind into `PHASES_BEFORE_A_PR` resets PR fields and `issue_closed_at_entry` |
| `src/cli.ts:949-997` | `abort` (run → `done`, resumable), `resume`, `forget` (unbinds a workspace only) |
| `src/cli.ts:888` and siblings | `answer`, `decide`, `rewind`, `release` wrapped in `retryingOnStale` |
| `src/lib/models.ts:1-6` | the CLI loads no config; only the supervisor does |
| `src/lib/render.ts:8-13` | `render()` throws on an unresolved placeholder |
| `prompts/*.md` | 14 templates render `{{issue}}`: `research`, `spec`, `spec-review`, `plan`, `plan-review`, `implement`, `pr-review`, `pr-review-intent`, `pr-review-quality`, `ci-red`, `merge`, `close`, `decision`, `worker-brief` |
| `prompts/worker-brief.md:8,67-71`, `implement.md:22-27` | `gh issue view {{issue}}`; the `Closes #N` rule (prompt text only — no code checks it) |
| `prompts/intake.md`, `dispatch.md`, `dispatch-registering.md`, `branch-review.md:8` | `gh issue create`, `--issue <n>`, PR search by issue |
| `skills/herdr-pipeline/SKILL.md`, `README.md:118,127` | "batch of GitHub issues", `--issue`, `gh issue create` |
| `src/startup.ts:45-71,128-139,181-189` | `reapGhostPanes` (supervisor label only); `clearStrayPanes` closes every pipeline-workspace pane not labelled "Pipeline supervisor", run after pane opens |

## Decisions

1. **Replace, don't abstract.** Beads is the only issue backend.
2. **One database per project.** A shared database with a `project:` label was rejected: every `bd`
   and `bv` call would need the filter, bv's graph metrics would score across projects, all
   projects would share a prefix, and one missed filter dispatches another repo's work. A shared
   Dolt server is deferred (an init flag, adoptable later without redesign).
3. **The database lives in the plugin state dir** (`$STATE/beads/<slug>/.beads`). Worker worktrees
   cannot discover it and the repo stays untouched. Costs accepted: issues do not travel with the
   code; bv's git-backed views are unavailable; the state dir is the only copy (§1 Durability).
4. **Writes split by role: the orchestrator authors, the supervisor delivers.** Beads changes that
   need an answer *now* run synchronously in the orchestrator's hpipe command: create (the ID is
   needed), adopt-validation reads, and the dispatch claim (a refused claim must refuse the
   dispatch). Every other change — dependency edges, labels, status, rulings, phase, close, release —
   is recorded by the authoring command as an op in the task's ledger **bead outbox**, and the
   supervisor drains it. This is how hpipe already delivers prompts (`run.outbox`): commands decide,
   the supervisor delivers. It makes every mirror write idempotent and retried, keeps CLI lock holds
   short, and closes the crash windows between ledger saves and bd writes.
5. **One actor, `hpipe`, for every write.** bd 1.3.1 refuses a close by anyone but the assignee;
   the claim and the close must share an actor. Which layer wrote is visible in the ledger history,
   not in `bd history`.
6. **The supervisor closes the bead on merge**, without `--force`. GitHub auto-closed on
   `Closes #N`; the orchestrator doing it would add a round trip and a stall mode. The design keeps
   the close guards from firing (§8); the manual fallback may `--force`, explicitly.
7. **Agents never run `bd`.** Not workers, not the orchestrator. Reads go through `hpipe` commands
   that take the lock and set `BEADS_DIR`. bv reads only the exported file.
8. **Only hpipe exports.** bv is always launched with `--db <file>`; `export.auto` stays off.
9. **The board is per project, not per run**: one tab per repo slug with a live run in the session.

## 1. Storage and setup

**Layout.** `$STATE` is `HERDR_PLUGIN_STATE_DIR` (fallback `~/.local/state/herdr/plugins/stein.pipeline`,
`src/cli.ts:1085-1086`).

```
$STATE/beads/<slug>/
  .beads/                  bd workspace (embeddeddolt/, config.yaml, metadata.json)
  .beads/issues.jsonl      export read by bv
  hpipe.lock               the Bd lock (§2)
  project.json             { repo_root, prefix, created_at }
```

`<slug>` is new code (`src/lib/beads-project.ts`): the repo root's sanitised basename, `-`, and the
first 6 hex chars of sha256(`repoKey`), where `repoKey` is the absolute repo root
(`src/lib/repo.ts:17-25`). Two clones of the same name get different slugs.

**Prefix.** Default: sanitised basename truncated to 8 chars. `hpipe start --prefix <p>` and the
setup action's prefix input override it. Setup refuses a prefix already recorded in another
`project.json` under `$STATE/beads/`, and the refusal names `hpipe start --prefix <p>` as the remedy.

**Init.** Run with `cwd = $STATE/beads/<slug>`, `BEADS_DIR` set, and
`GIT_CEILING_DIRECTORIES=$STATE/beads` (so a git work tree around `$STATE`, e.g. a dotfiles repo at
`$HOME`, cannot be found). As a second guard, setup refuses if `git rev-parse --is-inside-work-tree`
succeeds in that cwd.

```
bd init --prefix <p> --skip-agents --skip-hooks --non-interactive
bd config set issue_id_mode counter
bd export -o .beads/issues.jsonl
```

**Triggers.** `hpipe start` runs setup when `project.json` is absent, before `newRun`. A herdr action
**Set up Beads for this repo** (`src/actions/beads-setup.ts`) runs it on demand.

**Binaries.** `bd` and `bv` resolve from `PATH` in every process; env `BD_BIN` / `BV_BIN` override
(as `GH_BIN` does today for tests, `src/lib/gh.ts:35-39`). There are no `config.env` keys: the CLI
loads no config (`src/lib/models.ts:1-6`), and a key only the supervisor honoured would let two bd
versions write one store. Both the CLI (`hpipe start`, `status`) and startup check
`bd version` ≥ 1.3.1 and `bv --version` ≥ 0.25.2. `hpipe start` refuses without a good `bd`; it
proceeds without `bv` (no board, `hpipe next` errors with the install hint). `hpipe status` shows a
`tools:` line when either is missing or too old.

**Durability.** The state dir is the only copy of the backlog. If it is lost, re-running setup
restarts the counter at `<prefix>-1`, and new artifact names (`<bead>-pr-review-0.md`) would collide
with ones already committed. Setup therefore scans the repo's `docs/superpowers/` for names matching
`<prefix>-<n>` and refuses the prefix if any exist, naming `--prefix` as the remedy. The README
recommends including `$STATE/beads` in the user's backups.

## 2. The `Bd` module

`src/lib/bd.ts`, a class in the shape of `Gh` (`src/lib/gh.ts:35-55`): every call runs
`<bd> --json --actor hpipe …` with `env.BEADS_DIR = <slug>/.beads`, `cwd = <slug>`, and parses
**stdout only** (outside git, bd prints a `beads.role` warning on stderr). A spawn failure returns
code -1 like `Gh.run`.

**Process timeout.** Every `bd` spawn is killed after 30 s and returns a `BdFailure{timeout}`.

**Lock.** Every call holds `<slug>/hpipe.lock`, built on the `src/lib/pidfile.ts` primitive
(exclusive create; holder pid and start time). The lock file also records the pid of the `bd`
child. A lock is live while the holder **or** its recorded `bd` child is alive (with matching start
time); otherwise it is reclaimed the way the supervisor reclaims a stale pid file
(`src/supervisor/main.ts:94-110`). That way a killed CLI's orphaned `bd` still blocks a second
writer until it exits or hits its own timeout.

Waiting differs by caller:
- **CLI:** waits up to 10 s, then fails with "Beads is busy, retry".
- **Supervisor:** try-lock, no wait. If held, it skips Beads work this tick and tries next tick. All
  supervisor Beads work is outbox-driven and retried anyway, so the serial tick loop
  (`main.ts:196-483`) never blocks on Beads.

**Export after write.** Each public write method runs its command(s), then exports through a
private, unlocked `#export()` inside the same hold (no self-wait). A failed export sets
`<slug>/export.dirty`; the next locked hold re-exports through `#export()` and clears it.

**Methods** (each returns a typed result or `BdFailure`):

| Method | `bd` call |
|---|---|
| `create({title, body, acceptance?, labels, depsDiscoveredFrom?})` | `create --title <t> --body-file <tmp> [--acceptance <string>] -l … [--deps discovered-from:<id>]` |
| `show(id)` | `show <id> --include-comments` |
| `claim(id)` | `update <id> --claim` |
| `unclaim(id)` | `unclaim <id>` |
| `reopen(id)` | `reopen <id>` |
| `setStatus(id, s)` | `update <id> -s <s>` |
| `labels(id, {add, remove})` | `update <id> --add-label … --remove-label …` |
| `comment(id, file)` | `comment <id> --file <f>` |
| `depAdd(from, to, type)` | `dep add <from> <to> --type <type>` |
| `close(id, reasonFile, {force})` | `close <id> --reason-file <f> [--force]` |

## 3. Ledger changes (`schema_version: 3`)

In `src/lib/types.ts`:

- `Task.issue: number` → `Task.bead: string`.
- `Task.issue_closed_at_entry` → removed.
- New `Task.brief: { title, description, acceptance, labels, captured_at_ms }`, captured from
  `Bd.show` at registration. It is the worker's brief for the life of the run; edits to the bead
  after registration do not reach a running task.
- New `Task.bead_ops: BeadOp[]` (the bead outbox, §5) and `Task.bead_synced_phase: string | null`.
- New `Task.bead_closed_at_ms: number | null` and `Task.bead_close_failures: number` (monotone).
- New `Task.discoveries: { id, title, body_path, filed_bead: string | null }[]` (§7).
- New `Decision.escalated_at: number | null` (§6).
- `Run.schema_version` → 3 (`src/lib/ledger.ts:40`); `runForRepo` (`ledger.ts:349-361`) ignores v2
  files so `hpipe start` is not blocked by them.

Artifact stems `${date}-issue-${issue}` (`src/cli.ts:335-336`) → `${date}-${bead}`; verdict prefix
`issue-${task.issue}` (`src/lib/verdict-path.ts:19-21`) → `${task.bead}`. Display sites rendering
`#${task.issue}` (`status.ts`, `tick.ts`, `deliver.ts`, `awaiting.ts`, `tasks.ts:221`) render the
bead ID.

**Tier override.** The label list handed to `registrationTier` (`src/lib/tiers.ts:25-60`) comes from
`Bd.show(id).labels` instead of `gh issue view --json labels` (`src/cli.ts:226,323`). Same label
`pipeline:tier-<name>`, same precedence.

**Prompt variables.** `{{issue}}` is removed. `{{bead}}` (the ID) and `{{brief}}` (the snapshot,
rendered as title, description, acceptance) are added, set by `tasks.ts:118,594` and
`worker-prompt.ts:23`. All 14 templates in the Evidence table change; §4, §6 and §8 say how.

## 4. Intake, triage and briefs

**Filing.**
`hpipe task --branch <b> (--bead <id> | --title <t> --body-file <p> [--acceptance-file <p>]) --surface <s> [--tier] [--depends-on tN,…] [--files] [--notes] [--keep-worktree] [--run]`

- `--title` path: every validation first, then `Bd.create` last, memoised across stale retries
  exactly as `fileIssueOnce` is today. The acceptance file is read and passed as a string. The
  brief is the create's own input, so no second read is needed.
- `--bead` path (replaces `--issue`): `Bd.show`, memoised the same way. Refuses a bead that is
  closed, assigned, has an open `blocks` dependency, or is held by any run file in **any** session
  (`$STATE/runs/*/`). The brief comes from that show.
- After the ledger save lands, the command appends ops — `labels(+hpipe:run=<run_id>)` and one
  `depAdd(this, dep, 'blocks')` per `--depends-on` — to the task's outbox. Nothing after the create
  runs inside the retry loop, and a failed op never un-registers the task.

**`hpipe next [--limit N] [--label L]`** — read-only, orchestrator-facing.

1. Re-exports under the lock if `export.dirty` exists, then runs
   `bv --robot-triage-by-track --db <slug>/.beads/issues.jsonl` with `cwd = <slug>`,
   `BV_NO_UPDATE_CHECK=1`, `BV_NO_GITIGNORE=1`, killed after 30 s.
2. Drops recommendations whose ID any run file in any session holds.
3. Prints a warning line for any `triage.status` metric that is not `computed`
   (`cycles: timeout — cycle-free not proven`).
4. Prints compact text per track — top pick (ID, title, score, `reasons`, `unblocks_ids`), then the
   track's other IDs — then `blockers_to_clear` and `alerts` if non-empty.

**`hpipe bead show <id>`** — read-only, locked; prints title, status, labels, description,
acceptance and comments. The only way an agent reads Beads.

**Prompts.**
- `intake.md`, `dispatch-registering.md`, `SKILL.md`, `README.md`: GitHub-issue filing is replaced by
  `hpipe task --title/--bead`; the orchestrator runs `hpipe next` before filing new work and adopts
  existing beads where they fit; bv tracks are dependency-independent but know nothing about files,
  so parallel dispatch still requires disjoint `--files`; never run `bd` or `bv` directly.
- `worker-brief.md` inlines `{{brief}}` in place of `gh issue view` (line 8), and `hpipe brief
  --task tN` prints that rendered brief — so the snapshot is the single source.
- `research.md`, `spec.md`, `plan.md`, `plan-review.md`, `spec-review.md`, `pr-review.md`,
  `pr-review-intent.md`, `pr-review-quality.md`, `ci-red.md`, `merge.md`: `#{{issue}}` becomes
  `{{bead}}`; every `gh issue view` becomes `hpipe brief --task {{task_id}}`.

**Dispatch.** `hpipe dispatch --task tN --pane <p>` calls `Bd.claim(bead)` synchronously before
sending the brief; a refused claim refuses the dispatch with bd's message. If the bead is `blocked`
(left so by an escalation on a task that later died, §6), `setStatus(open)` precedes the claim.

**Board columns.** Status shows open / in_progress / blocked / closed; the fine phase is a
`phase:<name>` label on the card. No custom statuses (whether bv renders them as columns is
unverified; §11).

## 5. The bead outbox

`BeadOp = { id, kind, args, attempts, last_error, done_at_ms }`, `kind` ∈ `labels`, `depAdd`,
`setStatus`, `comment`, `phase`, `close`, `release`, `reopen`. `id` is `<task_id>-o<n>`, assigned at
append.

**Drain.** After the tick's `saveOrReapply` (`main.ts:375`), for every run file in the session —
including `done` and aborted runs, so releases still land — and every task with pending ops: if the
try-lock succeeds, run each pending op in order; on success set `done_at_ms`; on failure increment
`attempts`, store `last_error`, and stop that task's queue for this tick (order matters: a status
change must not overtake a close). Save with the same `saveOrReapply` stale handling. One locked
hold per project per tick covers all its ops plus one export.

**Idempotency.** Label, status, dep, claim, unclaim, reopen and close are idempotent in bd. A
comment is not: each comment body ends with `[hpipe-op <op id>]`, and before posting, the drain reads
`Bd.show(bead)` comments and skips if that marker is present. So a crash between bd success and the
ledger save repeats nothing visible.

**Phase.** The drain also compares `task.phase` with `bead_synced_phase` and, when they differ,
applies `labels({add: phase:<new>, remove: phase:<old>})` and records it. Terminal phases: `done`
removes the label (the bead is closed); `failed`, `orphaned` and `escalated` set `phase:<name>`.

## 6. Decisions

Worker-side `decide` / `answer` and `task.decisions[]` are unchanged, and **no decision beads are
created** — a child bead would block the parent's close under bd 1.3.1's open-children guard.
Instead the decision is mirrored onto the task's own bead.

- **New `hpipe escalate --task tN --decision dN`.** `decision.md` tells the orchestrator to run it
  when it puts a question to the human (today that step is prose only). It sets
  `decision.escalated_at` and appends ops: `setStatus(blocked)`, `labels(+hpipe:awaiting-human)`, and
  a `comment` with the question, the worker's recommendation and the orchestrator's. `hpipe status`
  lists escalated, unanswered decisions under "waiting on you".
- **`hpipe answer --by human`** appends `setStatus(in_progress)`, `labels(-hpipe:awaiting-human)` and
  a ruling `comment`.
- **`hpipe answer --by orchestrator`** appends one ruling `comment`. This replaces the hand-written
  ruling comments of earlier specs.
- **`abandonDecisions`** (pane death) appends the same un-block ops for an escalated decision.
- `decision.md:15` reads "the brief (`hpipe brief --task {{task_id}}`)" instead of "issue #N".

All of these append after the command's ledger save, outside `retryingOnStale`.

## 7. Discovered work

- **Worker:** `hpipe discover --task tN --title <t> --body-file <p>` appends to `task.discoveries[]`
  and copies the body into `$STATE/runs/<session>/<run_id>.discoveries/`. No Beads access.
- **Orchestrator:** `branch-review.md` adds a step: `hpipe discoveries` lists them;
  `hpipe discoveries --file` runs `Bd.create` per unfiled discovery with
  `labels: ['hpipe:discovered']` and `depsDiscoveredFrom: <task bead>` (a non-blocking edge), storing
  `filed_bead` so a retry files nothing twice.
- `worker-brief.md` gains one line: out-of-scope bugs and follow-ups go to `hpipe discover`, not into
  the current PR.

## 8. PRs, close and releases

**PR body.** The `Closes #N` rule in `worker-brief.md:67-71` and `implement.md:22-27` is replaced by
"the PR body ends `Refs {{bead}}`". It was prompt text only; no code changes.

**Close on merge.** When the merge signal clears (`tasks.ts:393-405`, `machine.ts:229-238`), the
effect that records `merged_at_ms` / `merge_commit` also appends a `close` op with reason
"merged in PR #<pr> (<merge_commit>)". The drain runs it without `--force`. On success it sets
`bead_closed_at_ms`.

Why the guards do not fire:
- **Assignee:** claim and close both run as `hpipe` (Decision 5).
- **Open children:** hpipe creates no child beads (§6); discovered beads link with non-blocking
  `discovered-from`.
- **Open blockers:** `--bead` refuses beads with open blockers, and a dependent is only dispatched
  once every dependency is `TERMINAL_OK` (`gating.ts:137-153`), by which point its bead is closed.

**Close row.** In `src/lib/phases.ts:157-158` the `close` row loses `actor` and `prompt`;
`tasks.ts:143-144` stops rendering it; `prompts/close.md` is deleted. Its signal
(`machine.ts:240-250`) becomes `task.bead_closed_at_ms !== null`. That field is written only by the
close op, which is only enqueued by the observed merge, and it is reset by any rewind that clears
`merged_at_ms` — so it is an edge, and no local clock is compared with GitHub's.

**Close failures.** A failed close op increments `bead_close_failures` (monotone). The close row stays
`stallable`; the stall probe is time-based (`TASK_STALL_MINUTES`), and its clause
(`src/supervisor/stall.ts:341-352`, rewritten) switches on the counter: below 5 it reports "waiting
on the Beads close"; at 5 or more it prints the op's `last_error` verbatim and tells the orchestrator
to run **`hpipe close --task tN [--force]`**. That command runs `Bd.close` synchronously (forced only
with `--force`) and sets `bead_closed_at_ms`.

**Releases.** A bead must not stay claimed when its task stops without merging:
- task reaches `failed` or `orphaned` → ops `unclaim`, `setStatus(open)`, `labels(+hpipe:outcome=<phase>)`
  so `hpipe next` can recommend it again;
- `hpipe abort` → the same ops for every unfinished task in the run; `hpipe resume` → `claim`
  (synchronous, as at dispatch) for tasks past `research`;
- rewind into `PHASES_BEFORE_A_PR` after a merge (`cli.ts:755-761`) → `reopen` op, and
  `bead_closed_at_ms = null`, `bead_close_failures` untouched (monotone).
`escalated` keeps the claim: the human may resume the task. `hpipe forget` unbinds a workspace only
(`cli.ts:980-990`) and touches no bead.

**Branch review.** `branch-review.md:8` lists the run's PRs from the ledger (`hpipe show` prints each
task's `pr`) instead of `gh pr list --search "<issues>"`.

## 9. The board tab

**Pane.** A `[[panes]]` entry in `herdr-plugin.toml`: `id = "board"`, `placement = "tab"`,
`title = "Board"`, command `sh -c "bun run src/board.ts; exec $SHELL"` (the supervisor pane's
crash-to-shell pattern, `herdr-plugin.toml:77-81`).

**Open.** `herdr plugin pane open --plugin <id> --entrypoint board --placement tab --no-focus
--workspace <pipeline workspace id> --cwd $STATE/beads/<slug> --env HPIPE_BEADS_SLUG=<slug>`.
`src/board.ts` first renames its own pane (`HERDR_PANE_ID`) to `Board: <basename> <hash6>`, records
`{slug: pane_id}` in `$STATE/boards.<session>.json`, then `exec`s
`BV_NO_UPDATE_CHECK=1 BV_NO_GITIGNORE=1 bv --db $STATE/beads/<slug>/.beads/issues.jsonl`. If `bv` is
missing it prints `brew install dicklesworthstone/tap/bv` and drops to the shell.

**Lifetime: per slug.** The supervisor keeps exactly one board per slug that has a live (not `done`)
v3 run in this session: once per tick it opens a missing one and closes one whose slug has no live
run (covers done, aborted and escalated-then-abandoned runs alike). `hpipe start` does not open it;
the supervisor's next tick does. A board for the same slug in another session is that session's
business. An **Open board** action (pattern of `src/actions/supervisor.ts:21-30`) forces a reopen.

**Startup.** Boards are opened by the supervisor's tick, which runs after `startup.ts` has finished
`clearStrayPanes` (`startup.ts:181-189`), so the two never race. `clearStrayPanes` also spares any
pane whose id is in `boards.<session>.json` or whose label starts with `Board: `, so a restart does
not kill live boards. (`reapGhostPanes` only touches supervisor-labelled panes and needs no change.)

**Read-only by construction.** `--db <file>` keeps bv off Dolt. The TUI's `O` edit path calls `br`;
with no `br` installed it fails harmlessly. The README says not to install `br` alongside. The kanban
is one keypress away (`b`).

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| `bd` missing or < 1.3.1 | `start` refuses; `task` / `dispatch` / `bead show` fail with the version error; `status` shows `tools:` |
| synchronous create / show / claim fails | the command fails with bd's message; nothing is registered or dispatched |
| outbox op fails | `attempts` and `last_error` recorded; that task's queue pauses until next tick; never blocks phase advancement, except `close`, whose row waits on it |
| close op keeps failing | stall clause switches at 5 failures to `hpipe close --task tN [--force]` with bd's error verbatim |
| CLI cannot get the lock in 10 s | "Beads is busy, retry" |
| supervisor cannot get the lock | skips Beads work this tick |
| `bd` hangs | killed at 30 s → `BdFailure{timeout}` |
| an outside process holds Dolt (a human's `bd` with `BEADS_DIR`) | bd reports "database is locked" → `BdFailure`, handled as above; the README tells humans to use `hpipe bead show` |
| export fails | `export.dirty`; re-export on next hold; board lags |
| `bv` missing | board tab shows the install hint; `hpipe next` errors with it; pipeline unaffected |
| bv metric not `computed` | `hpipe next` warns; recommendations still shown |

## 11. Verify before implementing

Step 1 of the plan. Each confirms the design or changes the named section.

1. On bd ≥ 1.3.1: the full op sequence of one task — create, label, dep add, claim, status blocked →
   in_progress, comment, phase label swap, close (no `--force`) — succeeds as actor `hpipe` (§2, §5,
   §8).
2. bv's board with `phase:` labels: are labels legible on cards; does a custom status render as a
   column (§4)?
3. `herdr plugin pane open` with `--env`/`--cwd`: confirm the env reaches the pane and
   `HERDR_PANE_ID` is set for self-rename (§9).

## 12. Tests

- `test/bd.test.ts`: `Bd` against `makeFakeBin` (`test/helpers/fake-bin.ts`) — argv per method,
  `--actor hpipe`, stdout-only parsing, export after writes via the unlocked helper, `export.dirty`
  set and cleared, lock live while the `bd` child lives, CLI 10 s wait vs supervisor try-lock, 30 s
  kill, and a fake bd that refuses a close by a mismatched actor.
- `test/bead-outbox.test.ts`: ordering, pause-on-failure, comment marker skip, phase sync, drain over
  `done` and aborted runs.
- `test/cli-commands.test.ts`, `test/cli-argv.test.ts`: `--title` / `--bead` (memoised across stale
  retries; adoption refusals incl. another session's run), ops appended after save, dispatch claim
  and refusal, `escalate`, `answer` both ways, `abort` / `resume`, `rewind` after merge, `discover` /
  `discoveries --file` (no double filing), `close [--force]`, `bead show`, `--prefix`.
- `test/tasks.test.ts`, `test/table.test.ts`: close row has no actor or prompt; advances only on
  `bead_closed_at_ms !== null`; reset by rewind; failed/orphaned enqueue releases.
- `test/prompts.test.ts`: every template under `prompts/` renders with the new variable set (catches
  a missed `{{issue}}`).
- `test/next.test.ts`: `hpipe next` over bv JSON fixtures — cross-session filtering, non-`computed`
  warning, empty tracks.
- `test/startup.test.ts`: `clearStrayPanes` spares recorded and `Board: ` panes.
- `test/integration/smoke.md`: live section on **bd ≥ 1.3.1** and bv ≥ 0.25.2 with a scratch repo —
  setup, one task to close, board updating, `hpipe next`, an abort releasing the bead.

## README and licence

The README replaces the GitHub-issue setup with the Beads setup, the backup recommendation, the
"never install `br` alongside" note, and states bv's licence rider as written, linking `LICENSE`,
so each user can judge whether it applies to them. No bv code is vendored or forked.

## Out of scope

- GitHub Issues as a backend, or importing existing GitHub issues.
- Cross-project boards (bv workspace mode has no live reload).
- Dolt remotes, `bd dolt push/pull`, the shared server.
- Migrating v2 runs.
- Beads formulas/molecules/gates as the phase engine.

## Pass-1 findings

| Finding | Resolution |
|---|---|
| BLOCKER 1 close guards | Decision 5 (one actor), §6 (no child beads), §8 (why guards don't fire; `--force` only in `hpipe close`; stall shows bd's error), §11.1 on ≥ 1.3.1, §12 refusal test |
| MAJOR 1 escalation path | §6 `hpipe escalate`; mirrored on the task bead, no `bd human` |
| MAJOR 2 brief / prompt list | §3 `{{brief}}`/`{{bead}}`, §4 every template named, `hpipe brief` prints the snapshot, prompts render test |
| MAJOR 3 agent `bd show` | Decision 7, `hpipe bead show`, §10 locked-by-outsider row |
| MAJOR 4 config unreachable from CLI | §1 Binaries: PATH + env override, check in both processes |
| MAJOR 5 stale-retry idempotency | Decision 4 outbox; ops appended after save; create/show memoised; comment markers |
| MAJOR 6 lock/timeouts | §2 30 s kill, child pid in lock, supervisor try-lock, unlocked internal export |
| MAJOR 7 claims never released | §8 Releases (failed/orphaned/abort/resume/rewind) |
| MAJOR 8 board tab | §9 `--env`/`--cwd`/`--workspace`, self-rename, per-slug lifetime, opened after cleanup |
| MINOR 1 clock comparison | §8 signal is `!== null`, reset on rewind |
| MINOR 2 close row wiring | §8 close row loses actor/prompt; counter monotone; stall text switches on counter |
| MINOR 3 untyped dep | §2 `depAdd` typed; discovered uses `--deps discovered-from` |
| MINOR 4 citations / init auto-commit | Evidence tables corrected; §1 `GIT_CEILING_DIRECTORIES` + refusal |
| MINOR 5 flag shapes | §2 acceptance as string, `--reason-file`, no `status.custom`, stdout-only |
| MINOR 6 local bd 1.0.4 | header + §12 smoke on ≥ 1.3.1 |
| MINOR 7 counter restart | §1 Durability: prefix refusal on existing artifacts, backups |
| MINOR 8 scope | Kept: the user asked for bv triage and approved discovered work |
| MINOR 9 cross-session claims | §4 adoption and `next` scan all sessions' run files |
| MINOR 10 `--prefix` | §1 `hpipe start --prefix`; refusal names the remedy |
| MINOR 11 licence | README section states the rider as written |
