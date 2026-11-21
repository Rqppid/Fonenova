# FoneNova project instructions

Read docs/agents/HANDOVER.md and docs/agents/TASKS.md before starting work.
Read any more specific AGENTS.md in the directory you edit, especially dashboard/AGENTS.md.

## Working rules
- This repository contains two independently installed Next.js apps. Use pnpm at the root and npm in dashboard/. Preserve both lockfiles.
- Keep website work separate from dashboard work unless the task explicitly crosses them.
- Work on a task branch. Report the commit, changed files, test results, and remaining work.
- Never merge or deploy automatically. Do not call live payment, accounting, email, ledger upload, or production write endpoints for a coding task.
- Use sample data and mocks for validation. Never commit credentials, local environment files, private customer data, financial documents, or chat exports. This repository is public.
- Financial amounts use integer cents. Preserve currency, VAT, gross/net, and reconciliation semantics.
- A failed check is a failed check; distinguish existing failures from regressions.

## Team protocol
These are operating instructions, not an installed agent orchestrator.
- Lead (Elephant): read the handover, break the requested outcome into bounded tasks, own TASKS.md, resolve dependencies, integrate reviewed commits.
- Workers: use separate git worktrees and task branches from the same base commit. Assign disjoint file ownership where possible. Report changed files, commit SHA, checks, and blockers to the lead.
- Reviewer (Goldfish): start a fresh context with the user request, applicable instructions, diff, and check results. Independently verify claims.
- Workers do not edit the shared task board concurrently. The lead records their updates.
- Stop for a missing requirement or credential, repeated test failure, or exhausted usage budget. Save a useful handover rather than looping.
- Finish with a detailed public-safe summary in HANDOVER.md when project state changes. A summary must separate verified facts from proposed work.
