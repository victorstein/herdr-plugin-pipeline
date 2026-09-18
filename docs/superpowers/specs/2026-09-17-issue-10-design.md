# `--files` validation and echo — design (#10)

Pass 1. Written against this worktree at `f8b9a67` (branch `fix/10-files-validation`), building on
`docs/superpowers/research/2026-09-17-issue-10-research.md` and answering
`docs/superpowers/reviews/issue-10-spec-review-0.md` and the orchestrator's ownership ruling now at
the bottom of `gh issue view 10`. Every claim about current behaviour carries a `file:line` or the
command that produced it.

**Modelled on** the validation block already in `cmdTask` (`src/cli.ts:62-74`, `102-107`) for the
checks, `src/cli.ts:215` for the echo, `test/cli.test.ts:78-115` for the rejection tests, and
`test/helpers/git-worktree.ts` for the subprocess fixture C5 needs. No new pattern is introduced.

## What changed from pass 0, by finding

Review 0 returned `VERDICT: BLOCKER` — 1 BLOCKER, 3 MAJORs, 4 MINORs. I verified every finding
against the code, the live ledger and the open issues before accepting it; all eight hold. Nothing
was rejected.

**BLOCKER 1 — `test/integration/smoke.md` claimed but owned by neither task.** Accepted, escalated as
decision `d1`, and **ruled**: the file belongs to #10 for this batch (`gh issue view 10`, §Ownership
ruling). So it is taken, not dropped — C4 now covers four files and C5 keeps the runbook as the live
proof. The ruling's reasoning is that #10 *invalidates an assertion* at `smoke.md:100` while #13 only
makes prose stale at `:164-165`, and that a single owner is the only resolution that removes the race
rather than relying on "different hunks are safe", which this project overruled in batch 1. #13 is
directed not to touch the file, and the staleness it leaves is deferred to this run's `branch-review`.

