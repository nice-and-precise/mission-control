#!/bin/bash
# Complete Next-Cycle Execution Script
# Runs after research completes to move ideas through to board dispatch
# 2026-04-11 cycle automation

set -e

DB="./mission-control.db"
PRODUCT_ID="a39b5366-952d-40b0-ad1f-5e1f77597dd7"
API_TOKEN="e254e30245f53e5db898cf2cce9d6840b539aa3683f10e238a154db9afdfe4f5"
MC_URL="http://localhost:4000"

echo "=== NEXT-CYCLE POST-RESEARCH AUTOMATION ==="
echo "Product: BoreReady ($PRODUCT_ID)"
echo ""

# Step 1: Verify research completed
echo "Step 1: Checking research completion..."
RESEARCH_STATUS=$(sqlite3 $DB "SELECT status, ideas_generated FROM research_cycles WHERE product_id='$PRODUCT_ID' ORDER BY started_at DESC LIMIT 1;")
echo "  Latest research: $RESEARCH_STATUS"

if [[ $RESEARCH_STATUS != "completed"* ]]; then
  echo "  ⏳ Research still running or failed. Waiting..."
  exit 1
fi

IDEAS_COUNT=$(echo $RESEARCH_STATUS | cut -d'|' -f2)
echo "  ✓ Research completed with $IDEAS_COUNT ideas"
echo ""

# Step 2: Check ideation (should auto-run if chainIdeation=true)
echo "Step 2: Checking ideation status..."
IDEATION_STATUS=$(sqlite3 $DB "SELECT id, status, ideas_generated FROM ideation_cycles WHERE product_id='$PRODUCT_ID' ORDER BY started_at DESC LIMIT 1;")
IDEATION_ID=$(echo $IDEATION_STATUS | cut -d'|' -f1)
IDEATION_STATE=$(echo $IDEATION_STATUS | cut -d'|' -f2)
IDEATION_IDEAS=$(echo $IDEATION_STATUS | cut -d'|' -f3)

if [[ "$IDEATION_STATE" == "completed" ]]; then
  echo "  ✓ Ideation completed with $IDEATION_IDEAS ideas"
elif [[ "$IDEATION_STATE" == "running" ]]; then
  echo "  ⏳ Ideation still running..."
  exit 1
else
  echo "  ℹ Ideation state: $IDEATION_STATE"
fi
echo ""

# Step 3: Get pending ideas from swipe deck
echo "Step 3: Fetching pending ideas from swipe deck..."
PENDING_IDEAS=$(sqlite3 $DB "SELECT COUNT(*) FROM ideas WHERE product_id='$PRODUCT_ID' AND status='pending';")
echo "  Pending ideas: $PENDING_IDEAS"

if [ "$PENDING_IDEAS" -eq 0 ]; then
  echo "  ⚠ No pending ideas to review"
  exit 1
fi

# Step 4: Get top ideas by score
echo ""
echo "Step 4: Top ideas (sorted by impact_score):"
sqlite3 $DB ".mode column" ".headers on" "
  SELECT 
    SUBSTR(id, 1, 8) as id,
    SUBSTR(title, 1, 40) as title,
    impact_score,
    feasibility_score,
    complexity
  FROM ideas 
  WHERE product_id='$PRODUCT_ID' AND status='pending'
  ORDER BY impact_score DESC
  LIMIT 10;
"
echo ""

# Step 5: Calculate approval recommendations
echo "Step 5: Approval recommendations (by complexity heuristic):"
APPROVE=$(sqlite3 $DB "
  SELECT COUNT(*) FROM ideas 
  WHERE product_id='$PRODUCT_ID' 
  AND status='pending'
  AND ((complexity IN ('S', 'M') AND impact_score > 6) 
       OR (complexity IN ('L', 'XL') AND impact_score > 7 AND feasibility_score > 4));
")
REJECT=$(sqlite3 $DB "
  SELECT COUNT(*) FROM ideas 
  WHERE product_id='$PRODUCT_ID' 
  AND status='pending'
  AND (artifact_path IS NULL 
       OR blocker_cleared IS NULL 
       OR (complexity IN ('L', 'XL') AND feasibility_score < 4));
")
MAYBE=$((PENDING_IDEAS - APPROVE - REJECT))

echo "  🟢 APPROVE (go): ~$APPROVE ideas"
echo "  🟡 MAYBE (defer): ~$MAYBE ideas"
echo "  🔴 REJECT (skip): ~$REJECT ideas"
echo ""

# Step 6: Show next action
echo "Step 6: Next action:"
echo "  1. Review swipe deck: $MC_URL/autopilot/$PRODUCT_ID?tab=swipe"
echo "  2. For each idea:"
echo "     - 🟢 if complexity S/M + impact>6: APPROVE"
echo "     - 🟢 if complexity L/XL + impact>7 + feasibility>4: APPROVE"
echo "     - 🔴 if missing artifact_path or blocker_cleared: REJECT"
echo "     - 🟡 else: MAYBE (7-day defer)"
echo "  3. Approved ideas will auto-create tasks on your board"
echo "  4. Tasks dispatch to builders automatically"
echo ""
echo "=== READY FOR SWIPE DECK REVIEW ==="
