# Adversarial review: Beads as the issue store, pass 1

Spec: `docs/superpowers/specs/2026-10-02-beads-issue-store-design.md` (branch
`docs/beads-issue-store-spec`, pass 1, written against `31e6b2d`).

I take the fixed decisions as given: Beads replaces GitHub Issues, one embedded DB per project in
the state dir, writes split by role through one locked module, agents never write through `bd`, bv
as a read-only board via `--db <jsonl>`, no v2 migration. This review checks whether the design
implements them correctly against the plugin code, beads v1.3.1 and beads_viewer v0.25.2. bv was
read at `v0.25.2-3-g6c6efa1`.

## What holds up

- **Most plugin citations are accurate.** These all check out: `main.ts:50-52,200-203` (schema
  filter), `main.ts:94-110` (stale pid reclaim), `machine.ts:229-251`, `tasks.ts:118,221,393-410,594`,
  `worker-prompt.ts:23`, `verdict-path.ts:19-21`, `stall.ts:341-352`, `startup.ts:128-139`,
  `cli.ts:223-226,237,335-336,405,811`, `cli.ts:1085` (state-dir fallback), `config.ts:23,48,95`,
  `herdr-plugin.toml:77-81`, `actions/supervisor.ts:21-30` and `ledger.ts:40` (`schema_version: 2`).
- **bd facts that check out in source:**
  - An explicit `BEADS_DIR` is authoritative and is never walked up from (`internal/beads/beads.go:772-785`).
  - `bd init` with an explicit `BEADS_DIR` in a non-git cwd skips `git init` (`cmd/bd/init.go:1123`).
  - `export.auto` defaults to false (`internal/config/config.go:330`), and `--non-interactive` never
    prompts to enable it (`init.go:2024-2042`).
  - `bd comment <id> --file` exists (`comment.go:62`). So do `update --add-label/--remove-label`
    (`update.go:989-990`) and the persistent `--actor` flag (`main.go:875`).
  - `show --include-comments` exists (`show.go:309`).
  - `bd export -o` writes atomically (`export.go:119`, `atomicfile`).
  - `issue_id_mode counter` is documented (`docs/reference/configuration.md:300,338`).
  - Re-closing an already-closed issue is an exit-0 no-op (`cmd/bd/close.go:178-200`). So is
    re-claiming your own claim (`internal/storage/issueops/claim.go:148-150`).
- **bv facts that check out:**
  - `--db` sets `BEADS_DB` (`cmd/bv/main.go:1937-1943`).
  - An explicit `.jsonl` path is loaded directly, before the bd-workspace bridge that runs
    `bd export` (`internal/datasource/load.go:150-154,306-311`). The TUI reloads from that file
    (`pkg/ui/model.go:364-383`).
  - The `O` edit path shells out to `br` (`pkg/ui/model.go:262-283`).
  - `--robot-triage-by-track` exists (`robot_registry.go:1674`). Its JSON carries `triage.status`,
    `alerts`, `blockers_to_clear` and `recommendations_by_track[].top_pick` with `reasons` and
    `unblocks_ids` (`pkg/analysis/triage.go:41-52,129-133,442-447`).
  - Outside a git repo the history correlation is simply skipped (`robot_registry.go:2167-2190`).
- **Phase mirroring is ordered correctly.** It runs after the ledger save and repairs on the next
  tick. Re-closing is idempotent. So a crash between a successful `bd close` and the ledger save
  does not wedge the task: the next tick's re-close returns 0 and sets `bead_closed_at_ms`.

## Findings

### BLOCKER 1: `Bd.close` as specified is refused by bd 1.3.1, so every task strands in `close`

**Claim (§2, §4, §8).** `dispatch` claims the bead with `update --claim` as `hpipe:orchestrator`. The
supervisor later closes it with `close <id> -r …` as `hpipe:supervisor`. If that fails five times,
`hpipe close --task tN` "does the same `Bd.close`". §3 also says "a bead cannot be closed by anything
but hpipe".

**Problem.** bd 1.3.1 has three close guards, and the design trips each one.

