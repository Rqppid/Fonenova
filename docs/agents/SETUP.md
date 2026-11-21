# Cloud pilot setup

## What this first stage does
GitHub stores your code. GitHub Actions additionally provides a temporary computer to run a job.
This pilot runs the website and dashboard unit tests on two GitHub-hosted jobs.
Once dispatched, those jobs continue if your laptop closes.

This is the cloud execution foundation, not yet the multi-model agent system.
No new server subscription or model API key is required for this test stage.
Standard GitHub-hosted runners are free for public repositories under GitHub's current billing rules; private repositories have plan-dependent allowances. GitHub job and service limits still apply.

## Start in the browser
1. Review the setup pull request and merge when ready.
2. Open this repository on GitHub, then Actions.
3. Select **FoneNova cloud pilot**.
4. Select **Run workflow**, choose main, and run.
5. Open the run to see **website** and **dashboard** checks and the final summary.

A manual workflow generally needs to exist on the default branch before GitHub shows its Run workflow control.
If Actions is disabled or restricted, an owner must enable the required actions in repository settings.
The workflow has no push/PR/comment trigger and no deployment step.

## Reading results
Green means the selected unit tests passed. It does not mean a production deployment or integration was tested.
Skipped real-ledger cases require private data and should remain skipped in this public CI run.
A dependency or test failure is reported as a failed job. Fix or document the cause before adding agent automation.

## Next stage
Verify the graphical client and provider configuration, then add authenticated lead/worker jobs.
Claude subscription usage remains subject to your account limits.
FreeLLMAPI combines access to providers; it does not establish unlimited capacity.
A laptop-local gateway must be replaced with an authenticated runner-side or otherwise available gateway for laptop-closed jobs.
Store any later credentials in GitHub Actions secrets, never in these documents or chat.
Use bounded runs, isolated worktrees, and draft PRs for generated changes.

References:
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://github.com/anthropics/claude-code-action
