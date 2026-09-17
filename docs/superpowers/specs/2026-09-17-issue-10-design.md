# `--files` validation and echo — design (#10)

Pass 0. Written against this worktree at `6c75122` (branch `fix/10-files-validation`), building on
`docs/superpowers/research/2026-09-17-issue-10-research.md`. Every claim about current behaviour
carries a `file:line` or the command that produced it.

**Modelled on** the validation block already in `cmdTask` (`src/cli.ts:62-74`, `102-107`) for the
checks, `src/cli.ts:215` for the echo, and `test/cli.test.ts:78-115` for the rejection tests. No new
pattern is introduced.

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

The three berean-os failure shapes all land in (1). (2) is the backstop for the shapes a rule cannot
know about — a valid prefix pointing at the wrong directory, or a set that is simply incomplete.

## Non-goals

- **No change to `filesOverlap`, `filesClearFor` or `releasableFromFiles`** (`src/lib/gating.ts:19-70`).
  The gate's logic was never wrong; its input was. The declared-intent-heuristic contract at
  `src/lib/gating.ts:15-18` stands unchanged.
- **No change to `hpipe status` output** (`src/lib/status.ts`). Making "the file set is suspicious"
  a reportable state belongs with #23, which already owns the "absent/wrong artifact is a distinct
  reportable state" problem; `src/lib/status.ts` was rewritten by #15 two commits ago. #10 reports at
  registration, where the operator is still typing.
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
- **Sibling boundary.** `src/supervisor/tick.ts`, `src/supervisor/deliver.ts` and
  `prompts/digest.md` belong to #13 and are not touched.

## Architecture

Four components: C1–C3 all in `src/cli.ts`, C4 across four documentation files.

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

### C4 — name the separator where the flag is documented

Four files, five edits, no logic:

| File | Line | Change |
|---|---|---|
| `prompts/intake.md` | 24 | `[--files <prefix,prefix>]`, and a sentence naming the comma in the §4 prose at 27-29 |
| `prompts/intake.md` | 27-29 | extend the "prints the task id, and either …" sentence to cover the new `files:` line |
| `prompts/dispatch.md` | 31 | `[--files <prefix,prefix>]` |
| `README.md` | 80 | `[--files <prefix,prefix>]` |
| `test/integration/smoke.md` | 100 | the runbook asserts `task_id: tN` is "followed by the rendered worker brief"; a `files:` line now sits between them |

`prompts/intake.md:27-29` is the load-bearing one: it is the passage that tells the orchestrator what
`hpipe task` prints, so it is the contract C2 extends. `test/prompts.test.ts:17-34` guards only the
declared prompt set, orphan files and the review trailer, so none of this breaks a test — verified by
reading that file.

## Data and control flow

Before (research §Current control flow), with the new steps marked:

1. `dispatch` (`src/cli.ts:379-389`) parses argv. `files: listFlag(rest, 'files')`.
   **C3: every `--files` occurrence contributes; previously only the first.**
2. `cmdTask` (`src/cli.ts:53`): run exists and is live (61) → `--issue` positive (66-68) →
   `--branch` non-empty (69) → `--surface` resolves (71-74) → **C1: every `--files` entry is a
   plausible prefix** → task literal (79-98) → `--depends-on` known (104) and acyclic (107).
3. `run.tasks.push`, `intake_closed = false`, `saveRun` (109-113). Unchanged.
4. `gateStatus` (115). Unchanged — the file gate is still not consulted at registration, by design
   (`test/integration/smoke.md:100-103` documents that both tasks print a brief and the collision
   resolves later at `blocked-on-files`).
5. Return `task_id:` **+ C2 `files:`** + either `queued: waiting on …` (117) or the brief (126).
6. `task.files` is next read at `plan-review → implement` by `filesClearFor`
   (`src/lib/gating.ts:49-53`). Unchanged.

Nothing machine-parses `cmdTask`'s stdout — `grep -rn "task_id:" src/ prompts/ test/ bin/` returns
only the two producers in `src/cli.ts`, unrelated `history` writes, and `toContain` assertions in
`test/cli.test.ts:58-62` (inside the test at 48). So inserting a line between `task_id:` and the brief is safe; the tests
that assert on that text assert containment, not position.

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
once, at the moment it is typed. **The most attackable decision here.**

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
and has no test file (`grep -n "^export" src/cli.ts` lists only the `cmd*` functions and two
interfaces).

**A5 — `listFlag` gets exported for its tests rather than moved to `src/lib/`.**
`.claude/agents/plugin-dev.md` assigns argv parsing to `src/cli.ts` ("every `hpipe` subcommand, argv
parsing, and the task/run constructors"), so a new `src/lib/argv.ts` would contradict the scoped
guide even though the "one test file per lib module" convention would otherwise favour it. Exporting
is not a new pattern: `src/cli.ts` already exports fourteen `cmd*` functions precisely so
`test/cli.test.ts` and `test/cli-commands.test.ts` can reach them.

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

**A9 — Registration-time reporting is sufficient for #10; the durable-state signal stays with #23.**
The research's sharpest finding is that the false all-clear was written to the ledger, which argues
for a signal further downstream too. That signal spans `src/lib/status.ts` — rewritten by #15 and
owned by #23 for exactly this kind of "make it a distinct reportable state" work. #10 delivers the
registration-time gate; nothing here forecloses #23 adding a status-level check over the same field.

## Testing strategy

TDD throughout: failing test, run it, minimum code, run it again.

**New, in `test/cli.test.ts`** — modelled on `test/cli.test.ts:78-115`, whose three tests each assert
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

**Regression guard, already present:** `test/cli.test.ts:48-63` asserts `task_id: t1`,
`queued: waiting on t1`, and that a gated task's text does *not* contain the brief. C2 must leave all
three passing — that is the check that the echo was inserted, not substituted.

**Baseline to hold:** `bun test` → 414 pass, 0 fail; `bun run typecheck` → clean. Both measured at
`343dde4` before any change (research §Installed versions). CI here runs a PR-title lint only (#35),
so both commands get run locally and the result stated in the PR body.

**Not provable by the unit suite.** `.claude/agents/plugin-dev.md` warns that DI-faked unit tests
have passed clean over real defects twice. Everything here is pure argv-and-string work inside one
exported function with no herdr I/O, no pane delivery, no startup and no gating change, so the unit
tests do cover the behaviour. The one thing they cannot cover is that the *operator* reads the echo,
and `test/integration/smoke.md` is where that belongs: §2 of the runbook already registers two tasks
with overlapping `--files` (lines 88-100) and is the natural place to assert the `files:` line
appears, and to add the malformed invocation as an expected rejection. The plan phase decides whether
that runbook edit is in scope.

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