1. **Assignee guard. This fires on every task.** `closeDirectCheckOne` runs
   `validateIssueClosable(id, issue, actor, force)` on any bead that is not already closed
   (`cmd/bd/close_direct.go:83-87`). That chains `validation.AssigneeMatches(actor, force)`
   (`cmd/bd/show_unit_helpers.go:27-35`). It refuses with "cannot close X: assignee is
   "hpipe:orchestrator", actor is "hpipe:supervisor"; reclaim or use --force"
   (`internal/validation/issue.go:165-175`). `CanonicalActor` only folds `.`, `_` and `-`
   (`issue.go:112-138`), so the two `hpipe:` actors never match. The claim at dispatch sets
   `assignee = actor` (`issueops/claim.go:113-128`). So the supervisor's close fails on every task,
   and the "after 5 failures → `hpipe close`" escape calls the same method and fails too.
2. **Open children.** `enforceClosePolicyForTargetInTx` refuses a target with open parent-child
   dependents, *even when the target is already closed* (`internal/storage/issueops/close.go:120-160`).
   §6 creates decision beads with `--parent <task bead>`. A decision bead stays open in three cases:
   the decision-mirror close fails (§6 says this is "logged" and not retried); the decision is
   abandoned on pane death (`abandonDecisions`, `src/lib/decisions.ts:38-46`, never touches Beads);
   or the human answers it any way other than `hpipe answer --by human`. In each case the task bead
   can never be closed.
3. **Live blockers.** The same function refuses while an open `blocks` edge exists (`close.go:151-160`).
   A bead adopted with `--bead` can carry blocking deps that hpipe never added. §7's
   `discovered-from` edge may also be created as `blocks`; see MINOR 3.

**Consequence.** The task holds `close`, which is `holdsFiles: true` (`src/lib/phases.ts:157-158`).
So it also blocks every overlapping sibling, and the run never reaches `branch-review`. On this
machine, `bd version` reports **1.0.4**, which predates the assignee guard: a `claim` as one actor
followed by `close` as another succeeds there. The §12 live smoke test would pass locally and the
first real run on 1.3.1 would wedge.

The "only hpipe closes" premise is also false. With `BEADS_DIR` set, the human can `bd close`.
`bd human respond` adds a comment and closes the bead (`cmd/bd/human.go:239-241`). This one is
harmless only because re-closing is idempotent.

**Fix.**
- Close as the assignee: use one actor (`hpipe`) for every write, or pass
  `--actor hpipe:orchestrator` on the close. Keep `hpipe:supervisor` only for label writes.
- Decide explicitly whether `close --force` is used. If it is, say that it bypasses the children
  and blocker policy, not the version CAS (`close.go:56-66`).
- Close or dismiss child decision beads in `abandonDecisions` and on any failed mirror, with a retry.
- Make the stall clause print bd's refusal text verbatim.
- Add a `test/bd.test.ts` case where the fake bd refuses a mismatched actor.
- State in §1 that bd below 1.3.1 differs in close semantics, and run the smoke test on 1.3.1.

### MAJOR 1: The decision bead hangs off an escalation path that does not exist

**Claim (§6).** "When the orchestrator escalates (the existing path that leaves a decision awaiting
`--by human`), hpipe runs `Bd.create({type: 'decision', …})` and `Bd.setStatus(<task bead>,
'blocked')`."

**Problem.** No hpipe code path marks a decision as escalated to the human. `prompts/decision.md`
tells the orchestrator to ask the human in prose. It then records the outcome after the fact with
`hpipe answer … --by orchestrator|human`. `answer` (`src/cli.ts:850-888`) and `answerDecision`
(`src/lib/decisions.ts:22-31`) only record who answered. The ledger never holds an "awaiting the
human" state, so the create has no trigger.

The surfaces the section advertises also do not work as described:

- **`bd human list` finds nothing.** It cannot locate the DB without `BEADS_DIR`, and Decision 3
  deliberately makes the DB undiscoverable from the repo.
- **`bd human respond` loses the answer.** It closes the decision bead with the answer as a comment
  (`human.go:240`). hpipe never reads that comment, so the task stays `blocked-on-decision`.
- **`--parent` copies the task's labels.** Labels are inherited by default (`create.go:935`
  `--no-inherit-labels`), so the decision card carries a `phase:` label that is never updated.

**Fix.** Either add an explicit command, e.g. `hpipe escalate --task tN --decision dN`, that records
"awaiting human" on the ledger and creates the bead, or drop the decision-bead mirror (YAGNI). The
human answers in the orchestrator pane today anyway. If it stays:

- Pass `--no-inherit-labels`.
- Tell the human never to use `bd human respond`, or poll for it.
- Give the human a `BEADS_DIR` recipe.

### MAJOR 2: The worker's own brief read is not replaced, and the prompt list is incomplete

