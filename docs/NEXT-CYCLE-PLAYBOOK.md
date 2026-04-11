# Next Cycle Playbook

**Trigger:** All active cards have reached status `done`.

This document defines the repeatable process for cycling from post-delivery to the next improvement cycle.

## The State You're In

- All task lanes are empty (PLANNING=0, ASSIGNED=0, IN_PROGRESS=0, TESTING=0, REVIEW=0, VERIFICATION=0, DONE=N).
- All deliverables from prior ideas have landed on `main`.
- The repo is in a known stable state.

**Your timeline:** 30-60 minutes to cycle the next batch.

## Step 1: Validate the Landing (10 min)

Before running research on gaps, confirm that what landed is actually what you built.

### Checklist

- [ ] All merged commit messages are accurate (prefix: `fix:`, `chore:`, `feat:`)
- [ ] No stale branches remain remote (run `git branch -r | grep autopilot | wc -l` — should be 0)
- [ ] Task finish-line checklist reflects status on main (run verification)
- [ ] Product program matches the as-built state

**Command:**
```bash
# Verify no stale autopilot branches
cd ~/squti && git branch -r | grep autopilot | wc -l
# Should output: 0

# Verify recent commits are clean
git --no-pager log --oneline -N 12 | head -12

# Verify merged PRs are closed/merged state on GitHub
gh pr list --state merged --limit 20
```

### Common Issues

- **Stale branches remain:** `git push origin --delete <branch>`
- **Task program still shows DRAFT status for completed artifacts:** Update via SQL or run fresh research
- **Merged PRs still show "Open":** Automation didn't close them; manually close via UI

---

## Step 2: Update Product Program (5 min)

The product program is the source of truth for next gaps.

### Review

1. **Open** the product program editor at `/autopilot/[productId]`
2. **Check** the "Current Objective" — does it still reflect the highest priority?
3. **Update** the finish-line checklist if any items have changed (e.g., "Artifact #10: ~~Phase 2 planning~~ → Phase 2 final validation")
4. **Verify** the "Not Now" list still makes sense
5. **Run** `Audit & Sync Program` if repo truth may have changed outside Mission Control. Research and ideation now block when the DB copy drifts from canonical repo truth.

### Template for post-landing update

```markdown
## 2026-04-11 Post-Landing Review

### Landed Artifacts (just verified on main)
- ✅ Artifact #1: ... (commit abc1234)
- ✅ Artifact #2: ... (commit def5678)
- ✅ Artifact #3: ... (commit ghi9012)

### Remaining Gaps (for next cycle)
- TBD: Run fresh research to identify

### Quality Gate Passed
- [x] All committed code reviewed
- [x] All deliverables present and accurate
- [x] No stale branches or PRs
```

### Save and commit

```bash
# In mission-control
git add -A && git commit -m "product: post-landing update for Product X after cycle completion"
git push origin <feature-branch>
# Create/merge PR to main
```

---

## Step 3: Run Fresh Research Cycle (5 min)

Now that the product is in a validated state, ask the research agent: "What new gaps have appeared?"

Before triggering research, confirm the Program tab shows no Product Program drift. If drift is present, use `Audit & Sync Program` first. Every new cycle now stores the exact Product Program SHA and snapshot it ran against.

### Command

```bash
curl -X POST -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/products/<productId>/research/run"
```

### What to expect

- Research takes 2-5 minutes
- Produces a JSON report with sections: `missing_artifacts`, `factual_gaps`, `contradictions`, `domain_lock_violations`
- Report is stored in `research_cycles` table
- Activity feed logs each phase (init → llm_submitted → llm_polling → ideas_parsed → completed)

### Monitor

```bash
# Watch the activity feed on the product autopilot page
# Or poll the DB:
sqlite3 mission-control.db "
  SELECT datetime(last_heartbeat), current_phase, status
  FROM research_cycles
  WHERE product_id = '<productId>'
  ORDER BY started_at DESC LIMIT 1;
"
```

---

## Step 4: Generate Ideas (3 min)

Once research completes, ideation produces actionable task ideas from the gaps.

### Automatic

If your product has a scheduled ideation cycle (cron), it will fire automatically after research completes and `chainIdeation=true`.

### Manual

```bash
curl -X POST -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/products/<productId>/ideation/run"
```

### Expected output

