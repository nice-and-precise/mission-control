# Product Program Template

Use this template when creating or updating a product program. A strong product program drives quality research, ideation, and task generation.

---

## Current Objective

**1-2 sentences. What is the highest-priority outcome this product is aiming for?**

*Example:*
> Achieve DLI approval for the SQUTI provider compliance packet by verifying all finish-line artifacts are accurate, complete, and internally consistent.

---

## Finish-Line Artifact Checklist

**List each deliverable that represents "done."** Each artifact MUST have:
- An exact file path (repo-relative)
- A status indicator (✅ for done, ❌ for missing)
- A brief description of what validates it

This list directly informs research and ideation.

### Format

```
# Artifact #N: [Name]
- File: `[repo-relative-path]`
- Status: ✅ (or ❌)
- Validates: [What makes this artifact correct?]
  - Line/section check: e.g., "All 8 MODULE files exist and have ≥500 words"
  - Cross-reference check: e.g., "All internal links resolve to existing files"
  - Compliance check: e.g., "No Frappe/platform references, DLI contact is canonical"
  - Content check: e.g., "All statute citations use Subd. (capitalized)"
```

### Example (BoreReady)

```markdown
# Artifact #1: Curriculum — 8 Modules + Exam Packet

- File: `docs/curriculum/MODULE_{01-08}.md`, `EXAM_BLUEPRINT.md`, `EXAM_SAMPLE.md`
- Status: ✅
- Validates:
  - All MODULE files present and contain valid learning objectives
  - Cross-references: MODULE files reference each other correctly
  - Compliance: No platform references (Frappe, doctype, etc.)
  - Content: All statute citations in canonical format (`Minn. Stat. § 326B.198, Subd. X`)

# Artifact #2: Provider Packet — Index + Runbook + Refresher

- File: `docs/provider/INDEX.md`, `PROVIDER_OPERATIONS_RUNBOOK.md`, `REFRESHER_COURSE_OUTLINE.md`
- Status: ✅
- Validates:
  - All 3 files exist and contain tables/checklists
  - Cross-references: Links between INDEX, Runbook, Refresher all resolve
  - DLI contact: Canonical contact (Don Sivigny, 651-284-5874) is consistent
  - Completeness: Index checklist items map to actual runbook content

# Artifact #3: Compliance Traceability

- File: `docs/compliance/statute-traceability-index.md`
- Status: ✅
- Validates:
  - All 8 statutory subdivisions covered and marked Complete or Draft
  - Status markers accurate: Complete only for subdivisions with merged PRs
  - Every statutory reference has inline body citations in curriculum/specs
```

(Repeat for all artifacts until "done")

---

## Not Now (Explicit Exclusion List)

**Topics you explicitly decided NOT to tackle in this cycle.** Include reasons so the research agent doesn't waste effort.

### Platform/Technical Terms (Do Not Reference)

- ❌ Frappe, doctype, ERPNext, frappe-lms — *internal platform only, off-limits*
- ❌ Django, SQLite, REST API implementation details — *not part of UTS provider packet*

### Scope Boundaries (Out of Scope)

- ❌ Phase 2 features (e.g., multi-region provider approval, automated recertification)
- ❌ Marketing/promotional content — *DLI submission packet, not brochure*
- ❌ API integrations (e.g., with state enterprise systems) — *next cycle priority*

### Wrong-Domain Content (Do Not Include)

- ❌ Arc flash, NFPA 70E standards — *outside UTS scope (wrong domain)*
- ❌ Lockout/tagout, conduit bending — *wrong domain (general electrical trade)*
- ❌ Ohm's Law, GFCI/AFCI detailed design — *advanced content, not required for UTS*

### Already Decided / Won't Reopen

- ❌ Statute subdivision 3(c) coverage — *determined out of scope in prior cycle, do not reopen*
- ❌ Glossary as standalone artifact — *decided to inline definitions in MODULE_01*

---

## Success Criteria

**How will you know when this product is "done"?** Define objective, measurable gates.

### Quality Gates

- [ ] All finish-line artifacts exist on `main` branch
- [ ] Zero domain-lock violations (grep for prohibited terms returns 0 matches)
- [ ] Zero stale references (all internal cross-links resolve)
- [ ] Zero compliance contradictions (no conflicts between MODULE files and provider packet)
- [ ] DLI contact info is canonical and consistent across all artifacts (verified via grep + audit log)
- [ ] All statute citations use consistent format and capitalization

### Operational Gates

- [ ] All PRs merged to `main` (no open PRs for this cycle)
- [ ] All branches cleaned up (no stale autopilot/* branches on remote)
- [ ] Build passes with zero errors
- [ ] All task cards progressed to status `done` (board is empty)

### Approval Gate (if applicable)

- [ ] DLI reviewer has confirmed receipt of submission packet
- [ ] First round of feedback incorporated (if any)

---

## Learned Preferences (Optional)

**What have we learned about what ideas work / don't work?** This section grows over cycles.

### Pattern: Ideas That Passed

- Complexity S/M + impact_score ≥6 + artifact_path specified → 85% approval rate
- Tier-2 ideas (incremental fixes) with clear blocker_cleared → always approved

### Pattern: Ideas That Failed

- Complexity XL + impact_score <7 → rejected 100%
- Ideas without artifact_path specified → auto-rejected by validation
- Tier-1 or tier-4 tags → rejected by tier filter
- Ideas touching "Not Now" topics → rejected on research backing review

### Research Tips

- Research cycle focusing on statute mismatches → generates highest-impact ideas
- Research cycle focusing on cross-reference gaps → generates highest-feasibility ideas
- Ideas from contradictions are usually lower priority (fix-the-fix pattern)

---

## Template Checklist (Use Every Cycle)

Before marking a product program "ready," verify:

- [ ] Current Objective is 1-2 sentences (not a paragraph)
- [ ] All finish-line artifacts have file paths (no vague "artifact TBD")
- [ ] All validation criteria are checkable (testable, not subjective)
- [ ] Not Now list includes platform terms (Frappe, etc.) and scope boundaries
- [ ] Success criteria have objective gates (not "looks good")
- [ ] At least one success criterion can be verified via grep / grep -v (for automation)

---

## How This Drives the Cycle

```
Product Program
        ↓ (input to)
Research Cycle — audits product against checklist
        ↓
Research Report (JSON with gaps/contradictions/missing items)
        ↓ (input to)
Ideation Cycle — LLM generates ideas targeting items on checklist
        ↓
Ideas (5-15 with artifact_path, blocker_cleared, technical_approach, etc.)
        ↓ (operator reviews in)
Swipe Deck
        ↓ (approved ideas become)
Tasks
        ↓ (dispatched to)
Builders
        ↓
Done ✓
```

**Weak product program → weak research → weak ideas → wasted builder time**

**Strong product program → focused research → high-quality ideas → fast cycle delivery**

---

## Example: BoreReady Program (Actual)

[See BoreReady's product_program in Mission Control DB for full example]

Key features:
- Organized by artifact type (curriculum, provider packet, compliance)
- Each artifact has 3-4 validation points (cross-reference, compliance, content)
- Not Now list explicitly calls out platform terms and wrong-domain content
- Success criteria include both quality (zero domain-lock violations) and operational (all PRs merged)
