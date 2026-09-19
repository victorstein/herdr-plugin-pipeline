# PR #44 — stage-2 CODE QUALITY review (pass 0)

Reviewed `fix/21-run-resolution` at `2982c6b` (base `9e792b5`), diff read with `gh pr diff 44` /
`git diff main...HEAD`. Judged against `.claude/agents/plugin-dev.md`, the siblings the design
names as its models (`docs/superpowers/specs/2026-09-18-issue-21-design.md:8-13`), and the code
already in the tree. Scope and acceptance were cleared at stage 1 and are not re-litigated here.

## What I checked, and how

- **Suite and types, from their own output.** `bun test` → 486 pass / 0 fail / 1170 expect() /
  34 files. `bun run typecheck` → silent, exit 0.
- **Sibling ownership.** `git diff main...HEAD --stat` touches neither `src/lib/phases.ts`,
  `src/supervisor/stall.ts`, `test/phases.test.ts` nor `test/stall.test.ts`. Clean.
- **Dead code / unused imports.** Every symbol added to `src/cli.ts`'s import list is referenced
  (`activeRunForRepo`, `listRuns`, `newRun`, `resolveRun`, `runForWorkspace`, `runPhaseState`,
  `RUN_ROWS`, `TASK_ROWS`, `abandonDecisions`, `RunQuery`, `RunResolution` — all ≥2 occurrences).
  No commented-out code anywhere in the diff.
- **Comment discipline.** I read every comment added by the diff against the repo's rule that a
  comment carries the *why* only. All of them do: `src/cli.ts:28-29` (why the phrase has no
  article), `:39-41` (why the excluded line prints the phase), `:85-86` (why a live run in
  `excluded` must not be called finished), `:278-282` (why rewind validates before the terminal
  test), `:302-305` (why the abandon block sits *after* the pending-answer block), `:398-399`
  (which guard it mirrors and which incident it closes), `:544-549` (why `--git-common-dir`),
  `src/lib/ledger.ts:134-138` (why `runPhaseState` swallows the throw). None restates its next
  line. This is the strongest part of the change.
- **Reuse.** `abandonDecisions` (`src/lib/decisions.ts:38`) is reused rather than reimplemented;
  `resolveRun` genuinely replaces the five ad-hoc `listRuns(...).find(...)` lookups instead of
  sitting beside them — after the diff, `src/cli.ts` has no remaining hand-rolled run search
  except `cmdRewind`/`cmdAbort`/`cmdResume`, which take a positional run id by design.
- **Prompt token safety.** `run_id` was added at the only render site
  (`src/lib/worker-prompt.ts:18`); `grep -rn renderWorkerPrompt src/` shows all three callers go
  through it, so `render()`'s unresolved-placeholder throw cannot fire.
- **Runtime wording.** Drove the built CLI against a throwaway ledger
  (`HERDR_PLUGIN_STATE_DIR` pinned at a scratch dir, never `~/.local/state/…`) and read the real
  refusals for wrong-phase, terminal, none-with-excluded and bad-phase. They read as sentences and
  match `test/integration/smoke.md:134-136` byte-for-byte.

---

## MAJOR 1 — `src/actions/claim.ts` imports from the CLI entrypoint; the repo's own precedent puts shared logic in `src/lib/`

`src/actions/claim.ts:1`

    import { repoContext } from '../cli'

This is the only module in `src/` that imports `src/cli.ts`
(`grep -rn "from '\.\./cli'" src/` → one hit, this line). Every other action and hook imports from
`src/lib/*` only (`src/actions/drain.ts:2`, `src/actions/status.ts:1-5`, `src/hooks/_hook.ts:2-3`).
`.claude/agents/plugin-dev.md` states the layering this inverts: `src/lib/` is the pure core,
`src/hooks/`/`src/actions/` are thin herdr entry points.

