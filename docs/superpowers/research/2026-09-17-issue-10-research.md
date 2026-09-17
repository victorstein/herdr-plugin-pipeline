# Research — issue #10: `--files` is parsed comma-separated, documented as a list, and never validated or echoed

Established against this worktree at `343dde4` (branch `fix/10-files-validation`) and against the
live ledger of the berean-os run of 2026-09-16, which is still on disk at
`~/.local/state/herdr/plugins/stein.pipeline/runs/personal/berean-os-20260916-berean-os-issue-batch-ujku.json`.
Every claim below is either a `file:line` citation or a command whose output is quoted.

## Installed versions

    $ bun --version   → 1.3.14
    $ node --version  → v24.16.0
    $ herdr --version → herdr 0.9.0
    $ cat version.txt → 1.2.4

Dependencies are dev-only (`package.json:10-13`): `@types/bun@1.4.2`, `typescript@5.9.3` (resolved,
`bun.lock:14`, `bun.lock:20`). No runtime dependency is involved: the parsing is `String.split` and
the overlap test is `String.startsWith`.

Baseline is green before any change:

    $ bun run typecheck → tsc --noEmit, no output, exit 0
    $ bun test          → 414 pass, 0 fail, 903 expect() calls, 33 files

### The supervisor driving this run is not affected by edits here

    $ herdr plugin list
    - stein.pipeline (Pipeline) enabled [github:victorstein/herdr-plugin-pipeline@v1.2.1]

    $ git diff --quiet v1.2.1 HEAD -- src/cli.ts && echo IDENTICAL
    IDENTICAL

The installed plugin is pinned to `v1.2.1` while the checkout is `1.2.4`, but `src/cli.ts` is
byte-identical between them, so everything measured here is also true of the CLI currently running.

