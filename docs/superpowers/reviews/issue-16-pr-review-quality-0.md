# PR #54 — stage 2, code quality

Branch `fix/16-worktree-bootstrap`, 22 commits, rebased onto `main` after #52. Code surface under
review: `src/lib/bootstrap.ts` (new, 61 lines), `src/cli.ts`, `src/lib/worker-prompt.ts`,
`src/supervisor/tasks.ts`, `prompts/dispatch.md`, `prompts/worker-brief.md`, `README.md`,
`.claude/pipeline-bootstrap` (new, executable), plus `test/bootstrap.test.ts` (new) and additions to
`test/cli-commands.test.ts`, `test/prompts.test.ts`, `test/tasks.test.ts`. The remaining ~2,500 added
lines are `docs/superpowers/` research, spec, plan and review records.

Gates verified in this worktree: `bun test` → **551 pass / 0 fail**, 1364 expect() calls across 36
files. `bun run typecheck` → **exit 0**. Both match what the brief predicted.

Scope: how the change is written. Intent and scope are settled by stage 1
(`docs/superpowers/reviews/issue-16-pr-review-intent-0.md`) and I did not re-litigate them.

---

## No BLOCKER, no MAJOR

I went looking for the failure modes the brief names and did not find them. Recording what I checked,
because "CLEAR" is only useful if it says what it covered:

**It mirrors its siblings rather than inventing a second idiom.** `bootLine` is computed and emitted
exactly where `filesLine` is (`src/cli.ts:258` and `:263`, both spliced into the same two returns at
`:267` and `:276`), and the supervisor emits the identical string from the same function
(`src/supervisor/tasks.ts:159`) rather than re-deriving it — one detector, two call sites.
`bootstrap_note` is wired into `renderWorkerPrompt` the way `dist_note` already is
(`src/lib/worker-prompt.ts:28-33`), including the same "empty string when not applicable" convention,
and sits beside it in the template (`prompts/worker-brief.md:14-16`). The tagged union with a
payload-free arm is the house shape for this (`GateState`, `src/lib/gating.ts:10-13`;
`SupervisorState`, `src/lib/pidfile.ts:9-12`).

**Nothing was duplicated.** There is no pre-existing repo-root file probe this could have reused —
the nearest thing is the one-off agent-definition check at `src/cli.ts:190-193`, which is inline and
not a detector. `BOOTSTRAP_REL` is a single constant serving both the on-disk `join` and the verbatim
prompt text, which is the right call and is explained at `src/lib/bootstrap.ts:4`.

**No dead code, no commented-out code, no restating comments.** Every comment in
`src/lib/bootstrap.ts` carries a *why*: `:26` explains why `isFile()` and not the mode bits alone,
`:13-19` explains why the function is throw-free and which checkout it actually reads. The
`17 of the last 20` figure at `src/cli.ts:261` is not invented — it traces to the spec's BLOCKER 1
ruling (`docs/superpowers/specs/2026-09-19-issue-16-design.md:59`, `:342`) and the plan prescribed
that exact wording (`docs/superpowers/plans/2026-09-19-issue-16-plan.md:457-458`). It matches the
repo's `Measured on a live run.` convention (`src/cli.ts:184`, `:199`; `src/supervisor/tick.ts:94`).

**Error handling matches the established shape.** `repoBootstrap` never throws and degrades to
`{ kind: 'none' }` (`src/lib/bootstrap.ts:29-31`), which is the same throw-safe posture `resolveRun`
and `hpipeCommand` take (`src/lib/render.ts:31-35`), and the reason is stated: both callers compose
agent-facing text, where a throw lands in front of an agent.

**The tests are designed, not decorative.** Four of them would actually have caught a plausible
regression rather than restating the implementation: `test/bootstrap.test.ts:38-45` pins that a
*directory* at the path is not `ready` (the exact bug `isFile()` exists to prevent);
`test/bootstrap.test.ts:62-70` pins the single-line contract across all three arms, which is what
protects the blank-line split both emitters depend on; `test/cli-commands.test.ts:706-724` asserts the
full three-line header as an array and that the brief still starts at `# feat/boot — issue #1`, so a
stray newline anywhere in the header fails loudly; and `test/prompts.test.ts:184-189` dogfoods this
repo's own `.claude/pipeline-bootstrap` including its executable bit. The `briefNote` test at
`:76-83` asserts the note *offers* a recovery and does not claim the script ran — that is a real
behavioural contract, not a string echo. The dynamic-import style in
`test/prompts.test.ts:162-179` copies its stated model at `:140-148`, so it is consistent, not sloppy.