**Claim (§8, Evidence table).** `pr-review*.md` and `spec-review.md` read the brief with
`hpipe brief --task tN`. The prompt change list names 13 prompts. "The check that treats a missing
closing keyword as a failure is removed."

**Problem.**

- **The worker's read path is never replaced.** The worker's primary read is
  `prompts/worker-brief.md:8`, `gh issue view {{issue}}`. `research.md:8` and `spec.md:3` are about
  "issue #N" too. The spec never says what replaces them, and `hpipe brief` today prints
  `renderWorkerPrompt` (`src/lib/worker-prompt.ts:16-36`), the same template that says
  `gh issue view`. Pointing the reviewers at `hpipe brief` is therefore circular unless
  `worker-brief.md` inlines `Task.brief` (title, description, acceptance). The spec never says it
  does. The "`brief` refresh" caller of `Bd.show` (§2 table) is not defined either.
- **`decision.md:15` still sends the orchestrator to "issue #N".**
- **Five prompts are missing from the change list.** `plan.md`, `plan-review.md`, `merge.md`,
  `ci-red.md` and `pr-review-quality.md` all render `{{issue}}`. `render()` throws on an unresolved
  placeholder (`src/lib/render.ts:8-13`). So renaming the var to `{{bead}}` without editing these
  throws at delivery, in front of an agent. `README.md:118,127` documents `--issue` and
  `gh issue create` and is not listed.
- **No code checks the closing keyword.** The rule exists only as prompt text (`worker-brief.md:67-71`,
  `implement.md:22-27`). Removing the prose is the whole change.

**Fix.** State that `worker-brief.md` inlines the snapshot, or tells the worker to run
`hpipe brief --task tN`, and that `hpipe brief` prints the bead body. List every template that
renders `{{issue}}`, plus the README. Add a test that renders every prompt with the new variable
set.

### MAJOR 3: The orchestrator's `bd show` cannot find the database and bypasses the lock

**Claim (Decision 4).** "The orchestrator agent reads only through `hpipe next`, `hpipe brief` and
`bd show`."

**Problem.**

- **The pane cannot find the DB.** herdr does not inject plugin env into agent panes (`cli.ts:1085`
  falls back for exactly that reason; `bin/hpipe` header). So the orchestrator has no `BEADS_DIR`.
  From the repo cwd, `bd show` walks up looking for a `.beads` (`beads.go:771-800`). It finds
  nothing, or a stray `.beads` in that repo or an ancestor, and reads the wrong store.
- **It bypasses `hpipe.lock`.** Beads documents embedded mode as "single-writer (enforced via file
  lock)", with "database is locked" as the symptom (`docs/architecture/dolt.md:163,521-525`). An
  agent's `bd show` that overlaps a supervisor write can fail that write. §10 has no row for it,
  and §2's claim that the lock makes the two-process behaviour "irrelevant" is untrue once any
  non-hpipe process touches the DB.

**Fix.** Add `hpipe bead show <id>` (locked, `BEADS_DIR` set) and remove `bd` from every agent
prompt. Add a §10 row for a "database is locked" failure from an outside process, retried like any
other `BdFailure`.

### MAJOR 4: `BD_BIN`/`BV_BIN` "from config" is unreachable from the CLI, which makes most `bd` calls

**Claim (§1 Config).** "`BD_BIN` … `BV_BIN` … Code reads them from `config`, never from raw env — the
existing `cli.ts:223-226` … bypass of `config.GH_BIN` is not repeated."

**Problem.** The CLI loads no config at all. `cli.ts` never calls `loadConfig`, and
`src/lib/models.ts:1-6` says why: "only the supervisor loads config, and the CLI renders prompts
too". The `Gh(undefined, …)` bypass exists because of this, not by oversight. The tiers pass-1
review raised this as its BLOCKER 1, and the fix there was to avoid config.

Here `create`, `show`, `claim`, `comment`, `depAdd`, `hpipe close`, `hpipe next` (bv) and the setup
path all run in the CLI. As written, the CLI would silently use `bd`/`bv` from `PATH` while the
supervisor uses the configured binary. Two different bd versions could then write one embedded
store.

**Fix.** Pick one:

- Give the CLI a config dir. `herdr plugin config-dir` exists, and `bin/hpipe` already asks herdr
  for the plugin root.
- Drop the keys and resolve `bd`/`bv` from `PATH` everywhere, with the version check in both
  processes.

### MAJOR 5: `bd` writes inside stale-retried CLI commands are not idempotent

**Claim (§4, §6).** Only `Bd.create` in `cmdTask` is memoised "across stale retries".

