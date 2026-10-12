# Final whole-branch review — run {{run_id}}, pass {{pass}}

{{task_outcomes}}

Dispatch a fresh subagent with `effort: {{review_effort}}` to review the **whole** body of work, not
task by task. If the dispatch is rejected for its effort, dispatch without `effort:`.

{{scope}}

Before you write the verdict, read what the workers found out of scope:

    {{hpipe}} discoveries

Each line is a bug or a follow-up a worker recorded instead of fixing it in its {{change_noun}}. File them as
beads with `{{hpipe}} discoveries --file`, which files every unfiled one, each linked to the bead it
came from. Filing goes in order and stops at the first failure, keeping what it already filed; once
the cause is fixed, run it again and it carries on without filing any twice. Name in the review any
the human may want to close after filing.

Check specifically what per-task review cannot see: seams between tasks, duplicated abstractions
introduced independently by two workers, contradictions between what the first task assumed and what
the last one built, and requirements that every individual {{change_noun}} passed but no {{change_noun}} actually implemented.

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

The supervisor reads the review from disk once you are idle. Leave it uncommitted: it is the run's record, not
part of the work, and committing it would ship a review file with the work.

{{blocker_note}}
