# Adversarial review of the plan — run {{run_id}}, pass {{pass}}

Dispatch a fresh subagent to review `{{plan_path}}` adversarially against `{{spec_path}}`.

Check specifically: does every spec requirement map to a task? Do types, function names, and
signatures stay consistent across tasks? Are there placeholders, vague steps, or steps that describe
what to do without showing how? Does each task leave the tree working and committable?

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, most severe first.

The reviewer writes the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 3

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