**Problem.** `cmdAnswer = retryingOnStale(answer)` (`cli.ts:888`) re-runs the whole function on a
stale save. So do `decide`, `rewind` and `release`. The supervisor saves every 1 s tick (`TICK_MS`,
`config.ts:29`), so a stale retry is a normal event; `cmdTask`'s memo exists because it happened.
§6 puts these writes inside those functions:

- `Bd.comment` ("Ruling on …") is not idempotent: each retry posts another comment.
- The decision `Bd.create` makes a new bead each time.
- In `cmdTask`, `depAdd`, the `--bead` path's `hpipe:run=` label write and the brief `Bd.show` are
  not memoised. They re-run per attempt.

§10's "nothing half-registers" does not say whether a `depAdd` failure after a successful create
fails the registration.

**Fix.** Do Beads writes after the ledger save has landed, outside the retry, as a mirror keyed by a
ledger field (`decision.bead`, `ruling_posted_at`). Or memoise them per invocation like
`fileIssueOnce`. Say whether a `depAdd` failure is fatal.

### MAJOR 6: One lock, no process timeout, and a serial supervisor loop

**Claim (§2).** Every call holds `<slug>/hpipe.lock` with a 10 s acquire timeout. Stale holders are
reclaimed like the pid file. Each write exports inside the same hold. A dirty marker re-exports "on
the next write or tick".

**Problem.**

- **A hung `bd` stops the supervisor.** Nothing bounds the `bd` process. `Gh.run` has no timeout
  (`src/lib/gh.ts:44-55`), and `Bd` is "shaped like `Gh`". A hung `bd` holds the lock with a live
  holder pid, so it is never reclaimed. If it is the supervisor's, the loop (`main.ts:196-483`,
  strictly serial) stops for every run in the session.
- **Lock waits stack up in a tick.** A CLI holder costs the supervisor up to 10 s per call. A tick
  with several transitions, a merge close and a dirty re-export makes several calls. Measured here
  with bd 1.0.4 on an empty DB: `create` 0.69 s and `export` 0.38 s. So one `hpipe task` holds the
  lock for about 2-4 s across create, export, show, depAdd and export. The supervisor waits behind
  that while deliveries, confirmation windows (`PROMPT_CONFIRM_MS` 15 s) and the 2 s idle-read
  freshness bound (`main.ts:44`) age.
- **The lock is not re-entrant.** If the dirty-marker re-export inside a locked write calls the
  public `export()`, it waits on itself for 10 s and fails.
- **An orphaned `bd` keeps writing.** If a CLI is killed mid-call, its `bd` child keeps writing
  after the lock is reclaimed. That is the two-writer case the lock exists to prevent.

**Fix.**

- Spawn `bd` with a timeout and kill it.
- Make the supervisor try-lock with no wait and defer to the next tick; that is safe because every
  supervisor write is already retried.
- Export through an internal, unlocked helper.
- Record the `bd` child's pid in the lock file and treat the lock as live while that pid is alive.

### MAJOR 7: Beads are only ever closed on merge; every other ending leaves them claimed forever

**Claim (§4, §5).** `dispatch` claims the bead. Terminal rows `done`/`orphaned` drop the phase label
and `escalated`/`failed` set one.

**Problem.** Nothing releases a claim. A task can end in `failed`, `orphaned`, `blocked-on-failure`,
an abandoned escalation, `hpipe forget` or an aborted run. Its bead stays `in_progress` and assigned
to `hpipe:orchestrator`. bv's "claimable" requires unassigned (§Evidence), so `hpipe next` never
recommends it again and the backlog silently loses it.

The same goes for status: a bead set `blocked` by §6 stays `blocked` if the task dies. A later
re-dispatch then fails, because `--claim` only claims from `open` (`claim.go:61-69`) and refuses a
`blocked` bead even for the same actor (`claim.go:148-160`).

A rewind to before the PR after a merge resets the PR fields (`cli.ts:755-761`, which resets
`issue_closed_at_entry`). The spec never says to reset `bead_closed_at_ms` or reopen the bead, so the
rework runs on a closed card.

**Fix.**

- On any terminal-bad row, and on forget or abort, unclaim (`update --assignee "" -s open`, or
  `bd unclaim`) and label the outcome.
- On a rewind before `implement`, reopen the bead and null `bead_closed_at_ms`.
- Claim `blocked` beads by setting the status back first.

### MAJOR 8: The board tab's identity and lifecycle are underspecified and racy

