# Agent task board

The lead owns this file. Workers return reports; they do not race to rewrite it.
Status: planned, in progress, blocked, done. Record evidence before marking done.

| ID | Task | Owner | Status | Evidence / next step |
| --- | --- | --- | --- | --- |
| P01 | Inspect repository and write project handover | Setup | done | HANDOVER.md, based on main b178438 |
| P02 | Prepare manual cloud unit-test workflow | Setup | done | .github/workflows/cloud-agent-pilot.yml; first cloud run pending |
| P03 | Review, merge, and run the pilot | Owner | planned | GitHub Actions > FoneNova cloud pilot > Run workflow after merge |
| P04 | Verify model access and cloud authentication | Setup + owner | planned | Claude subscription auth and FreeLLMAPI runner compatibility; never paste tokens into chat |
| P05 | Connect graphical project/task interface | Setup | planned | Verify supported cloud dispatch/resume path before claiming one-window operation |
| P06 | Add lead and two isolated workers | Setup | planned | Worktrees, bounded tasks, reports, cancellation, usage limits |
| P07 | Add fresh reviewer and draft-PR delivery | Setup | planned | Independent review; no automatic production merge |
| P08 | Roll verified configuration out to other repositories | Setup | planned | Separate instructions, package managers, visibility, and CI quotas for each repo |

## Worker report template
Task ID:
Base commit / branch:
Owned paths:
Result commit:
Changes:
Checks and exact results:
Blockers / remaining work:
Suggested next step:
