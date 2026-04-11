# Mission Control Documentation Index

**Welcome to Mission Control!** This is your guide to understanding, operating, and improving the autopilot pipeline.

---

## For New Operators (30 min orientation)

Start here to understand the system and run your first cycle.

1. **[How the Pipeline Works](HOW-THE-PIPELINE-WORKS.md)** (10 min)
   - Overview of stages: research → ideation → swipe deck → task creation → dispatch → done
   - Planning lifecycle and approval flow
   - Workspace merge and PR creation
   - Supervised mode gaps (what's automated, what's manual)

2. **[Product Program Template](PRODUCT_PROGRAM_TEMPLATE.md)** (5 min)
   - What makes a strong product program
   - Finish-line artifact checklist format
   - Explicit exclusion list (Not Now)
   - Success criteria

3. **[Next Cycle Playbook](NEXT-CYCLE-PLAYBOOK.md)** (15 min)
   - Step-by-step repeatable process (7 steps, 30-60 min total)
   - Validation checklists
   - Budget and scheduling notes
   - Common issues + fixes

---

## For Deep Operational Knowledge

### [Card Operations Runbook](CARD_OPERATIONS_RUNBOOK.md)

**The source of truth for card lifecycle and recovery.**

- **Planning approval and recovery:** spec lock errors, stuck planning, inbox card promotion
- **PR merge gap:** why merged PRs don't auto-close cards (architecture gap)
- **Preventing duplicate dispatches:** how to verify cards don't have stale work
- **Upstream influences on card quality:** how research, ideation, and build_mode affect outcomes
- **Code paths that matter:** where business logic lives in the codebase

