# PR review 0 (code quality) — issue #10, PR #39 (`--files` validation and echo)

Reviewed `gh pr diff 39` at `922d3db` on `fix/10-files-validation`, against
`.claude/agents/plugin-dev.md` (comment and testing conventions), the siblings of every line the PR
touches, and the PR's own research note where a comment makes a provenance claim.

Scope is quality only: pattern reuse, naming, structure, dead code, comment discipline, error-handling
shape, test design, duplication. Intent is stage 1 and cleared at `7fd8423`
(`docs/superpowers/reviews/issue-10-pr-review-intent-0.md`); I re-ran its two gates rather than quote
them — `bun run typecheck` exits 0 with no output, `bun test` is **427 pass, 0 fail, 34 files, 9.4s**,
and `bun test test/cli-argv.test.ts` alone is 275ms, so the new subprocess file costs the suite
nothing worth naming.

---

## MINOR 1 — the `listFlag` comment claims live-run provenance for a behaviour no live run produced, and `Measured on a live run.` is a load-bearing marker in this repo

`src/cli.ts:366-372`:

    // Exported for its tests: `dispatch` is module-private, so this is the only
    // reachable seam on the argv layer where the --files bug lived.
    export function listFlag(argv: string[], name: string): string[] {
      const entries: string[] = []
      // Every occurrence contributes. `flag` is indexOf-based, so the previous
      // single-lookup form silently dropped a repeated --files and everything it
      // declared, with no diagnostic anywhere. Measured on a live run.

`.claude/agents/plugin-dev.md:32-34` reserves that sentence for a specific thing: comments "end in
`Measured on a live run.` because they record something a live run taught us. Match that." The three
pre-existing uses honour it — `src/cli.ts:65` (a ghost task minted into a live run), `src/cli.ts:80`
(the gate reporting "no overlapping files in flight" while two workers edited the same files), and
`src/cli.ts:158` (an orchestrator that lost its context and had no way back to the brief).

The repeated-flag loss is not in that class. The PR's own research note separates the two evidence
sources explicitly. The live berean-os run of 2026-09-16 supplied the *space-separated* declarations
(`docs/superpowers/research/2026-09-17-issue-10-research.md:113-117`, the `t4`/`t5` entries, replayed
from the on-disk ledger named at `:3-5`), and the repeated-flag and valueless-flag behaviours come
from a local probe run against this worktree — `:112` is headed "Run against this worktree's own
`src/lib/gating.ts`", and `:118-119` are the synthetic lines
`repeated --files a/ --files b/ = ["a/"]` and `--files with no value (--files --surface core) =
["--surface"]`. `:128-130` then states the repeated-flag finding as one the *issue* suggested as a
remedy, not one a run exhibited: "it is not currently a no-op, it is a silent data loss." No live run
ever passed `--files` twice.

This is not pedantry about a sentence. The marker is how a future reader tells a fact that survived
contact with a real session from one derived by reading `indexOf` — the same distinction
`.claude/agents/plugin-dev.md:53-59` builds the whole "where the behaviour is actually proven" section
on. Spending it on a probe result devalues it at `src/cli.ts:65` and `:80`, where it is earned.

The comment's first clause is the softer half of the same fix and I flag it as arguable rather than
wrong: "the only reachable seam on the argv layer" is true if "seam" means "importable symbol"
(`dispatch` and `flag` are both module-private), but this PR adds `test/cli-argv.test.ts`, which
reaches that same layer through the real binary — and `docs/superpowers/specs/2026-09-17-issue-10-design.md:319-325`
(A5) frames the pair as complementary, not as one seam: "exporting the helper proves the helper, and
only the subprocess test proves the wiring." A reader of the comment alone would not know the
subprocess file exists.

**Fix.** Drop `Measured on a live run.` from `src/cli.ts:372` (the sentence before it already carries
the whole *why*, and needs no provenance claim), or replace it with what actually happened, e.g.
`Measured against the parser, not observed live.` Optionally reword `:366-367` to "the only
importable seam", or point it at the sibling: "the subprocess test in `test/cli-argv.test.ts` proves
the wiring; this proves the helper."

Both are inherited verbatim from `docs/superpowers/plans/2026-09-17-issue-10-plan.md:109-115`, so this
is not an undisclosed divergence — the plan says it too. It is still what ships in `src/cli.ts`.

---

## Checked against its siblings and clear

Each of these was a candidate finding I resolved against the code rather than waved through.

**The validation block mirrors the block directly above it, and does not invent a second way.**
`src/cli.ts:75-94` sits in `cmdTask` next to the argv-accident guards at `:63-69`: same shape (a
`why`-only comment, then `return fail(...)` per rule), same placement (before the task literal at
`:99`, because nothing removes a minted task), same message grammar (flag name first, lowercase, the
offending value last). No helper, no validator object, no new module — and A7
(`spec:334-339`) is why there is no general path validator to be consistent with. A `src/lib/argv.ts`
would have been the plausible second way, and A5 (`spec:319-322`) argues against it from
`.claude/agents/plugin-dev.md:14`, which assigns argv parsing to `src/cli.ts`. I re-read that line and
it does.

**The `  → ` hint line is an existing pattern, not a new presentation.** `src/cli.ts:85` emits a
two-space-indented `→` continuation; `src/lib/status.ts:91` already does exactly that
(`'  → nothing will advance until a supervisor is running:'`). `→` as a separator is likewise already
in `src/cli.ts:127` and `src/supervisor/deliver.ts:236`. The double-quoting of the offending entry
(`"${entry}"`) is not in the sibling messages at `:67` or `:124`, and is the right exception: the
value's defining property is that it contains whitespace, which an unquoted echo would hide.

**No formatter was duplicated.** `task.files` reaches a human in exactly one other place,
`src/lib/status.ts:46-57`, and that is prose inside a `blocked-on-files` warning with no list
formatter to reuse (`grep` for a files formatter across `src/lib/` finds `filesOverlap`,
`filesClearFor` and nothing rendering). The one-line `filesLine` at `src/cli.ts:139` is built once and
used on both success returns (`:143`, `:152`) rather than inlined twice.

**Nothing downstream parses the output that changed.** `grep -rn "task_id:" src prompts bin test`
shows the only consumers of `hpipe task`'s stdout are human: `prompts/dispatch.md:26-28` (updated by
this PR to name the two header lines and the blank line) and `prompts/intake.md:28-32`. No hook,
action or supervisor path splits that text, and `src/lib/worker-prompt.ts` renders no `files:` line,
so the header does not collide with the brief.

