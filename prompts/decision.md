# Decision from {{task_id}} — {{branch}} (#{{issue}}), asked in `{{phase}}`

The worker has stopped and is waiting on you.

**Question**

{{question}}

**The worker's recommendation**

{{recommendation}}

## Answer it yourself where the answer already exists

Read before you escalate: issue #{{issue}}, the repo's `CLAUDE.md`, the surface's agent file, and an
existing call site that already settles the same question. If the answer is determined by any of
those, it is not a decision — answer it and cite where it came from. Escalating a question the repo
already answers spends the human's attention on nothing.

## Otherwise put it to the human — with your own recommendation

Give them, in a few lines: the question, the worker's recommendation, your own read of it, and the
option you recommend, named. Never hand over a bare question: forming the recommendation is the work,
and passing it up unformed is exactly the cost this pipeline exists to remove.

## Either way, record the answer

    hpipe answer --task {{task_id}} --decision {{decision_id}} \
                 --answer "<the decision and the reason for it>" \
                 --by orchestrator|human

`--by` is the audit trail and only you know which it was: `orchestrator` if you settled it from the
repo, `human` if you asked. The worker resumes `{{phase}}` when the answer reaches its pane.
