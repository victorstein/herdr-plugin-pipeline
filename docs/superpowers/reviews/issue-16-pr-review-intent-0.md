# PR review — intent, pass 0 — issue #16 / PR #54

Branch `fix/16-worktree-bootstrap` at `cc82cf4`, reviewed against issue #16 (including the
**Ownership ruling — `src/cli.ts`, 2026-09-19** at the bottom of its body),
`docs/superpowers/specs/2026-09-19-issue-16-design.md` and
`docs/superpowers/plans/2026-09-19-issue-16-plan.md`.

## What I verified, and how

**The PR body's numbers are real.** Re-run in this worktree at `cc82cf4`:

    $ bun test
     551 pass
     0 fail
     1364 expect() calls
    Ran 551 tests across 36 files. [8.99s]

    $ bun run typecheck
    $ tsc --noEmit
    (exit 0, no output)

Every figure the PR body quotes matches to the digit, including the file count. The arithmetic is
also self-consistent with the plan: the plan's post-revision expected end state was **527**, the
branch adds **24** tests (`test/bootstrap.test.ts` 12, `test/cli-commands.test.ts` 5,
`test/prompts.test.ts` 5, `test/tasks.test.ts` 2), and 551 − 24 = 527 is `main`'s own count — i.e.
the rebase added the sibling's tests and dropped none of this branch's.

**The rebase kept both sides.** Merge-base is `f406173`, the commit the PR body names. Every
`^test(` name present in `f406173`'s `test/cli-commands.test.ts`, `test/prompts.test.ts` and
`test/tasks.test.ts` is still present on the branch (checked by exact-line match; zero lost).
`import { reserveVerdict } from './lib/verdict-path'` — #26's side of the one `src/cli.ts` conflict
hunk — survives at `src/cli.ts:21`, with `./lib/bootstrap` in its alphabetical slot at `:4`.
`origin/main` has since moved to `06f1957`, but only by `chore(main): release 1.2.11 (#53)`
(manifest, CHANGELOG, `herdr-plugin.toml`, `version.txt`); `git merge-tree` against it produces no
conflict.

**The ownership ruling is honoured, and the escape hatches were used rather than paraphrased.**
`git diff origin/main...HEAD -- src/cli.ts` is 8 insertions / 2 deletions: the import at `:4`, the
`bootLine` computation at `src/cli.ts:260-263`, and the two `return ok(...)` lines at
`src/cli.ts:267` and `src/cli.ts:276`. `cmdRewind` is byte-identical to `main`; `cmdBrief` is
untouched (**NG9**). The ruling's condition (3) — surface a real rebase conflict rather than resolve
it — was met in fact, not only in prose: the live ledger
(`runs/pipeline/herdr-plugin-pipeline-20260919-…-wyy3.json`, t2) carries `d2` (the implementer
refusing to open the PR before #26 merged, held) and `d3` (the conflict reported, with the
orchestrator's answer `GRANTED - resolve all three and continue`, naming the alphabetical-slot
resolution the branch actually applied). The PR body's "was authorised rather than taken
unilaterally" is a true statement with a record behind it.

**Every spec testing item lands.** Items 1–9 in `test/bootstrap.test.ts:23-87`; 10–13 in
`test/cli-commands.test.ts:693-757` (item 12's contract asserted as exact array equality on the
header block, which is stronger than the spec asked); item 11's queued return in
`test/cli-commands.test.ts:759-779`; 14–16 in `test/tasks.test.ts:521-545`; 17–21 in
`test/prompts.test.ts:157-201`. The tests exercise behaviour rather than restate implementation:
`cmdTask` is driven end to end over a real fixture repo with a real on-disk script at a real mode,
and the `0o644` case (`test/cli-commands.test.ts:727`) asserts the caveat reaches the orchestrator
rather than asserting the branch was taken.