**The echo's placement is consistent with the return it joins.** `src/cli.ts:143` and `:152` already
compose their text inline; there was no `formatTaskResult` to extend.

**Reporting only the first bad entry is defensible, not an inconsistency with the `--depends-on`
check.** `:124` collects every unknown id (`unknown.join(', ')`) while `:81-94` returns on the first
offender. The asymmetry is forced by the message: the `→` suggestion is per-entry and would be
meaningless aggregated, and the shape that produces the error — one quoted list in one `--files` —
yields exactly one offending entry (`research:113-117`). I could not construct a realistic command
where the difference costs a round trip.

**No dead code, no commented-out code, no restating comments.** The diff adds no unused symbol
(`listFlag`'s export is consumed by `test/cli.test.ts:142-156`, and its export is explained at the
declaration), removes the old single-lookup body entirely rather than leaving it, and every new
comment in `src/cli.ts`, `test/cli.test.ts` and `test/cli-argv.test.ts` carries a *why* the code
cannot: why the check must precede `run.tasks.push` (`test/cli.test.ts:170-171`, `:184-185`), why the
subprocess env is pinned (`test/cli-argv.test.ts:17-23`), why an assertion is a negative
(`test/cli-argv.test.ts:85-88`). None paraphrases its next line.

**The new test file follows the house style rather than inventing a harness.** It reuses `tempDir`,
`git` and `cleanupFixtures` from `test/helpers/git-worktree.ts` with `afterEach(cleanupFixtures)` —
the same registration `test/tasks.test.ts` and `test/deliver.test.ts` use — and its name follows the
existing `cli.test.ts` / `cli-commands.test.ts` family. It is the repo's first subprocess CLI test
(`grep -rn "Bun.spawn" test/` previously found only `test/herdr.test.ts:65` and the `git` helper),
which is a new pattern, but it is the pattern the bug demanded and the one
`.claude/agents/plugin-dev.md:53-59` asks for: unit tests with DI fakes are where this class of defect
already hid twice. There is no index or workflow listing test files that needed updating.

**Test design, not test presence.** The five subprocess tests assert operator-visible facts — real
stdout, real exit codes — and none names an internal. Two carry their weight beyond the unit tests
they resemble: `test/cli-argv.test.ts:80-90` (a valueless `--files` swallowing `--surface`) is
producible *only* through argv, and its `not.toContain('no agent definition')` pins the exact reason
the bug was invisible; `:59` asserts the scratch state dir received the run, which doubles as the
canary for the A12 hazard — if the `HERDR_PLUGIN_STATE_DIR` pinning ever stopped taking effect, that
assertion fails in the same file rather than the fixtures landing in the live ledger. The overlap
between `test/cli.test.ts:142-156` (helper) and `test/cli-argv.test.ts` (wiring) is the split A5
argues for deliberately, at a measured cost of 275ms, so I am not calling it duplication. The
`listFlag` unit tests pin behaviour the code does not otherwise document, including the deliberate
non-rejection at `test/cli.test.ts:155-157` — `listFlag` keeps a flag-shaped value so `cmdTask` can
be the one to reject it, which is the seam between the two layers stated as a test.

**Documentation edits are consistent with each other.** `README.md:80`, `prompts/intake.md:24` and
`prompts/dispatch.md:33` now carry the identical `[--depends-on <id,id>] [--files <prefix,prefix>]`
signature, and `prompts/intake.md:28-32`'s claim that "repeating either flag adds to it rather than
replacing it" is true of both call sites, because `src/cli.ts:421-422` routes `--depends-on` and
`--files` through the same `listFlag`. Its "a value containing whitespace is rejected" also holds for
`--depends-on`, though by a different message (`--depends-on t1 t2` becomes one unknown id and dies at
`:124`).

---

Counts: 0 BLOCKERs, 0 MAJORs, 1 MINOR.

The change reads as though it were always there: the validation block is a sibling of the guards two
lines above it, the hint line and the error grammar are borrowed from code already in the repo, the
echo is composed once for both returns, and nothing was re-implemented that `src/lib/` already owns.
The single finding is one provenance sentence in one comment, fixable in place without touching a
decision, a message an operator sees, or anything only the human can call.

VERDICT: CLEAR
