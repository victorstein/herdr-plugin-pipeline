# Adversarial review of the plan — run {{run_id}}, pass {{pass}}

Dispatch a fresh subagent to review `{{plan_path}}` adversarially against `{{spec_path}}`.

Check specifically: does every spec requirement map to a task? Do types, function names, and
signatures stay consistent across tasks? Are there placeholders, vague steps, or steps that describe
what to do without showing how? Does each task leave the tree working and committable?

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, most severe first.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

The reviewer writes the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 3

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline. Write the trailer at the **start of the line** — not indented, and not inside a code fence. An indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may follow it.
