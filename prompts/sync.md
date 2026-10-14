# Sync — {{branch}} ({{bead}}) with `{{batch}}`

Your change {{cleared_as}}, and it is next in line to land on `{{batch}}`. It may land only once it
contains every landing before it, so bring `{{batch}}` in, check, and submit again. Nothing else is
asked of you here.

1. **Merge it in:**

       {{merge_batch}}

   If git answers "Already up to date", there is nothing to merge: go straight to step 4, which checks
   exactly the tree that will land.
2. **On a conflict**, resolve it the way `implement` works: you keep the judgment, and one subagent
   with `model: {{implement_model}}` writes the resolution. If it runs in the background, end your
   turn and carry on when its completion notice arrives; never poll for it or sleep while it runs. A
   merge whose conflict you resolved is not a clean merge: `submit` sends the change through review
   before it lands, because the resolution is code no reviewer has seen.{{shared_note}}
3. **If the merge changed what this repo's bootstrap builds**, re-run `./.claude/pipeline-bootstrap`
   here before you check anything.
4. **Push, then submit:**

       {{hpipe}} submit --task {{task_id}}

   {{check_note}} It refuses, with the reason, until the merge is pushed{{check_until}}; fix what
   it names and run it again.
5. **If the check fails**, fix it the same way — a subagent writes the fix, you verify it — then commit,
   push and submit again. Only a merge git made on its own, left as git made it, lands without another
   review: a resolved conflict, an edit to the merge, or any commit after it sends this branch through
   review. That is expected, not a failure.

Never rebase, squash or force-push this branch: the supervisor reads its first-parent history to tell
an automatic merge of `{{batch}}` from new code, and a rewritten history reads as new code.