**Claims (§9, §11 item 4).**

- The pane is labelled `Board: <repo basename>`.
- `clearStrayPanes` and `reapGhostPanes` "would kill the tab".
- How `board.ts` learns its repo is deferred, with a label-keyed fallback.

**Problem.**

- **§11 item 4 is already answered.** The installed `herdr plugin pane open --help` lists
  `--env KEY=VALUE` and `--cwd PATH`. Pass `--env HPIPE_BEADS_SLUG=…`. The "ask which board is
  missing" fallback is unnecessary and would race when startup reopens several boards at once.
- **The label is not set at open.** A plugin pane's label is the manifest `title`:
  `SUPERVISOR_LABEL` equals the supervisor pane's `title` (`startup.ts:9`, `herdr-plugin.toml:79`).
  So every board opens with the same title and needs a `herdr pane rename` afterwards. Startup runs
  `clearStrayPanes` right after opening panes (`startup.ts:181-189`). A board opened before that
  call, or renamed after it, is closed.
- **`reapGhostPanes` would not kill the board.** It only touches panes labelled
  `Pipeline supervisor` (`startup.ts:57`), so that half of the claim is wrong.
- **The workspace is unstated.** Without `--workspace`, a pane lands in the active workspace (base
  spec "Verified herdr facts", row at line 185). `hpipe start` runs in the orchestrator's pane, so
  the spec must say which workspace the board opens in.
- **Lifetime is per run but content is per repo.** The board closes only on `done`. It leaks on
  abort, forget and escalated runs. Runs for the same repo in two herdr sessions get two boards on
  one DB. Basename labels collide across clones, which `<repo-slug>` exists to separate.

**Fix.** Open with `--env`. Have `board.ts` rename its own pane from `HERDR_PANE_ID` before drawing.
Exempt the board in `clearStrayPanes` by entrypoint as well as label. Key the label by slug. Pick
one lifetime: per repo, closed when no live run for that slug remains in the session.

### MINOR 1: The close signal compares the local clock to GitHub's

`bead_closed_at_ms` is local `Date.now()`, while `merged_at_ms` is GitHub's `mergedAt`
(`gh.ts` `prView`). If the local clock is behind GitHub by more than the delay before the merge is
seen, `bead_closed_at_ms >= merged_at_ms` is false. The close then never retries, because it
succeeded, and the task parks until the 45-minute stall. The comparison adds nothing: the only
writer is the post-merge path.

**Fix.** Use `bead_closed_at_ms !== null`, reset on any rewind that clears `merged_at_ms`. Or compare
against `phase_entered_at` of `merge`, which uses the same clock.

### MINOR 2: The close row's retry and stall wording does not match the machinery

- **"5 consecutive failures" contradicts "monotone counter".** A monotone counter is never reset, so
  "consecutive" cannot hold. Use "5 failures".
- **The stall clause is time-triggered, not counter-triggered.** It is delivered by stall probing
  after `TASK_STALL_MINUTES` (45 min, `config.ts`) whatever the counter says. Say that the clause
  text switches on the counter.
- **"Retried each tick" is false.** The close row is `actor: 'orchestrator'` (`phases.ts:157`), so
  it is evaluated only while the orchestrator is idle or absent (`tasks.ts:242`). Drop the actor if
  the row no longer prompts.
- **Deleting `prompts/close.md` throws.** The row still names `prompt: 'close'` (`phases.ts:158`),
  and `renderTaskPhasePrompt` still renders it (`tasks.ts:143-144`). Deleting the file throws on
  entry unless both change; the spec lists neither.
- **The close write sits inside signal gathering.** Calling `Bd.close` from `gatherSignals` puts a
  write in a read path. Say where it lives, and that it is not recorded through `effects`
  (`tasks.ts:53-54`) because re-closing is idempotent.

### MINOR 3: `depAdd` has no type, so `discovered-from` would be created as `blocks`

`bd dep add` defaults to `--type blocks` (`dep.go:1534`), and the §2 method table passes no type.
§7's "`discovered-from` dependency" would therefore become a blocking edge. In the reverse direction
it would block the task bead's close (BLOCKER 1, item 3).

**Fix.** Add `type` to `depAdd`, or use `create --deps discovered-from:<id>` (`create.go:936`).

### MINOR 4: Wrong or loose citations and descriptions

- `src/lib/tiers.ts:25-60` reads no labels. `registrationTier` only parses them; the read is
  `cli.ts:226,323`.
