# FoneNova project handover

## Snapshot
Prepared 21 November 2026 from main at b178438f06577682ad5170a7c7c3f92e3faa392e.
This is a source-derived handover, not an import of previous Claude conversations.

## What lives here
- Root app/: FoneNova website and public offer experience. app/offer/[token]/page.tsx renders offers; app/api/offer/answer/route.ts handles responses.
- dashboard/: separate profit/operations application with its own package.json and npm lockfile.
- Root components/, lib/, styles/, public/: shared website implementation/assets.
- dashboard/lib/ and dashboard/tests/: dashboard logic and its substantial test suite.
- docs/: reference documents. dashboard/README.md contains setup and integration details.

Both apps use Next.js 16 and React 19. The dashboard instructions require consulting the installed Next.js documentation before changes because APIs may differ from earlier versions.

## Install and checks
Website: pnpm install --frozen-lockfile, then pnpm test.
Dashboard: npm ci inside dashboard/, then npm test. It also provides npm run typecheck.
Root uses pnpm-lock.yaml (format 9); dashboard uses package-lock.json.
Do not replace either package manager or regenerate a lockfile merely to get past an error.

Tests cover public offers at root and dashboard calculations, auth, offers, integrations, and reconciliation.
Some reconciliation tests need an ignored real ledger and are deliberately skipped without it. A sample-only pass is not proof that production financial data reconciles.
Builds and production integration checks are separate from unit tests.

## Deployment and external systems
dashboard/README.md describes a separate Vercel project rooted at dashboard/ and the dashboard.fonenova.com deployment. The root is the website app.
Dashboard code/docs reference Google sign-in, Upstash storage, OneDrive, Xero, Gmail, Make, and a separate payments service.
Do not exercise live services or copy their secrets into CI for the pilot.
README contains historical local-only sections alongside newer hosted setup. Verify the implementation and current configuration before relying on an older paragraph.

## Recent main work
- OneDrive file content reading route (PR 74).
- DHL pricing context documentation (PR 72).
- Offer deletion without a linked order (PR 71).
- Generic clients (PR 70).
- Unknown model warnings/device support (PR 69).
Do not overwrite these changes while introducing agent tooling.

## Agent pilot status
This branch adds shared instructions, this handover, a task board, and a manually triggered GitHub Actions unit-test workflow.
The workflow installs and tests the two apps in parallel on GitHub-hosted machines, with a 20-minute timeout per job.
It requires no model credentials and spends no Claude/API tokens.
It does not launch AI agents, modify code, open PRs, merge, or deploy.
No cloud execution is verified until its first actual run. See TASKS.md for activation and remaining integration work.

## Target workflow, not yet installed
One graphical workspace; project selection; lead with smaller workers; separate worktrees; fresh independent reviewer; shared summaries; bounded cloud jobs that survive closing the laptop.
A FreeLLMAPI service running only on the laptop cannot serve an overnight cloud job once the laptop sleeps.
Model quotas and hosted job limits still apply. The model gateway and cloud worker authentication must be verified before enabling autonomous coding.

## How to resume
Read this file and TASKS.md, inspect git status and the current branch, and confirm the requested task.
Use the repository rather than assumptions from old chat transcripts as the source of truth.
End a session with the exact changes, checks, failures, unresolved decisions, and next step. Do not publish confidential business context in these public files.