**MAJOR 1 — the durable-state gap was handed to #23, which owns no part of it.** Accepted. `gh issue
view 23 --json body -q .body | grep -in files` returns nothing; its scope is artifacts. A9 and the
`hpipe status` non-goal now hand off to **#17** (which names `files` explicitly in
`hpipe show --task <id>`, and cites this very bug as its motivation) and **#37** (whose third
direction is the in-flight overlap warning in `hpipe status`). #23 survives only as the stated
precedent for the *shape* of such a signal, which is how #37 itself cites it.

**MAJOR 2 — the `test/prompts.test.ts` survey was a misread.** Accepted. That file is 148 lines and
16 `test(` blocks, not the 34 lines and 3 tests I cited. The guard that matters is
`test/prompts.test.ts:68-76`, which fails any prompt containing a literal `hpipe`, and it lands
squarely on C4's one new-prose edit. C4 now carries that constraint explicitly, plus the two other
guards over the files it touches.

**MAJOR 3 — "the unit tests do cover the behaviour" was false for C3.** Accepted, and the most
consequential of the three. `listFlag` is fed only by `dispatch`, which is module-private
(`src/cli.ts:355`), so no unit test can prove `--files` reaches `cmdTask` through the rewritten
parser — and the argv wiring is precisely where this bug lived. That sentence is deleted. The review
offered two fixes and the ruling enables both, so **C5 takes both**: an automated subprocess test that
runs on every `bun test`, and the runbook edit, now in scope rather than deferred. A11 argues why one
is not a substitute for the other.

**MINOR 1** — the "`status.ts` was rewritten by #15 two commits ago" clause is gone;
`git show --stat 93f79b2 -- src/lib/status.ts` is `1 file changed, 19 insertions(+)` at `HEAD~5`.
**MINOR 2** — thirteen `cmd*` exports, not fourteen (`grep -c "^export async function cmd" src/cli.ts`
→ `13`). **MINOR 3** — the two runbook edits are now named separately in C4 and both are committed;
nothing is left to the plan's discretion. **MINOR 4** — C4 now names the comma for `--depends-on` too,
on the same lines.

## Problem

`--files` is the pipeline's only mechanism for serializing two tasks that touch the same code. It is
parsed comma-separated (`src/cli.ts:340-343`), documented as an unseparated plural in all three
user-facing places (`prompts/intake.md:24`, `prompts/dispatch.md:31`, `README.md:80`), and never
validated, echoed, or read by `cmdTask` between its signature (`src/cli.ts:56`) and the line that
stores it (`src/cli.ts:82`).

The measured consequence, from the berean-os ledger still on disk (research §Evidence): five of six
tasks recorded a single space-joined entry; zero pairs overlapped; three pairs would have. `t4`'s
entire `implement` window (08:43:14–08:49:25) sat nested inside `t5`'s (08:41:14–08:53:07) — six
minutes of two workers on four shared reader files.

The part that decides this design: **the gate ran and wrote a false all-clear into the durable
record.** Ten history entries, five tasks, each released from `blocked-on-files` about two seconds
after entering it, every one reading `"why":"no overlapping files in flight"`. `filesClearFor`
(`src/lib/gating.ts:49-53`) was correct over garbage input. Nothing downstream can detect this,
because the only site that renders `task.files` as text (`src/lib/status.ts:46-62`) is guarded by
`if (task.phase === 'blocked-on-files')` — it speaks only once overlap has already fired. A correct
declaration eventually announces itself; a malformed one is silent by construction.

Two further silent modes the issue does not name, both measured (research §Measured behaviour):
`flag` is `indexOf` (`src/cli.ts:335-338`), so a repeated `--files` drops everything after the
first; and a valueless `--files` swallows the next flag as its value (`--files --surface core`
records `["--surface"]` while `--surface` still resolves to `core`, because `flag` re-scans argv).

## Goal

A malformed `--files` is impossible to leave a run in silently. Concretely, after this change:

1. An entry that cannot be a path prefix — it contains whitespace, or it is flag-shaped — is
   **rejected at registration**, before the task is minted, with the correct syntax in the message.
2. Whatever *was* recorded is **printed back** on every success path, so a set that is wrong in a
   way no rule can catch is still visible in the same breath as `task_id:`.
3. A repeated `--files` **accumulates** instead of discarding all but the first.
4. The comma separator is **named** everywhere the flag is documented.
5. All four are proven **through the argv path an operator actually types**, not only against the
   exported function.

The three berean-os failure shapes all land in (1). (2) is the backstop for the shapes a rule cannot
know about — a valid prefix pointing at the wrong directory, or a set that is simply incomplete.

## Non-goals

- **No change to `filesOverlap`, `filesClearFor` or `releasableFromFiles`** (`src/lib/gating.ts:19-70`).
  The gate's logic was never wrong; its input was. The declared-intent-heuristic contract at
  `src/lib/gating.ts:15-18` stands unchanged.
- **No change to `hpipe status` or any read-back command.** Two open issues own the two halves of
  this, and neither is #10: **#17** adds `hpipe show --task <id>` printing the recorded task
  including `files` — its stated motivation is that "confirming the `--files` bug meant reading
  plugin source and then hunting down the run's state file by hand" — and **#37**'s third direction
  is to "surface it in `hpipe status` as a warning" when two in-flight tasks' working trees modify
  the same path. #10 reports at registration, where the operator is still typing. (#23 is the
  precedent for the *shape* of such a signal — a distinct reportable state for a missing artifact —
  but its body never mentions files, so nothing here is handed to it.)
- **No migration of ledgers already on disk.** The berean-os run's whitespace entry stays as it is.
  Validation is at registration only.
- **No schema change.** `task.files` is already `string[]` (`src/lib/types.ts:66`), no `Task` or `Run`
  field is added, `phases.ts` is untouched and `schema_version` does not move — so this changes
  nothing about the format of runs already on disk, and an older supervisor reading a run registered
  by a newer CLI sees exactly what it sees today.
- **No path-existence check.** `--files` entries are prefixes, frequently of files the task is about
  to create, and are evaluated against sibling declarations, not the filesystem
  (`src/lib/gating.ts:15-21`). `--surface` is checked with `existsSync` (`src/cli.ts:71-74`) because
  an agent file must already exist; a prefix need not.
- **Only §2 of the runbook is this task's business.** Under the ruling #10 owns
  `test/integration/smoke.md`, but it owns it to repair what #10 breaks — the §2 assertion at
  `:100` — not to rewrite it. The digest prose at `:164-165` that #13 will leave stale is explicitly
  deferred to this run's `branch-review` phase by the same ruling, and C4 does not touch it.
- **Sibling boundary.** `src/supervisor/tick.ts`, `src/supervisor/deliver.ts` and
  `prompts/digest.md` belong to #13 and are not touched.

## Architecture

Five components: C1–C3 in `src/cli.ts`, C4 across four documentation files, C5 in `test/`.

### C1 (load-bearing) — reject an entry that cannot be a path prefix

A new validation block in `cmdTask`, inserted **after** the `--surface` check (`src/cli.ts:71-74`)
and **before** `const date` (`src/cli.ts:76`), so nothing is minted or saved when it fires. This
placement mirrors the existing order: cheap argv checks first, then the task literal.

Two rules, both "this string is not a path prefix":

| Rule | Rejects | Why it is decidable here |
|---|---|---|
| contains whitespace (`/\s/`) | `"src/a.ts src/b.ts"` | the measured berean-os shape |
| starts with `--` | `"--surface"` | only reachable from a valueless `--files` |

Messages follow the house shape — name the flag, quote the offending value, state the fix
(`src/cli.ts:67`, `73`, `104`, `107`):

    --files is comma-separated; this entry contains whitespace: "src/a.ts src/b.ts"
      → --files src/a.ts,src/b.ts

    --files got a flag where a path prefix belongs: "--surface" — the value after --files is missing

Both return `fail()`, which `dispatch` renders to stdout and exits 1 (`src/cli.ts:441-442`).

### C2 — echo the recorded set on both success paths

`cmdTask` has two success returns (`src/cli.ts:117`, `src/cli.ts:126`). Both gain a `files:` line
directly after `task_id:`:

```
task_id: t2
files: src/lib/gating.ts, src/cli.ts
queued: waiting on t1
```

```
task_id: t1
files: none

<the rendered worker brief>
```

`files: none` when the set is empty — which is the common, legitimate case and must not read as an
error. This mirrors `src/cli.ts:215`, the repo's existing habit of confirming what a command
actually did (``released ${input.taskId}; files reservation cleared``).

### C3 — a repeated `--files` accumulates

`listFlag` (`src/cli.ts:340-343`) currently calls `flag`, which is `indexOf`. It is changed to scan
every occurrence of `--<name>` and concatenate the values, keeping the comma split, the trim and the
empty-drop. `flag` itself is **not** changed: single-valued flags (`--branch`, `--surface`,
`--issue`, `--notes`, `--task`, `--run`) keep first-wins semantics.

### C4 — name the separator, and repair what C2 invalidates

Four files, six edits, no logic. Every one is committed; nothing is left to the plan's discretion.

| File | Line | Change |
|---|---|---|
| `prompts/intake.md` | 24 | `[--depends-on <id,id>] [--files <prefix,prefix>]` |
| `prompts/intake.md` | 27-29 | extend the "prints the task id, and either …" sentence to cover the new `files:` line |
| `prompts/dispatch.md` | 31 | `[--depends-on <id,id>] [--files <prefix,prefix>]` |
| `README.md` | 80 | `[--depends-on <id,id>] [--files <prefix,prefix>]` |
| `test/integration/smoke.md` | 100 | **the assertion C2 invalidates**: it says each `hpipe task` prints `task_id: tN` "followed by the rendered worker brief". A `files:` line now sits between them, and §2's `--files src/lib` / `--files src/lib/config.ts` invocations make it `files: src/lib` and `files: src/lib/config.ts` |
| `test/integration/smoke.md` | 92-93 | add the malformed invocation as an expected rejection, per the ruling's "add the malformed-`--files` rejection if your plan keeps it" — a space-separated value must print the C1 message and exit 1 before either task is minted |

`prompts/intake.md:27-29` is the load-bearing prompt edit: it is the passage that tells the
orchestrator what `hpipe task` prints, so it is the contract C2 extends.

**Three test guards constrain these edits** — the pass-0 survey of `test/prompts.test.ts` was wrong,
so here is the verified scope of that 148-line, 16-test file:

- `test/prompts.test.ts:68-76` fails **any** prompt whose text contains a literal `hpipe` after
  `{{hpipe}}` is stripped. The new prose in `prompts/intake.md` must therefore write
  `` `{{hpipe}} task` ``, never `` `hpipe task` ``. This is the one guard C4 can actually trip.
  (`test/integration/smoke.md` is not a prompt and is not in `ALL`, so its literal `hpipe` commands
  stay as they are.)
- `test/prompts.test.ts:60-66` asserts `prompts/dispatch.md` contains
  `worktree create --cwd {{repo_root}}`; C4 does not touch line 31's neighbours, but the edit must
  leave that string intact.
- `test/prompts.test.ts:88-100` is two tests asserting four exact strings in `README.md`
  (`bin/hpipe`, `There is nothing else to install`, `Install the hpipe shorthand`, and the absence of
  `ln -s /path/to/herdr-plugin-pipeline/src/cli.ts`). None is line 80, verified
  by reading them, but the README edit must not disturb them.

### C5 (new in pass 1, mandatory) — prove it through the argv path, twice

MAJOR 3 is correct that C1–C3 are unprovable by unit tests alone: the only `--files` argv site is
`src/cli.ts:386`, inside `dispatch`'s `case 'task'`, and `dispatch`, `flag` and `listFlag` are all
module-private (`grep -n "^export" src/cli.ts` lists 13 `cmd*` functions and 2 interfaces).
`grep -rn "listFlag" test/` returns nothing today.

**C5a — automated.** A new test executes the real CLI as a subprocess against a scratch state dir and
asserts on stdout:

1. `git init` a temp repo with `.claude/agents/core-dev.md`, using `tempDir()` and `git()` from
   `test/helpers/git-worktree.ts`.
2. `bun run src/cli.ts start "argv fixture"` with `cwd` = that repo.
3. Four `task` invocations, each asserting real stdout:

| argv | expected stdout |
|---|---|
| `--files src/a.ts,src/b.ts` | `files: src/a.ts, src/b.ts` |
| `--files src/a.ts --files src/b.ts` | `files: src/a.ts, src/b.ts` (C3 through the real parser) |
| `--files "src/a.ts src/b.ts"` | exit 1, message names the entry and the comma |
| no `--files` | `files: none` |

The subprocess environment is pinned: `HERDR_PLUGIN_STATE_DIR` to a `tempDir()`, `HERDR_SESSION` to a
fixture name, and `HERDR_SOCKET_PATH` cleared. See A12 — getting this wrong would write into the live
ledger this pipeline is running on, which is the one way this test could do real harm.

**C5b — live.** The runbook edits in C4, which is where this repo says the behaviour is actually
proven (`.claude/agents/plugin-dev.md` §"Where the behaviour is actually proven"). §2 of the runbook
already registers two tasks with overlapping `--files` (`test/integration/smoke.md:88-100`), so the
echo and the rejection land in a section that exists for exactly this.

## Data and control flow

Before (research §Current control flow), with the new steps marked:

1. `dispatch` (`src/cli.ts:379-389`) parses argv. `files: listFlag(rest, 'files')`.
   **C3: every `--files` occurrence contributes; previously only the first.**
2. `cmdTask` (`src/cli.ts:53`): run exists and is live (61) → `--issue` positive (66-68) →
   `--branch` non-empty (69) → `--surface` resolves (71-74) → **C1: every `--files` entry is a
   plausible prefix** → task literal (79-98) → `--depends-on` known (104) and acyclic (107).
3. `run.tasks.push`, `intake_closed = false`, `saveRun` (109-113). Unchanged.
4. `gateStatus` (115). Unchanged — the file gate is still not consulted at registration, by design.
5. Return `task_id:` **+ C2 `files:`** + either `queued: waiting on …` (117) or the brief (126).
6. `task.files` is next read at `plan-review → implement` by `filesClearFor`
   (`src/lib/gating.ts:49-53`). Unchanged.

Nothing machine-parses `cmdTask`'s stdout — `grep -rn "task_id:" src/ prompts/ test/ bin/` returns
only the two producers in `src/cli.ts`, unrelated `history` writes, `toContain` assertions in
`test/cli.test.ts:58-62`, and the runbook prose at `test/integration/smoke.md:100` that C4 repairs.
Review 0 widened this check and confirmed every `.text` assertion in `test/cli-commands.test.ts`
(lines 54, 114, 286, 301, 316, 317, 330, 331) is `toContain` / `not.toContain` as well, so no
positional assertion exists anywhere in the suite.

## Error handling

| Input | Today | After |
|---|---|---|
| `--files src/a.ts,src/b.ts` | `["src/a.ts","src/b.ts"]` | unchanged |
| `--files "src/a.ts src/b.ts"` | stored, silent, never overlaps | **C1 rejects**, exit 1, no task minted |
| `--files a/ --files b/` | `["a/"]`, `b/` silently lost | **C3** `["a/","b/"]` |
| `--files --surface core` | `["--surface"]`, silent | **C1 rejects**, exit 1 |
| `--files` as the last token | `[]` | `[]`, echoed as `files: none` (see A6) |
| `--files ""` | `[]` | `[]`, echoed as `files: none` |
| `--files a/,,b/` | `["a/","b/"]` | unchanged — the empty-drop in `listFlag` is deliberate |
| no `--files` | `[]` | `[]`, echoed as `files: none` |

A C1 rejection is a total failure of `hpipe task`: no task is pushed, `saveRun` is not reached,
`run.intake_closed` is not touched, and the run is exactly as it was. This matters because there is
no command that removes a task once minted — the reason the `--issue` guard exists at all
(`src/cli.ts:62-65`). The operator retypes the command.

## Assumptions

Each of these is a behavioural choice, stated so the review can attack it.

**A1 — Reject whitespace; do not silently accept it as a separator.** The issue offers both
("Reject a `--files` entry containing whitespace, **or** accept repeated `--files` flags /
whitespace as a separator"). Accepting whitespace would have silently fixed the berean-os
invocations, which is the strongest argument against this choice. It is rejected because it makes
the *declared* set differ from the *typed* set with no signal, which is the class of failure this
issue exists to remove — the orchestrator would still never learn that it had typed the wrong
syntax, and the next repo with a space in a path would be undeclarable. Rejection teaches the syntax
once, at the moment it is typed. **The most attackable decision here.** Review 0 did not overturn it.

**A2 — A path prefix containing whitespace is not worth supporting.** A1's cost: `--files "my dir/"`
becomes impossible. Accepted because `--files` entries are prefixes of source paths in the repos
this pipeline drives, and the six berean-os declarations plus the four in the second run
(`src/RecentBooksStore`, `lib/EpdFont`, `src/MappedInputManager`) contain no spaces. If such a repo
appears, a hard error naming the flag is a better outcome than today's silent miss.

**A3 — Accumulating repeated `--files` (C3) belongs in this issue, not a later one.** It is
direction 3 of the issue, and it is load-bearing for A1 rather than adjacent to it: once C1 rejects
the space-separated form, "repeat the flag" is the obvious retry, and today that retry silently
discards everything after the first flag. Shipping C1 without C3 replaces one silent loss with
another.

**A4 — C3 changes `--depends-on` too, and that is acceptable.** `listFlag` has exactly two call
sites (`src/cli.ts:385-386`). `--depends-on t1 --depends-on t2` currently drops `t2`, so a task
starts before its dependency with no diagnostic — the same class of silent failure, and the
`--depends-on` validation at `src/cli.ts:104` cannot see a value that was never parsed. The change is
strictly more permissive and no existing test pins the old behaviour: `listFlag` is module-private
and has no test file. Per MINOR 4, C4 now documents the comma for `--depends-on` on the same lines,
so the two flags stop disagreeing about their own syntax.

**A5 — `listFlag` gets exported for its tests rather than moved to `src/lib/`.**
`.claude/agents/plugin-dev.md` assigns argv parsing to `src/cli.ts` ("every `hpipe` subcommand, argv
parsing, and the task/run constructors"), so a new `src/lib/argv.ts` would contradict the scoped
guide even though the "one test file per lib module" convention would otherwise favour it. Exporting
is not a new pattern: `src/cli.ts` already exports thirteen `cmd*` functions precisely so
`test/cli.test.ts` and `test/cli-commands.test.ts` can reach them. **C5a is what makes this safe** —
exporting the helper proves the helper, and only the subprocess test proves the wiring.

**A6 — A valueless trailing `--files` is echoed, not rejected.** `hpipe task … --files` with nothing
after it yields `[]` (measured), indistinguishable inside `cmdTask` from "the flag was never given",
because `cmdTask` receives the parsed `string[]` and not argv. Telling them apart would mean either
changing `cmdTask`'s input shape or having `listFlag` return a richer result — both larger than the
problem. C2 covers it: the operator sees `files: none` when it expected a list. Rejected
alternative: make `listFlag` return `{ entries, present }`. It touches both call sites and invents a
result shape this repo does not use anywhere.

**A7 — Two rules, not a general path validator.** C1 checks whitespace and a `--` prefix and
nothing else — no character allowlist, no absolute-path rejection, no `..` check. Anything stricter
would start rejecting legitimate prefixes, and the entries are never resolved against the filesystem
(non-goals), so there is no safety property to enforce. The rules are exactly the two shapes
measured to fail.

**A8 — The echo lists entries comma-joined with a space (`files: a, b`), matching the issue's own
`files: src/foo, src/bar`.** It is for a human and an agent to read, not to re-feed into the CLI;
`prompts/intake.md:24` remains the place that shows the input syntax. Stated because a reader could
reasonably expect the echo to be copy-pasteable, and it deliberately is not.

**A9 (rewritten for MAJOR 1) — registration-time reporting is #10's whole share; the durable-state
signal is #17's and #37's.** The research's sharpest finding is that the false all-clear was written
to the ledger, which argues for a signal further downstream too. That signal is already owned, twice
over: **#17** for the on-demand read-back (`hpipe show --task <id>`, which names `files` in its own
scope and cites this bug as the reason it is needed), and **#37** for the proactive warning when two
in-flight tasks touch the same path. Pass 0 handed this to #23, which owns the artifact case and
whose body never mentions files — a real gap handed to an issue that would not have closed it, which
is the very pattern #37 was filed to document. Nothing in C1–C5 forecloses either follow-up: they read
the same `task.files` field, unchanged in shape.

**A10 (rewritten in pass 1) — `test/integration/smoke.md` is taken under the ruling, and repaired
only where C2 breaks it.** I opened decision `d1` rather than patching this inline, and the
orchestrator ruled the file to #10 (`gh issue view 10`, §Ownership ruling). Two consequences worth
attacking: the ledger declaration still reads
`["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]` and cannot be amended — there
is no command that edits `task.files` (`src/cli.ts:213` only clears it) — so the grant lives in the
issue and this spec, not in the gate, which is itself the live instance of #37 the ruling names. And
the ruling is a licence to repair §2, not to own the document: C4 touches `:92-93` and `:100` and
leaves `:164-165` to `branch-review`, per the same ruling.

**A11 (new in pass 1) — one end-to-end proof is not enough; C5a and C5b answer different
objections.** The ruling says keep the runbook as the end-to-end proof, and review 0 offered the
subprocess test *or* the runbook. Both are taken because they fail differently: C5b runs against a
real herdr session with a real supervisor, which is the only way to see what an operator sees, but it
runs only when a human walks it; C5a runs on every `bun test` and is what stops C1–C3 regressing
after this branch merges. Dropping C5a would leave the argv path — where this bug lived — with no
automated coverage at all, which is the substance of MAJOR 3 and not something the ruling addresses.
Dropping C5b would disobey the ruling and leave an assertion C2 falsifies sitting in the runbook.

**A12 (new in pass 1) — C5a runs the checkout's `src/cli.ts`, and that is safe only because its
environment is pinned.** `.claude/agents/plugin-dev.md` says "never run the checkout's `src/cli.ts`
directly against live state", and `bin/hpipe:1-19` explains why: the CLI and supervisor share one
ledger. The prohibition is about *shared state*, not about execution — so C5a must set
`HERDR_PLUGIN_STATE_DIR` to a `tempDir()`, set `HERDR_SESSION` to a fixture name, and clear
`HERDR_SOCKET_PATH`. **Inheriting the ambient environment is the hazard:** this pane runs with
`HERDR_SESSION=pipeline`, and `sessionKey()` (`src/lib/session.ts:5-14`) prefers `HERDR_SESSION`, then
parses `HERDR_SOCKET_PATH`, then falls back to `default` — so a subprocess that forgets these would
register fixture tasks into the live run driving this very task. The plan must make the env explicit
at the spawn site, and the test must assert the scratch state dir received the run.

**A13 (new in pass 1) — C5a adds a test file that is in no task's declared `--files`, and that is not
the same as BLOCKER 1.** My declared set covers `src/cli.ts` but no test path, so by the letter of
#37's complaint C5a is an undeclared file too. It is nonetheless taken without escalation, because
the tests for `src/cli.ts` are not a contested resource: #13 holds `src/supervisor/tick.ts`,
`src/supervisor/deliver.ts` and `prompts/digest.md` and has no reason to touch a `cli` test, whereas
`smoke.md` was a single shared runbook #37 records both tasks as wanting — which is the distinction
that made one an escalation and the other routine. Stated explicitly so the next review can attack the
distinction rather than have to find it. Whether C5a extends `test/cli.test.ts` or lands as a new
`test/cli-argv.test.ts` is a plan-phase call; both are equally uncontested.

## Testing strategy

TDD throughout: failing test, run it, minimum code, run it again.

**Unit, in `test/cli.test.ts`** — modelled on `test/cli.test.ts:78-115`, whose three tests each assert
`ok === false` and that the message contains the offending token:

1. `task rejects a --files entry containing whitespace` — `files: ['src/a.ts src/b.ts']`;
   expect `ok === false`, text contains the offending entry and `comma`.
2. `a rejected --files mints no task` — the run's `tasks.length` is unchanged and
   `intake_closed` is untouched after the rejection. This is the assertion that proves C1 sits
   before `saveRun`; without it the test above passes even if the task is stored first.
3. `task rejects a flag where a --files prefix belongs` — `files: ['--surface']`; expect
   `ok === false`.
4. `task echoes the file set it recorded` — two entries; expect the text contains
   `files: src/lib/gating.ts, src/cli.ts`.
5. `task echoes files: none when nothing was declared` — the gated path *and* the dispatched path,
   since C2 edits two returns and one test cannot cover both.
6. `listFlag accumulates a repeated flag` and `listFlag splits on commas` — direct unit tests on the
   newly exported helper, modelled on `test/session.test.ts`, which tests a single pure function
   with one `expect` per input shape.

**End-to-end, C5a** — the four subprocess invocations tabulated above. This is the layer the unit
tests cannot reach and the layer this bug lived in: on the berean-os run no pure function was wrong,
the argv path handed `filesClearFor` garbage and `filesClearFor` was correct over it.
`.claude/agents/plugin-dev.md` records that DI-faked unit tests "have passed clean over real defects
twice", which is the reason C5a is mandatory rather than optional. Precedent for a spawning fixture:
`test/helpers/git-worktree.ts:7-10` shells out to real `git` via `Bun.spawnSync` and is already
imported by `test/deliver.test.ts:8` and `test/tasks.test.ts:8`.

**Live, C5b** — the runbook edits in C4. `test/integration/smoke.md` is a hand-run runbook the unit
suite cannot replace (`.claude/agents/plugin-dev.md` §"The shape of it"), and §2's two overlapping
`--files` registrations are already the section where a reader would look for this.

**Regression guard, already present:** `test/cli.test.ts:48-63` asserts `task_id: t1`,
`queued: waiting on t1`, and that a gated task's text does *not* contain the brief. C2 must leave all
three passing — that is the check that the echo was inserted, not substituted.

**Baseline to hold:** `bun test` → 414 pass, 0 fail; `bun run typecheck` → clean. Both measured at
`343dde4` before any change and reproduced by review 0. CI here runs a PR-title lint only (#35), so
both commands get run locally and the result stated in the PR body.

## Rejected alternatives

**Validate inside `listFlag`.** It cannot `fail()` — it returns `string[]` and has no error channel —
so it would have to throw. Nothing in this repo throws from argv parsing; only `render()` throws
(`src/lib/render.ts:11`), and `.claude/agents/plugin-dev.md` calls that out as a hazard rather than a
pattern to copy. The `cmd*` functions' `CmdResult` (`src/cli.ts:21-24`) is the established error
channel.

**Normalize instead of rejecting** — split entries on whitespace inside `cmdTask` and carry on. This
is A1's alternative wearing a different hat: it fixes the data and still tells the operator nothing,
so the next invocation is malformed the same way.

**Make the file gate refuse to clear a task whose declaration looks malformed.** It would have caught
berean-os at the exact moment the false all-clear was written, which is the most satisfying place to
catch it. Rejected: it moves the diagnosis hours downstream of the typo, into
`src/lib/gating.ts` whose contract is explicitly a heuristic over declared intent
(`src/lib/gating.ts:15-18`), and it would block a run over data the operator can no longer correct —
there is no command that edits `task.files`, only `cmdRelease` which clears it wholesale
(`src/cli.ts:213`).

**Prove C1–C3 with unit tests only, and leave the runbook to cover the rest.** Pass 0's position,
withdrawn under MAJOR 3. A hand-run markdown file is not a proof the next change can rely on; it is
now C5b, one half of the coverage, not the whole of it.

**Drop `test/integration/smoke.md` rather than escalate.** Pass 0's fallback, and what I recommended
in `d1`. Overtaken by the ruling, which reasons that #10's claim is the stronger one because it
invalidates an assertion rather than merely dating some prose.