The repo already has the exact situation solved one directory over: `src/lib/install-cli.ts` holds
the logic and `src/actions/install-cli.ts:1-2` is a two-line shim that imports it. `repoContext`
is the same kind of thing — a shared git-derivation helper with two consumers — and should sit
beside `installCli` in `src/lib/` (`src/lib/repo.ts`, or next to `sessionKey` in
`src/lib/session.ts`), with `src/cli.ts` and `src/actions/claim.ts` both importing it from there.

De-duplicating claim's inline spawn was right, and the design does call for it
(design `:447`, A7) — the defect is the direction, not the decision, so the fix keeps A7's
substance and only moves the function. Two consequences today:

- `claim.ts` now loads `src/cli.ts`'s entire module graph (`herdr`, `decisions`, `gating`,
  `machine`, `queue`, `render`, `status`, `worker-prompt`, `pidfile`, …) on every pane claim, to
  call one three-spawn git helper.
- It makes an executable entrypoint (`#!/usr/bin/env bun`, `src/cli.ts:1`, with
  `if (import.meta.main) process.exit(await dispatch(...))` at `:675`) a library. It is correct
  today only because of that `import.meta.main` guard; anything top-level ever added to `cli.ts`
  runs inside the claim action.

Fixable inline: move the function plus `gitOut`, update two imports. No behaviour changes and the
existing subprocess test (`test/cli-argv.test.ts`, "task run from a linked worktree…") still covers
it.

---

## MINOR 1 — the four task-resolving commands repeat the same 13-line preamble

`src/cli.ts:239-253` (`cmdBrief`), `:344-358` (`cmdRelease`), `:374-386` (`cmdDecide`),
`:416-430` (`cmdAnswer`)

Each is: empty-`--task` guard → a `RunQuery` object literal → `resolveRun` → `resolveFailure` →
`run.tasks.find(...)` → `no such task`. They differ only in the input field name, `allowTerminal`,
and the escape string. That is ~50 new lines where one small helper would do, e.g.

    async function resolveTask(ctx, taskId, opts: { allowTerminal: boolean; escape: string | null })

returning `{ run, task }` or a `CmdResult`. It would also remove the bare positional `null` at
`:136`, `:264`, `:381`, which currently reads as an unexplained argument at the call site. The
resolver was introduced precisely so there is one way to do this; the last mile was not taken.

## MINOR 2 — `cmdDecide` alone passes `allowTerminal: false`, with nothing saying why

`src/cli.ts:378` vs `:243`, `:348`, `:420`

Three of the four sibling commands opt into a finished run when it is named
(`allowTerminal: input.runId !== null`); `cmdDecide` hard-codes `false`, so `--run` cannot reach a
finished run there. `test/decide.test.ts:384-402` shows this is deliberate (#38: neither `rewind`
nor `resume` recovers a naturally-finished run, so no escape should be offered), but the only
comment nearby (`:398-399`) explains the *task*-level guard, not the run-level asymmetry. This is
exactly the non-obvious "why" the repo's comment rule reserves space for — one line at `:378`.

## MINOR 3 — `--run ""` prints an empty subject, while the same PR is careful everywhere else

`src/cli.ts:68` with `flag()` at `:514-517`. Verified live:

    $ hpipe brief --task t1 --run ""
    no such run:

The PR adds `'--task is required'` at `:239`, `:344`, `:374`, `:416` and `'(missing)'` at `:286`
for exactly this class of input, then leaves `--run` without the same treatment. A
`query.runId.trim().length === 0` check reusing the established `--run is required` phrasing closes
it. (A `--run` with no following token is already safe: `flag` returns `null` and the repo lookup
still happens.)

## MINOR 4 — the README's new row over-claims

`README.md:101` — "Every command that takes `--task` resolves against the repo you are standing in
and refuses a finished run" — sits directly under `README.md:100`, which documents
`hpipe rewind <run> <phase> [--task <id>]`. `cmdRewind` takes `--task` and never calls `resolveRun`
(`src/cli.ts:275`, a positional-id lookup). Name the six commands, or say "every command that
resolves a run by `--task`".