- `repoKey` (`repo.ts:17-25`) is the absolute root path with no hash. The basename-plus-hash slug is
  new code, not an existing helper.
- "After `advanceTasks` (`main.ts:297-318`) saves the ledger": `advanceTasks` is `main.ts:301-324` and
  saves nothing. The save is `saveOrReapply` at `main.ts:375`. The second save for `bead_synced_row`
  needs the same stale handling, and the spec does not mention it.
- `task.row` does not exist; the field is `task.phase`.
- **Evidence row on `bd init`.** The auto-commit is gated on `!stealth && isGitRepo() &&
  useLocalBeads` (`init.go:2152`), not on `--skip-agents`/`--skip-hooks`. If `$STATE` sits inside
  a git work tree, as with a dotfiles repo at `$HOME`, `bd init` commits there. Run setup with
  `GIT_CEILING_DIRECTORIES=<slug's parent>` or refuse when `git rev-parse` succeeds in the cwd.

### MINOR 5: Flag shapes

- `create --acceptance` takes a string (`cmd/bd/flags.go:32`). There is no acceptance file flag, so
  `acceptanceFile` must be read and passed inline.
- `close -r` with a multi-line human answer belongs in `--reason-file` (`close.go:491`).
- `bd config set status.custom ""` restates the default; drop it.
- Outside git, bd prints a `beads.role not configured` warning on stderr. Parse only stdout.

### MINOR 6: The installed `bd` is 1.0.4

`bd version` here reports 1.0.4, below the 1.3.1 floor. The startup check will warn. But every local
smoke-test result will reflect 1.0.4 semantics; see BLOCKER 1. Say in §12 which version the smoke
test must use.

### MINOR 7: Counter IDs restart if the state dir is lost

The DB is now the only copy of the backlog, kept in a plugin-managed dir with no remote (Dolt
remotes are out of scope). If it is lost or recreated, the counter restarts at `<prefix>-1`.
Verdict filenames carry no date (`verdict-path.ts:10-12`), so new `hp-1-pr-review-0.md` files
collide with ones already committed. Decision 3 names "issues do not travel with the code" but not
loss.

**Fix.** Either:

- State the durability cost and recommend `bd backup`, or copy `issues.jsonl` somewhere durable.
- Keep hash IDs.

### MINOR 8: Scope creep

The board and `next` go well beyond replacing GitHub Issues:

- §7 (`discover`/`discoveries`) is a new feature.
- `hpipe next` / bv triage is too.
- The decision-bead mirror (MAJOR 1) also adds surface.

Each adds commands, ledger fields and prompt text. Consider shipping the swap first and these
after.

### MINOR 9: Cross-session double claims

The "another live run's ledger already holds it" check uses session-scoped `listRuns`. Every run
claims as the same actor, and a same-actor claim is idempotent (`claim.go:148-150`). Two sessions
can therefore adopt the same bead without bd objecting.

**Fix.** Scan all sessions' run files, or claim as `hpipe:<run_id>`. The second option changes the
close actor; see BLOCKER 1.

### MINOR 10: The `--prefix` flag and the duplicate-prefix refusal

"Overridable with `--prefix`" does not say which command takes the flag; `hpipe start` has none.
Setup refuses a prefix recorded in another `project.json`. A second clone of the same repo then
fails `hpipe start` with no in-command remedy except the herdr action.

### MINOR 11: The bv licence summary understates the rider

`LICENSE` defines "use" to include "executing … or incorporating the Software … into any … pipeline
for … automated systems". Its rider goes beyond derivative works: it voids all rights for, and
forbids making the software available "to or for", Restricted Parties. That includes anyone "acting
… on behalf of, for the benefit of, or under the direction of" Anthropic or OpenAI. The plugin is
public. The README should state the rider as written, so that users of the plugin can judge whether
it applies to them.

## On §11 "verify before implementing"

- **Item 4 is answered now** (`--env`/`--cwd` exist). Fold it into §9 rather than deferring it.
- **Item 2 is answered by beads' own docs** (embedded is file-locked, single-writer, "database is
  locked"). The lock's necessity does not need an experiment. What does need deciding is how
  outside readers interact with it (MAJOR 3).
- **Item 1 is largely answered by source** (`init.go:1123,2152`). The remaining risk is a git work
  tree around `$STATE` (MINOR 4).
- **Missing from the list and design-blocking:** the bd 1.3.1 close guards (BLOCKER 1). They decide
  the close path, the actor scheme and whether `--force` is used.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 8
MINORS: 11