**When to use:**
- "My card is stuck in planning" → [Stuck Planning Cards](CARD_OPERATIONS_RUNBOOK.md#stuck-planning-cards)
- "PR merged but task still open" → [PR Merge Does Not Close Cards](CARD_OPERATIONS_RUNBOOK.md#pr-merge-does-not-close-cards)
- "Getting 'Spec already locked' error" → [Spec Already Locked Recovery](CARD_OPERATIONS_RUNBOOK.md#spec-already-locked-error)
- "How do ideas become tasks?" → [Upstream Influences on Card Quality](CARD_OPERATIONS_RUNBOOK.md#upstream-influences-on-card-quality)

---

## Quick Wins & Future Improvements

### [Quick Wins](QUICK-WINS.md) (High-impact, low-effort improvements)

Actionable improvements for the next sprint:

1. **✅ DONE:** Comprehensive pipeline documentation
2. **🚀 Priority:** Product program template + validation
3. **🔍 Next:** Idea scoring heuristics in swipe UI
4. **📊 Future:** Cycle health dashboard
5. **📝 Quick:** Auto-close merged PRs (GitHub webhook)
6. **🔐 Future:** Fix automation_tier enforcement

Each quick win includes effort estimate, impact assessment, and implementation guidance.

---

## Troubleshooting & How-Tos

### Common Problems

**"My research cycle is slow or stuck"**
- Check: `SELECT status, current_phase, last_heartbeat FROM research_cycles WHERE product_id = '<id>' ORDER BY started_at DESC LIMIT 1;`
- If phase hasn't changed in >5 min: Cancel and retry
- [Full diagnosis guide](CARD_OPERATIONS_RUNBOOK.md#ideation-level-failure-diagnosis)

**"Ideation cycle generated fewer ideas than expected"**
- Root cause: Research report is weak, truncated LLM response, or model misconfiguration
- Check: `SELECT ideas_generated, phase_data FROM ideation_cycles WHERE product_id = '<id>' ORDER BY started_at DESC LIMIT 1;`
- [Detailed diagnosis](CARD_OPERATIONS_RUNBOOK.md#ideation-level-failure-diagnosis)

**"Card shows 'merged' but task is still open"**
- Expected behavior (architectural gap): GitHub PR merge doesn't auto-close MC tasks
- Workaround: `sqlite3 mission-control.db "UPDATE tasks SET status='done' WHERE id='<id>';"`
- [Permanent fix in Quick Wins](QUICK-WINS.md#5--auto-close-merged-prs-in-mc)

**"Swipe deck shows no ideas"**
- Check 1: Did ideation cycle complete? `SELECT status FROM ideation_cycles ORDER BY started_at DESC LIMIT 1;`
- Check 2: Did ideas pass tier filter? `SELECT COUNT(*) FROM ideas WHERE status='pending' AND product_id='<id>';`
- Check 3: Are rejected ideas suppressing too many? `SELECT COUNT(*) FROM idea_suppressions WHERE product_id='<id>';`

### How-To Guides

- **How to run a research cycle** → [Next Cycle Playbook, Step 3](NEXT-CYCLE-PLAYBOOK.md#step-3-run-fresh-research-cycle-5-min)
- **How to swipe the deck** → [Next Cycle Playbook, Step 5](NEXT-CYCLE-PLAYBOOK.md#step-5-review-swipe-deck-10-20-min)
- **How to recover a stuck planning card** → [Card Operations Runbook](CARD_OPERATIONS_RUNBOOK.md#stuck-planning-cards)
- **How to approve an inbox card** → [Card Operations Runbook](CARD_OPERATIONS_RUNBOOK.md#inbox-card-promotion)
- **How to debug low idea count** → [Card Operations Runbook](CARD_OPERATIONS_RUNBOOK.md#ideation-level-failure-diagnosis)

---

## Architecture & Code

### Understanding the Full Pipeline

- **Research:** `src/lib/autopilot/research.ts` — audits product → report with gaps
- **Ideation:** `src/lib/autopilot/ideation.ts` — generates ideas from research + swipe history
- **Swipe deck:** `src/lib/autopilot/swipe.ts` — user approves/rejects ideas → `createTaskFromIdea()`
- **Task dispatch:** `src/app/api/tasks/[id]/dispatch/route.ts` — sends task to builder
- **Workflow:** `src/lib/workflow-engine.ts` — manages stage transitions and queue draining
- **Planning:** `src/app/api/tasks/[id]/planning/route.ts` — planning LLM, spec creation
- **Approval:** `src/app/api/tasks/[id]/planning/approve/route.ts` — spec lock, dispatch to builder
- **Signals:** `src/lib/agent-signals.ts` — handles TASK_COMPLETE, TEST_PASS, VERIFY_PASS signals
- **Merge:** `src/lib/workspace-isolation.ts` — workspace merge, PR creation, branch management

### Key Concepts

- **build_mode:** Does `plan_first` (default: planning required) or `auto_build` (immediate dispatch)?
- **Tier filter:** Only ideas with `tier-2` or `tier-3` tags are accepted (tier-1, tier-4, tier-5 rejected)
- **Similarity dedup:** Ideas >90% similar to rejected ideas are auto-suppressed
- **Supervised mode:** Manual operator override required for key decisions (not full-auto)
- **automation_tier:** (Stored but not enforced) Would control auto-approval, auto-merge, etc. if enabled

---

## Meta: Keeping These Docs Up-to-Date

### When to Update

- New operational lessons learned → update [Card Operations Runbook](CARD_OPERATIONS_RUNBOOK.md)
- New repeatable process step → update [Next Cycle Playbook](NEXT-CYCLE-PLAYBOOK.md)
- Code architecture changes → update the [Architecture & Code](#architecture--code) section
- New quick win identified → add to [Quick Wins](QUICK-WINS.md)

### Where to Log Lessons

- Session memory: `/memories/session/YYYY-MM-DD-cycle-notes.md` (what worked, what didn't)
- Repository memory: `/memories/repo/mission-control-*.md` (architectural facts, operational patterns)
- Product comment: Update product program with learned preferences

---

## Related Resources

- **Mission Control Dev:** `/mission-control/README.md` (setup, build, test)
- **BoreReady Product:** Mission Control board at `http://localhost:4000/workspace/boreready`
- **Research Reports:** View latest research at `http://localhost:4000/autopilot/<productId>?tab=research`
- **Swipe Deck:** Review ideas at `http://localhost:4000/autopilot/<productId>?tab=swipe`

---

## Feedback

Found something confusing? Missing a step? Found a bug in the runbook?

Document it in your session memory, then:
1. Update the relevant runbook
2. Push a commit with the fix
3. Note it in the next cycle summary

This doc improves with each operator.
