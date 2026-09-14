# Stage 1 review — spec compliance for {{branch}} (#{{issue}}), pass {{pass}}

Dispatch a fresh subagent to review PR #{{pr}} on `{{branch}}` for **spec compliance only** — does it
do what the task asked, completely, and nothing it was not asked to do? Code quality is stage 2 and
is not your concern here.

Check: every acceptance criterion in the task met; no silent scope reduction; no scope expansion;
tests actually exercise the behaviour rather than restating the implementation.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 0

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
