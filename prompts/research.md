## Phase 1 — research

Before designing anything, establish how this repo actually behaves today. Write what you found to
exactly this path:

    {{research_path}}

Answer, with evidence: which files own the behaviour issue #{{issue}} is about; what the current
control flow is; what versions of the tools and packages involved are actually installed; and what
the nearest existing example of this kind of change looks like. Cite `file:line`, or the exact
command and its output.

Assert nothing from memory. Unverified claims are the single most common blocker this pipeline's
reviews find, and every later phase — the spec, both reviews, the orchestrator triaging a decision —
reads this note as established fact.

It may be short. It may not be empty, and it may not simply restate the issue.

Commit and push it, then stop. The spec is the next phase and arrives on its own.
