# Stage 1 review — spec compliance for {{branch}} (#{{issue}}), pass {{pass}}

Dispatch a fresh subagent to review PR #{{pr}} on `{{branch}}` for **spec compliance only** — does it
do what the task asked, completely, and nothing it was not asked to do? Code quality is stage 2 and
is not your concern here.

Check: every acceptance criterion in the task met; no silent scope reduction; no scope expansion;
tests actually exercise the behaviour rather than restating the implementation.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 0

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline. Write the trailer at the **start of the line** — not indented, and not inside a code fence. An indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may follow it.
