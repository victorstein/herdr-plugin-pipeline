# Hold — {{held_title}} waits on the human before it merges

{{held_line}} waits on the human for:

{{held_checks}}

1. **Make it mergeable first.** The human should check the head that will merge, and a rebase replaces
   it. {{held_mergeable}}
2. **Then tell the human once,** in a message of its own, never bundled with another question, what to
   check and on which build: {{held_build}}

   End your turn. No stall probe comes while you wait.
3. **When they answer, record it:**

       {{hpipe}} confirm --check <id> --by human                    # they checked it, and it holds
       {{hpipe}} confirm --check <id> --by human --waive "<why>"    # they chose to skip it
       {{hpipe}} confirm --check <id> --by human --failed "<what they saw>"

Do not merge, and do not ask again because a digest lists it: the merge command comes as its own
prompt once nothing is owed.{{held_failed_route}}
