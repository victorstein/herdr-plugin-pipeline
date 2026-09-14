# Stage 2 review — code quality for {{branch}} (#{{issue}}), pass {{pass}}

Stage 1 confirmed PR #{{pr}} does what was asked. Dispatch a fresh subagent to review it for **code
quality**: does it match how this codebase is already written?

Check: mirrors an existing pattern rather than introducing a second way to do something; naming and
structure consistent with siblings; no dead code, no commented-out code, no comments that restate
what the next line does; error handling matches the established shape; tests are well designed, not
merely present.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 0
    MAJORS: 2

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
