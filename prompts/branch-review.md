# Final whole-branch review — run {{run_id}}, pass {{pass}}

{{task_outcomes}}

Dispatch a fresh subagent to review the **whole** body of work, not task by task.

There is no run-level spec to review against: each task carried its own, on its own branch. Start
from this run's merged PRs — `{{hpipe}} show --task <id>` prints each task's `pr:` — and read each
one's spec and plan under `docs/superpowers/specs/` and `docs/superpowers/plans/`. Those are the
contracts the work claimed to fulfil.

Before you write the verdict, read what the workers found out of scope:

    {{hpipe}} discoveries

Each line is a bug or a follow-up a worker recorded instead of fixing it in its PR. File them as
beads with `{{hpipe}} discoveries --file`, which files every unfiled one, each linked to the bead it
came from. Filing is all-or-nothing, so name in the review any the human may want to close after
filing.

Check specifically what per-task review cannot see: seams between tasks, duplicated abstractions
introduced independently by two workers, contradictions between what the first task assumed and what
the last one built, and requirements that every individual PR passed but no PR actually implemented.

Open the review with the line `Tiers: {{task_tiers}}`.

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
    MAJORS: 2

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline. Write the
trailer at the **start of the line** — not indented, and not inside a code fence. An indented or
fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may follow it.

A BLOCKER sends this phase round again and you patch the branch directly — there is no task left to
send it back to.
