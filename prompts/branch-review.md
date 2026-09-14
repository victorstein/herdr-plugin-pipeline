# Final whole-branch review — run {{run_id}}, pass {{pass}}

Every task is merged and torn down. Dispatch a fresh subagent to review the **whole** body of work
against `{{spec_path}}`, not task by task.

Check specifically what per-task review cannot see: seams between tasks, duplicated abstractions
introduced independently by two workers, contradictions between what task 1 assumed and task 6 built,
and requirements in the spec that no task actually implemented.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 2

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline. Write the trailer at the **start of the line** — not indented, and not inside a code fence. An indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may follow it.