**Correcting the batch note:** it says "`src/cli.ts` changed underneath this issue" from batch 1.
It did not.

    $ git log --oneline -8 -- src/cli.ts
    6d3b840 feat: move design work into per-issue worker agents (#4)
    38ffabf feat: the herdr pipeline plugin (#1)

`gh pr view 27 --json files` (issue #9) and `gh pr view 28 --json files` (issue #15) list no
`src/cli.ts`. #9 touched `src/supervisor/{deliver,tasks}.ts`; #15 touched
`src/lib/{config,status,types}.ts` and `src/supervisor/{main,stall}.ts`. The conclusion the batch
note draws — that `cmdTask` is where the validation belongs — still holds; only its premise is
wrong. The issue's own citations have drifted slightly: `listFlag` really is at `src/cli.ts:340-343`,
but `cmdTask` spans **53-127**, not 55-120.

## Which files own the behaviour

| File | Line(s) | Role |
|---|---|---|
| `src/cli.ts` | 340-343 | `listFlag` — splits `--files` on commas, trims, drops empties |
| `src/cli.ts` | 335-338 | `flag` — `indexOf`, so only the **first** `--files` is ever read |
| `src/cli.ts` | 386 | The only `--files` call site: `files: listFlag(rest, 'files')` |
| `src/cli.ts` | 62-73, 102-107 | The validation block `--files` is absent from |
| `src/cli.ts` | 82 | `files: input.files` — recorded into the task verbatim |
| `src/cli.ts` | 117, 126 | The two success returns, which print `task_id:` and nothing about files |
| `src/lib/gating.ts` | 19-21 | `filesOverlap` — prefix test in both directions |
| `src/lib/gating.ts` | 49-53 | `filesClearFor` — the gate that consumes it |
| `src/lib/gating.ts` | 60-70 | `releasableFromFiles` |
| `src/lib/status.ts` | 46-62 | The **only** place `task.files` reaches a human, and only after overlap fires |
| `prompts/intake.md` | 12, 23-25, 27-29 | Documents the flag, and documents what `hpipe task` prints |
| `prompts/dispatch.md` | 31, 34-35 | Documents the flag |
| `README.md` | 80 | Documents the flag |
| `test/cli.test.ts` | 79-113 | The nearest existing example: rejection tests for the sibling flags |
| `test/cli-commands.test.ts` | 98-133 | `files` round-trip assertions via `cmdRelease` |
| `test/integration/smoke.md` | 88-100 | The live runbook's `--files` setup |

`src/cli.ts:335-343`, verbatim:

```ts
function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

function listFlag(argv: string[], name: string): string[] {
  const raw = flag(argv, name)
  return raw ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : []
}
```

## Current control flow

1. `dispatch` (`src/cli.ts:379-389`) parses argv. `files: listFlag(rest, 'files')` — comma split,
   no validation, no error path. `listFlag` cannot fail.
2. `cmdTask` (`src/cli.ts:53`) validates, in order: the run exists and is in a live phase (61),
   `--issue` is a positive integer (66-68), `--branch` is non-empty (69), `--surface` resolves to an
   agent file (71-74), `--depends-on` names known tasks (104) and forms no cycle (107).
   **`input.files` is never read between line 56 and line 82**, where it is assigned into the task.
3. The task is saved (113). `gateStatus` (115) considers only `depends_on` — the file gate is not
   consulted at registration.
4. Both success returns print `task_id: t1`, then either `queued: waiting on …` (117) or the
   rendered worker brief (126). Neither mentions `files`.
5. `task.files` is next read at `plan-review → implement`, by `filesClearFor`
   (`src/lib/gating.ts:49-53`).

### Nothing ever shows the orchestrator what was recorded

`grep -rn "\.files\b" src/` returns five sites: `src/cli.ts:82` (write), `src/cli.ts:213`
(`cmdRelease` clears it), and three reads in `gating.ts`/`status.ts`. The single site that renders
`task.files` into text a human sees is `src/lib/status.ts:46-62`, and it is inside
`if (task.phase === 'blocked-on-files')` — it only speaks once overlap has already fired.

So the feedback loop is exactly inverted: a *correct* declaration eventually announces itself, and a
*malformed* one is silent by construction. The per-task line in `hpipe status` carries branch,
issue, phase and agent status and no file set — confirmed against live output in this session:

    t1 fix/10-files-validation #10 [research] working

## Measured behaviour of `listFlag`

Run against this worktree's own `src/lib/gating.ts`:

    t4 parsed  = ["src/reader/a.ts src/reader/b.ts"]
    t5 parsed  = ["src/reader/b.ts src/reader/c.ts"]
    overlap(t4,t5)             = false
    overlap if comma-separated = true
    repeated --files a/ --files b/ = ["a/"]
    --files with no value (--files --surface core) = ["--surface"]
    trailing --files (last token) = []
    identical space-joined strings overlap = true

Four separate findings, only the first of which the issue names:

- **Space-separated in one quoted string** collapses to one entry that no sibling can prefix-match.
- **Repeated `--files` flags are silently discarded** — `flag` is `indexOf`, so the second and later
  occurrences are dropped without a word. This matters for the issue's own suggested remedy
  ("accept repeated `--files` flags"): it is not currently a no-op, it is a silent data loss.
- **A valueless `--files` swallows the next flag** as its value. `--files --surface core` records
  `["--surface"]` *and* still resolves `--surface` to `core`, because `flag` re-scans argv
  independently. Nothing reports the garbage entry.
- The issue's "matched nothing" is imprecise: two identical space-joined strings *do* overlap. The
  failure is that differing malformed strings never do — which is the common case, since two tasks
  declaring the *same* file set is the situation the gate exists to catch and the one case it still
  handles.

## Evidence from the berean-os run of 2026-09-16

The ledger records, verbatim, what six `hpipe task` invocations stored:

    t1 ["src/activities/launcher src/activities/ActivityManager.cpp src/activities/ActivityManager.h"]
    t2 ["src/util/BookmarkFile.cpp src/util/BookmarkFile.h"]
    t3 ["src/SettingsList.h src/activities/reader/EpubReaderMenuActivity.cpp …"]
    t4 ["src/activities/reader/EpubReaderMenuActivity.cpp … platformio.ini"]
    t5 ["src/CrossPointSettings.cpp … src/activities/settings/TextSettingsActivity.cpp"]
    t6 ["lib/I18n/translations"]

    tasks: 6 | entries containing whitespace: t1,t2,t3,t4,t5
    entries as recorded: t1=1 t2=1 t3=1 t4=1 t5=1 t6=1
    entries if split   : t1=3 t2=2 t3=4 t4=8 t5=17 t6=1
    overlapping pairs as recorded: NONE
    overlapping pairs if split   : t3~t4 t3~t5 t4~t5

**Correcting the issue on two counts.** It says the orchestrator passed space-separated paths "on
all six tasks": it was **five of six**. `t6` declared a single prefix with no whitespace and was
recorded correctly — a malformed declaration is indistinguishable in shape from a well-formed
single-prefix one, which is precisely why nothing noticed. And the intended declarations would have
produced **three** colliding pairs, not the one the orchestrator happened to spot.

### The gate ran, and reported a false all-clear into the ledger

The issue's "no file lock existed for the entire run" reads as though the gate never fired. The
history says something worse — `blocked-on-files` is a transit phase every task passes through
after `plan-review`, and all five were released about two seconds later:

    {"at":…072451,"task_id":"t5","from":"plan-review","to":"blocked-on-files","why":"cleared"}
    {"at":…074587,"task_id":"t5","from":"blocked-on-files","to":"implement","why":"no overlapping files in flight"}
    {"at":…193003,"task_id":"t4","from":"plan-review","to":"blocked-on-files","why":"cleared"}
    {"at":…194979,"task_id":"t4","from":"blocked-on-files","to":"implement","why":"no overlapping files in flight"}

Ten such entries, five tasks, every one ending `"no overlapping files in flight"`. The gate
evaluated correctly over garbage input and wrote its false conclusion into the durable record.

The concurrency was real, not theoretical:

    t5  08:41:14 blocked-on-files→implement | 08:53:07 implement→pr-review-intent
    t4  08:43:14 blocked-on-files→implement | 08:49:25 implement→pr-review-intent
    t3  08:54:37 blocked-on-files→implement | 22:31:12 implement→pr-review-intent

`t4`'s entire `implement` window is nested inside `t5`'s — six minutes of two workers on four
shared reader files. The issue's "discovered at 08:43" lines up exactly with `t4` entering
`implement`. `t3` started at 08:54:37, after both had left, so two of the three latent collisions
never materialised. That was luck, not the gate.

### The live runbook would not have caught it either

`test/integration/smoke.md:92-93` sets the collision up with one prefix per task:

    hpipe task --branch smoke/one --issue <n1> --surface <surface> --files src/lib
    hpipe task --branch smoke/two --issue <n2> --surface <surface> --files src/lib/config.ts

No multi-entry value is exercised anywhere in the runbook, so the separator has never been
rehearsed against a live run.

## What is documented, and what is not

Three user-facing sites name the flag and none names the separator:

- `prompts/intake.md:24` — `[--files <path-prefixes>]`
- `prompts/dispatch.md:31` — `[--files <path-prefixes>]`
- `README.md:80` — `[--files <prefixes>]`

`prompts/intake.md:27-29` is the passage that tells the orchestrator what to expect back:

> `{{hpipe}} task` prints the task id, and either the worker brief to dispatch or
> `queued: waiting on …`

That sentence is the contract an echo would extend, and it is the place a change to the printed
output has to be reflected.

`test/prompts.test.ts:17-34` guards only the declared prompt set, orphan files, and the review
trailer contract. It asserts nothing about this prose, so editing these three lines breaks no test.

## Nearest existing example

**For the validation:** the block at `src/cli.ts:62-73` and `102-107`, which already rejects a bad
`--issue`, `--branch`, `--surface` and `--depends-on` by returning `fail()` with the offending value
quoted back. Its comments state the *why* in the house style, e.g. `src/cli.ts:62-65`:

```ts
  // The argv parser defaults a missing --issue to 0 and a missing --branch to
  // "". Without these checks a mistyped command mints a ghost task into a live
  // run, and there is no command that removes one. Measured on a live run.
```

**For the tests:** `test/cli.test.ts:79-113` — three rejection tests (`cycle`, `surface with no
agent definition`, `dependency id that names no task`), each asserting `ok === false` and that the
message contains the offending token. `test/cli.test.ts:47-62` is the matching example for asserting
on `cmdTask`'s printed text.

**For the echo:** `src/cli.ts:215` is the repo's existing pattern of confirming what a command
actually did — ``released ${input.taskId}; files reservation cleared``.

## What a fix has to account for

- **`cmdTask` receives `string[]`, not the raw argv.** Every exported command takes a structured
  input object; `flag`/`listFlag`/`dispatch` are module-private and untested (`grep -n "^export"
  src/cli.ts` lists only the `cmd*` functions and two interfaces). A whitespace check inside
  `cmdTask` works on the split array and needs no new export. Changing the *separator* — accepting
  whitespace, or accepting repeated flags — is a change to `listFlag`/`flag`, which currently has no
  test file at all.
- **Both success returns must stay parseable.** `test/cli.test.ts:56-62` asserts on
  `task_id: t1`, `queued: waiting on t1`, and that a gated task's text does *not* contain the
  brief. An echo line has to sit alongside those, not replace them.
- **This is a CLI-surface change only.** It does not touch `phases.ts` or `schema_version`, so it
  does not alter the format of runs already on disk. `task.files` is already `string[]`; nothing
  about the ledger shape changes.
- **Sibling boundary:** `src/supervisor/tick.ts`, `src/supervisor/deliver.ts` and
  `prompts/digest.md` belong to #13 and are untouched by any of the above.

## Open question for the spec

The issue lists three directions and they are not equivalent in cost or in what they prove:

1. **Echo** what was recorded. Cheap, local to `cmdTask`'s two returns, and makes *every* malformed
   shape visible — including the two the issue does not name (dropped repeated flags, swallowed next
   flag). It relies on the orchestrator reading the output.
2. **Reject** an entry containing whitespace. Also local to `cmdTask`, and turns the measured
   berean-os failure into a hard stop. It cannot see the repeated-flag or swallowed-flag cases,
   which are shaped like valid input by the time `cmdTask` sees them.
3. **Accept** whitespace or repeated flags as separators. Changes `listFlag`/`flag` — the only
   direction that would have silently *fixed* the berean-os invocations rather than failing them,
   and the only one that needs a decision about what `--files` means going forward.

(1) and (2) are complementary and both belong in `cmdTask`; (3) is a separate contract change. The
spec should say which of the three it is delivering and why, against the evidence above — in
particular, that the gate's failure mode is a *confident false clear written to the ledger*, so a
remedy that only makes the malformed value visible at registration is betting on someone reading it.