**Spec components all implemented, none half-done.** C1 `src/lib/bootstrap.ts:1-61` (no-spawn,
no-throw, `isFile()` before the mode test, per **A7**); C2 `src/supervisor/tasks.ts:156-160`, with
the `\n\n` → `\n` + line + `\n\n` shape that preserves the single blank line; C3
`src/cli.ts:260-276` on *both* returns; C4 `src/lib/worker-prompt.ts:2,33` +
`prompts/worker-brief.md:16`; C5 the `not-executable` state, now exercised at both the orchestrator
and worker levels; C6 all four pieces — `prompts/dispatch.md:26-29` (the count corrected and
`bootstrap:` given its own action), `prompts/dispatch.md:34-51` (the procedure), `.claude/pipeline-bootstrap`
committed at mode `100755` (`git ls-files -s` confirms, and `sh -n` is clean), and
`README.md:70-84` stating all five contract terms the spec enumerates (path, executable, runs from
the worktree root, must be idempotent, omit it if you need nothing).

**No scope expansion.** The changed-file set is exactly the spec's *Files this change declares*
table plus the pipeline's own `docs/superpowers/` artifacts. Nothing touches the ledger,
`schema_version`, `src/supervisor/teardown.ts`, `dist_note` or `cmdRewind`.

**No silent scope reduction.** The one place the PR departs from the issue's *Directions* — the
plugin names the bootstrap but never executes it — is not silent: it is **NG1**, argued in the
spec's *Rejected alternatives*, cleared at spec review, restated in the PR body's first paragraph,
and endorsed by the orchestrator's own `d1` answer, which ratified the "one reader, two emitters"
shape. I am not re-litigating it.

**Plan divergence.** The plan's step-9 README check predicted `69:### Bootstrapping…`; the heading
landed at `70`. That is an off-by-one in the prediction, not a divergence — the anchor requirement
(last subsection inside `## Install`, nesting nothing) holds: `20:## Install`,
`70:### Bootstrapping worker worktrees`, `86:## Use`. I found no other divergence from the plan.

I found one finding, and it is a MINOR.

---

## MINOR 1 — the new `## Bootstrapping the new checkout` heading files the rest of `dispatch.md` underneath it

`prompts/dispatch.md:34` introduces a `##` heading into a file whose only heading until now was the
H1 at `:1`. Everything after it — `**Still registering?**` at `:53-60` (the `task --branch …`
syntax and the "never run two agents against the same files" rule) and `**When the last task is
registered:**` at `:62-66` (`dispatch --done`, without which the run cannot finish) — now reads as
subordinate to a section about bootstrapping a checkout, because nothing closes the section.

This is the same defect class the plan review already caught and fixed for the README
(`docs/superpowers/plans/2026-09-19-issue-16-plan.md:24`, MAJOR 2: an `###` anchor that "filed 53
lines of `## Install` under the new subsection"). The remedy applied there — anchor last, so the new
heading nests nothing — was not applied here, because the plan's own step 8 instructed
"append this subsection immediately before the `**Still registering?**` heading"
(`plan.md:621`). The implementer followed the plan exactly; the plan carried the defect.

Ranked MINOR rather than MAJOR: the swallowed content is short, bold-led and self-describing, so an
orchestrator reading top-to-bottom is unlikely to act differently — the cost is structural, not
behavioural. It is also nothing the spec asked for: **C6** specifies "a short static subsection",
not a placement that reorganises the document.

**Fix, inline:** move the `## Bootstrapping the new checkout` block (`prompts/dispatch.md:34-51`) to
the end of the file, after the `{{hpipe}} dispatch --done` block at `:62-66`, where it nests
nothing. The cross-reference at `:26-29` already points the reader at `bootstrap:`, so nothing
depends on the section sitting where it is, and the `test/prompts.test.ts:181-188` pin
(`bootstrap:` / `three header` / not `two header`) is placement-independent and stays green.

---

I looked for, and did not find: a PR body misreporting its own figures; an edit outside `cmdTask`;
a dropped sibling test; a spec requirement implemented only on the easy path (both dispatch paths
carry the line, and both are tested); a test that would still pass with the feature removed; or an
undisclosed divergence from the plan.

VERDICT: CLEAR
