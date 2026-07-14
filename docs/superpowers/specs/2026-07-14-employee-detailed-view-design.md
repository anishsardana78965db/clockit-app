# Employee Detailed Attendance View

**Date:** 2026-07-14 · **Status:** Approved (mock reviewed by owner)

## Goal

Employees see the same attendance detail the admin sees in the per-employee
"View" panel — without any per-day salary math.

## What changes on the employee dashboard

1. **Calendar gets full shift-quality coloring** (previously flat green/red):
   - Green — full shift (≥8h, in by 10:00, out after 18:00)
   - Yellow — partial / late start / early leave (4–8h)
   - Red — short shift (<4h) or absent
   - Purple — declared holiday (paid)
   - Dashed — Sunday
   - The 5-item legend from the admin view replaces the 4-item employee legend.
   - Day tooltips keep in/out times and duration (same as admin).

2. **Salary card: collapsible chevron → eye toggle.**
   - Label: "Salary payable so far"; value shows `₹ •••••` by default.
   - Tapping the eye (👁) reveals the amount; tapping again (🙈) hides it.
   - Resets to hidden on every dashboard load, so the figure is never
     visible to a passerby on the shared device.
   - Sub-line: "Based on N paid days this month".

3. **Never shown to employees:** per-day rate (₹/day), "÷ 30 days",
   monthly CTC, and the formula line. Those remain admin-only.

## Non-goals / unchanged

Check-in/out buttons, today card, Present/Absent/Working stats, month
navigation, Change PIN, and the admin panel itself are untouched.

## Implementation notes

- `renderCalendarInto()` loses its `adminMode` parameter — both callers now
  render the detailed view, and the plain employee branch is deleted.
- `toggleSalaryCard()` (collapse) is replaced by `toggleSalaryVisibility()`
  (mask/unmask); the `.salary-collapsible-head` CSS becomes unused and is removed.
- Mock artifact: https://claude.ai/code/artifact/fd00c3fd-b276-46cd-9480-e6aad230aac5
