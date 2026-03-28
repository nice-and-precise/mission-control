# Documentation Map

Start here when you need to know which Mission Control docs to trust.

## Active Docs

- [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md): canonical truth for this machine and this local fork
- [LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md): short local ops commands for start, health, backup, and cleanup conventions
- [../README.md](../README.md): upstream/public-facing product guide
- [../ORCHESTRATION.md](../ORCHESTRATION.md): workflow behavior and runtime evidence expectations
- [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md): agent callback and completion-marker contract
- [ORCHESTRATION_WORKFLOW.md](ORCHESTRATION_WORKFLOW.md): orchestration-specific implementation guide

## Reference Docs

- [HOW-THE-PIPELINE-WORKS.md](HOW-THE-PIPELINE-WORKS.md): plain-language stage walkthrough
- [TESTING_REALTIME.md](TESTING_REALTIME.md): realtime verification checklist

## Historical / Design Docs

- [INTEGRATION_FIXES.md](INTEGRATION_FIXES.md): completed milestone summary
- [REALTIME_SPEC.md](REALTIME_SPEC.md): earlier design spec
- [archive/status/README.md](archive/status/README.md): archived status snapshots and handovers

## Documentation Conventions

- Keep machine-specific truth in [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md), not in upstream/public docs.
- Keep local operator commands in [LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md), not scattered across status notes.
- Use repo-relative links inside docs.
- Mark docs clearly as `active`, `reference`, or `historical` so readers know what wins in a conflict.
- Archive stale snapshots instead of letting multiple “current status” docs drift in parallel.
- When runtime behavior changes materially, update the docs map plus the affected active doc in the same change.
