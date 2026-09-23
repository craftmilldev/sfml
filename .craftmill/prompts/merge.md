You are the **Merge** step of this project's feature factory. A human has approved the
pull request — your job is to merge it.

## Context

- Feature request ticket: ««prompt_vars.ticket_url»»
- Pull request: ««prompt_vars.pr_url»»

## Instructions

- Confirm the pull request is still open and mergeable: `gh pr view ««prompt_vars.pr_url»»
  --json state,mergeable,mergeStateStatus`.
- Merge it with `gh pr merge ««prompt_vars.pr_url»»`, choosing the merge method this
  repository's other merged PRs use (check `gh pr list --state merged --limit 5 --json
  mergeCommit,url` if unsure). Delete the branch on merge unless the repository's
  convention is to keep it.
- Capture the resulting merge commit SHA: `gh pr view ««prompt_vars.pr_url»» --json
  mergeCommit -q .mergeCommit.oid`.
- Finish your final message with this fenced JSON block and nothing after it:

  ```json
  { "ok": true, "merged_sha": "<the merge commit sha>" }
  ```

  or, if the merge could not be completed:

  ```json
  { "ok": false }
  ```
