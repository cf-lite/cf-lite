---
version: 0.4.0
scope: agents
evidence: n/a
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief template

Copy the block below to `agents/<process>.md`, fill every section, and add the brief to the table in [README](README.md). A brief nobody has run end to end keeps `evidence: unverified`; the author re-runs its commands once in a clean worktree and only then sets `verifiedOn`.

````markdown
---
version: <train, equals the product version>
scope: agents
evidence: unverified            # n/a once a run has verified the commands
verifiedOn: YYYY-MM-DD          # last date the commands below were run end to end
owner: <role>                   # who answers questions: a role, never a person
---
# Brief: <verb phrase, one process>

## 1. Purpose
What outcome this process produces and why it exists. One line: what it is NOT.

## 2. Trigger
When to run it (event, cadence, request type). When NOT to.

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|

## 4. Steps
Work in a fresh worktree from the default branch. Numbered; each step is a command in a code block, the expected result in one line, and what to do when it differs.

## 5. Outputs
Files that change, PR title pattern, what the PR body must contain.

## 6. Evidence rules
Labels used here and what counts as proof for each claim type. "Not run" is a valid answer.

## 7. Stop and ask (owner)
Exhaustive list. Always includes: publish, tag, version bump, credentials, hostnames or accounts, promoting a label or tier, deleting history, anything touching a production instance, any fact only the owner knows.

## 8. Forbidden
No infrastructure names, no client or project names, no secrets or URLs with query strings, no hand edits of generated files, no touching other repositories, no weakened gate.

## 9. Hand-off
Fixed final-message fields: branch and PR, commands run with results, evidence table, flagged items, what the next agent does, what could not be verified. Work that spans sessions: a committed handoff note, deleted when done; never chat.

## 10. Where truth lives
| Question | File or command |
|---|---|

## 11. Definition of done
Checklist of gates, each with its command; "done" is claimed only with the output.

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
````