- 5-15 ideas, all in `pending` status
- Each idea has: title, description, category, artifact path, blocker_cleared, why_now, impact_score, feasibility_score, complexity, technical_approach, risks, tags
- Tier filter applied (only tier-2 and tier-3 kept)
- Similarity dedup clears >90% matches to rejected ideas

---

## Step 5: Review Swipe Deck (10-20 min)

Open the swipe deck and review pending ideas in priority order.

### URL

```
http://localhost:4000/autopilot/<productId>?tab=swipe
```

### For each idea

| Action | Use When | Effect |
|--------|----------|--------|
| **Approve** | Solid fit, well-researched, clear path | → task status = `planning` (or `assigned` if auto_build) |
| **Maybe** | Interesting but timing unclear | → task deferred 7 days, resurface in maybe pool |
| **Reject** | Out of scope, contradicts NOT NOW, low priority | → trains similarity dedup for future ideas |
| **Fire** (urgent) | Blocker, high-impact fix, needed ASAP | → task status = `inbox`, skips planning |

### Scoring guidance

- **Complexity S/M = 4-16 hours = Approve if score >6**
- **Complexity L/XL = 16-40+ hours = Approve if score >7, reject otherwise**
- **Any contradiction with NOT NOW list = Reject regardless of score**
- **Vague artifact path or blocker_cleared = Reject (spec is incomplete)**

### Undo window

- You have 10 seconds to undo a swipe after each action
- Swipes are logged for preference model learning

---

## Step 6: Monitor Card Dispatch (5 min)

Once cards are approved, they enter the build workflow.

### Expected flow per card

1. Approved → status = `planning` (or `assigned` if build_mode=auto_build)
2. If planning: Planning Agent creates spec → operator approves → builder dispatched
3. If auto_build: builder dispatched immediately
4. Builder creates branch, commits, opens PR
5. Tester validates
6. Reviewer approves
7. PR merged to main
8. Task marked done

### Monitor

```bash
# Check board state
curl -s -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/missions/BoreReady/board" | jq '.lanes'

# Or visit http://localhost:4000/workspace/boreready
```

---

## Step 7: Document Lessons (15 min)

Before closing this cycle, capture what you learned.

### Template: `memory/YYYY-MM-DD-cycle-notes.md`

```markdown
# BoreReady Cycle Completion — YYYY-MM-DD

## Cycle Stats
- Ideas approved: N
- Ideas rejected: M
- Cards dispatched: K
- Cards to done: K (100% if lucky)
- Days elapsed: D
- Cost: $X

## What worked
- [ ] Describe 1-2 processes that went smoothly

## What didn't
- [ ] Describe 1-2 blockers or surprises
- [ ] Describe any infrastructure gaps

## Next cycle focus
- [ ] Key improvement or next priority

## Data for preference model
- Ideas with complexity=L that passed: which attributes?
- Ideas rejected: common reason pattern?
```

### Store in session memory

This becomes part of the product's playbook — what worked for this team in this domain.

---

## Operational Notes

### Budget policy

Research and ideation are gated by budget.

```bash
# Check budget status
curl -s -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/products/<productId>/costs/status" | jq '.remaining'
```

### Scheduling

Set cron schedules for recurring cycles:

```bash
# Schedule research every Monday at 9am MT
curl -X POST -H "Authorization: Bearer $MC_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule_type": "research",
    "cron_expression": "0 9 * * 1",
    "timezone": "America/Denver",
    "enabled": true
  }' \
  "http://localhost:4000/api/products/<productId>/schedules"
```

### Stale cycle recovery

If research or ideation hangs:

```bash
# Kill the stale cycle and retry
sqlite3 mission-control.db "
  UPDATE research_cycles
  SET status = 'failed', error_message = 'Manual abort'
  WHERE product_id = '<productId>' AND status = 'running'
  LIMIT 1;
"

# Then retry
curl -X POST -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/products/<productId>/research/run"
```

---

## Checklist (Use every cycle)

- [ ] Copy this template to memory/
- [ ] Verify landing (branches clean, commits good, program updated)
- [ ] Run fresh research
- [ ] Wait for research completion
- [ ] Generate ideas
- [ ] Swipe deck (approve/reject)
- [ ] Monitor board (dispatch → done)
- [ ] Document cycle notes
- [ ] Archive any closed issues or closed-out features

**Time estimate:** 30-60 min for the full cycle, then automation takes over.