## MINOR 5 — the dispatcher restates which commands resolve, in a list nothing checks

`src/cli.ts:571`

    const resolves = ['task', 'brief', 'dispatch', 'release', 'decide', 'answer'].includes(command ?? '')

The list is correct today, but it duplicates knowledge each command already carries in its own
`RunQuery`. A seventh resolving command added without touching this line gets `repoKey: null`
silently, and `resolveRun` falls straight back to "first live match across every repo in the
session" — issue #21 itself, with no error anywhere. The comment above it explains why the repo is
needed but not that this list is load-bearing. Either invert it to an allowlist of the commands
that do *not* resolve (`status`, `drain`, `abort`, `resume`, `forget`, `rewind`, plus `start`'s own
branch), or add a test that the set matches the commands building a `RunQuery`.

## MINOR 6 — `taskIsTerminal` is a third local spelling of a question `src/lib/` already owns

`src/cli.ts:47-48`

    const taskIsTerminal = (phase: string): boolean =>
      TASK_ROWS.some((r) => r.phase === phase && r.terminal === true)

The run side of this same PR got a named, documented lib helper for the identical throw-safe
question (`runPhaseState`, `src/lib/ledger.ts:139`); the task side got an inline `.some()` in
`cli.ts`, alongside the two shapes already in the tree — `taskRow(t.phase).terminal === true`
(`src/lib/status.ts:72`) and the exported `SETTLED` set (`src/supervisor/teardown.ts:12`). The
throw-safe form belongs beside `runPhaseState`, or in `phases.ts` next to `taskRow`, so the next
caller that reads a task phase off disk finds it instead of writing a fourth.

Related, not a request to change behaviour: the comment at `:302-303` justifies abandoning with
"a pane that is gone", which is `SETTLED`'s question (terminal **or** `escalated`), not
`terminal`'s. `terminal` is the defensible choice — an `escalated` task has `returnsTo` and can
come back needing its answer — so tighten the comment rather than the predicate.

---

## Test design

The new tests are designed, not merely present:

- Both #21-shaped tests force the wrong run to sort first and say *why* the fixture must be that
  way (`test/cli-commands.test.ts:345-350`, `:429-433` — `run_id` prefix and `listRuns`'
  filename sort, cited by `file:line`). Without that, the test would pass unfixed; the comments
  stop a later edit from quietly neutering them.
- `test/cli-commands.test.ts:456-459` explains why a done-vs-live fixture would be vacuous for
  `dispatch --done` and uses two live runs in different repos instead. That is the reasoning the
  suite exists for.
- `test/ledger.test.ts:106-207` covers the resolver's branches one per test with no overlap, and
  the escapes the refusals advertise are themselves asserted (`test/cli-commands.test.ts:448-453`,
  `test/cli-argv.test.ts:133-138`), which is what stops a message from naming a way out that does
  not work.
- `test/cli-argv.test.ts:100-117` is the right call: `repoContext` is only reachable as a
  subprocess, and the assertion holds precisely because a broken derivation would find no run.

Two nits, neither worth a numbered finding: `test/decide.test.ts:141`, `:156`, `:177` close their
multi-line object literal on the property line (`… runId: null })`) where the surrounding file and
the lines they replaced put `}` on its own line; and `test/cli-argv.test.ts:141-157` asserts only
the exit code and the absence of `'opened decision'`, where the unit-level siblings also assert the
ledger is unchanged.

---

One MAJOR, six MINORs, no BLOCKER. The change is genuinely one resolver rather than six patches,
it reuses `abandonDecisions` and the phase table instead of re-deriving them, its comments are the
repo's own "why-only" kind, and its tests are built to fail against the unfixed source. The MAJOR
is a one-file move that preserves the design's decision, and every MINOR is a comment, a message,
a README clause or a helper's address — all fixable inline without a re-review.

VERDICT: CLEAR