What follows is four MINORs. All are one-line fixes, none changes behaviour, and none of them is a
reason to hold the branch.

---

## MINOR

### 1. Three `file:line` pointers this PR added do not point where they say

`test/bootstrap.test.ts:63` and `test/tasks.test.ts:534` both cite `prompts/dispatch.md:26-28` for the
blank-line split. The sentence they mean — "then hand over everything from the blank line onward" —
is on **line 29** after this PR's own re-flow of that paragraph. On `main` it *was* inside 26-28; the
edit at `prompts/dispatch.md:26-29` pushed it down one line, and the new comments were written against
the old numbering. The correct range is `prompts/dispatch.md:26-29`.

`test/bootstrap.test.ts:49` cites `src/cli.ts:252-255` for the `files:` rationale. That comment is at
`src/cli.ts:254-257` on this branch (`:253-256` on `main`), so the citation is off in both states —
`:252` is a blank line.

This is small, but it is the class of thing this repo is deliberate about: the branch already carries
a commit for it (`75e5029 docs: record the reviewer's citation corrections to the intent review`), and
a pointer that is wrong on the day it lands will not get better. Three number edits.

### 2. `bootstrapLine`'s doc comment points at "the test" without naming it

`src/lib/bootstrap.ts:34-37`

```ts
/**
 * One line, in the `files:` shape, addressed to the orchestrator. Single-line is
 * a contract rather than a style: see the test that pins it.
 */
```

Every other cross-reference in this codebase names a location — `src/lib/repo.ts:17-25` four lines
above at `:17`, `src/supervisor/tick.ts:109` in `stall.ts:99`, `src/cli.ts:304-320` in
`stall.ts:120`, and this PR's own comments elsewhere. "The test that pins it" is
`test/bootstrap.test.ts:62-70`; naming it costs nothing and survives the next reader who greps for
why the string may not wrap.

### 3. The `existsSync` guard is redundant with the `catch` two lines below it

`src/lib/bootstrap.ts:22-31`

```ts
  try {
    const path = join(repoRoot, BOOTSTRAP_REL)
    if (!existsSync(path)) return { kind: 'none' }
    const info = statSync(path)
```

`statSync` on a missing path throws `ENOENT` (verified), and the `catch` at `:29` already returns
`{ kind: 'none' }`. So `:24` is a second syscall producing an outcome `:29` produces anyway, and it
makes the `catch` read as if it only covers exotic errors when it is in fact the primary
not-found path. Deleting `:24` leaves `test/bootstrap.test.ts:24-26` ("a repo with no `.claude`") and
`:47-49` ("a nonexistent repo root … does not throw") green on exactly the same assertions.

If the intent is instead that the `catch` is a last resort and the `existsSync` is the documented
happy path, then say that in the comment — but as written the code has two spellings of one branch.

### 4. The edited paragraph in `prompts/dispatch.md` is left over the corpus wrap

`prompts/dispatch.md:26` is **125 characters** and `:27` is **108**. The other 19 files in
`prompts/` all cap at 106 and most at ~100-103. Line 26 was already the outlier on `main` at 123
chars; this edit added two more and left `:27` ragged rather than re-flowing the three lines it was
already rewriting. Re-wrapping `:26-29` fixes both this and finding 1's line drift in one pass, and
is the natural moment to do it since the paragraph is being touched anyway.

---

## Summary

| Rank | Finding | Where |
|---|---|---|
| MINOR | Three `file:line` citations added by this PR are off by one to two lines | `test/bootstrap.test.ts:49`, `:63`, `test/tasks.test.ts:534` |
| MINOR | Doc comment cites "the test" without naming it | `src/lib/bootstrap.ts:36` |
| MINOR | `existsSync` guard duplicates the `catch` below it | `src/lib/bootstrap.ts:24` |
| MINOR | Edited prompt paragraph left at 125/108 cols against a ~100-col corpus | `prompts/dispatch.md:26-27` |

No BLOCKER and no MAJOR. All four MINORs are comment or whitespace edits inside files this PR already
owns; none reverses a decision, changes scope, or needs a judgment only the human can supply. The
mechanism itself — one detector, two emitters, a conditional worker note, and a dogfooded script — is
sound and matches the patterns it set out to mirror.

VERDICT: CLEAR
BLOCKERS: 0
MAJORS: 0
