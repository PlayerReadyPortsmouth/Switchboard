# Web Dashboard — Responsive Mobile Layout

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**One-liner:** Make the web dashboard usable on a phone — the Agents table becomes stacked cards below a 900px breakpoint, global overflow safety-nets stop any single wide element from dragging the whole page into horizontal scroll again, and a fixed-width input introduced by the just-shipped JSON tree editor gets fixed to shrink instead of overflow.

This is a frontend-only change to `hub/web.ts`'s `DASHBOARD_HTML` template (CSS + one small HTML-template tweak). No backend routes change.

---

## 0. Why this, why now

A user reported the dashboard as "quite a mess" on their phone (screenshot: the Agents table's columns clipped at the screen edge, the Recent Activity feed's lines also appeared cut off). The JSON tree editor project (shipped earlier today) fixed the single worst offender inside that mess — the raw-JSON textarea's wall of escaped text — but the dashboard still has zero responsive layout: it's a fixed desktop design being squeezed onto a narrow screen.

## 1. Root cause

HTML tables refuse to shrink below their natural content width. The Agents table has 8 columns (status dot, name, state, a 120px context bar, queue, cost, replicas, two buttons) — on a ~375-412px phone viewport, that table is wider than the screen, so it forces the *entire page* into horizontal scroll, not just itself. That's the likely reason the Recent Activity feed's lines also looked clipped in the screenshot even though nothing in its own CSS prevents text wrapping — once one element blows out the viewport's effective width, everything else appears to shrink/clip relative to it. Fixing the table's width behavior is expected to resolve most of the reported mess by itself; the other changes in this spec are supporting fixes and defense-in-depth, not independent fixes for independently-broken elements.

## 2. Agents table → stacked cards below 900px

A standard CSS-only "responsive table" technique — no restructuring of the row-building JS, just two additions:

**HTML template change** (`render()`'s Agents-table row string in `hub/web.ts`): each `<td>` gets a `data-label="..."` attribute naming its column (`data-label="Agent"`, `data-label="State"`, `data-label="Context"`, `data-label="Queue"`, `data-label="Cost"`, `data-label="Replicas"`; the status-dot and Edit/Remove-buttons columns get an empty `data-label=""` since they're self-explanatory without a label). This is a small, mechanical addition to the existing string-concatenation template — the row-building logic itself doesn't change.

**CSS** (new `@media (max-width: 900px)` block in the existing `<style>` tag):
```css
table, thead, tbody, tr, td { display: block; }
thead { display: none; }
tbody tr { border: 1px solid #232733; border-radius: 6px; margin-bottom: 8px; padding: 8px 10px; }
td { border: none; padding: 4px 0; text-align: right; }
td[data-label]:not([data-label=""])::before { content: attr(data-label); float: left; color: #8b93a7; font-weight: 600; }
```
Above 900px, nothing changes — the table renders exactly as it does today.

## 3. Global overflow safety-nets

Regardless of what causes it, no single element should be able to force the whole page into horizontal scroll again. Add to the base (non-media-query) `<style>` rules:
```css
body { overflow-x: hidden; }
main { max-width: 100%; box-sizing: border-box; }
```
(`main` already has `max-width:1000px` for the desktop-width cap; adding `box-sizing:border-box` and a `max-width:100%` floor is what actually prevents overflow on a viewport narrower than 1000px — `max-width:1000px` alone only caps the *upper* bound, it doesn't stop a child forcing the container wider than the *viewport*.)

## 4. Tree editor short-string input width fix

The JSON tree editor shipped earlier today (`jsonTreeRenderValue`'s short-string branch, `hub/web.ts`) sets `txtInput.style.width = '240px'` — a fixed pixel width. At deeper nesting levels (each level adds `margin-left:16px`), this fixed width plus indentation plus the delete button and label could itself force overflow on a narrow screen, the same failure mode as §1 but in code that didn't exist when this spec's root cause was first identified. Fix: `txtInput.style.maxWidth = '240px'; txtInput.style.width = '100%';` — same 240px cap on wide screens, shrinks to fit on narrow ones.

## 5. Non-goals

- No changes to the channel-chat pane, approvals list, or ledger summary — these are already single-column/flowing content, not fixed-width tables, and aren't implicated in the reported mess once §3's safety-net is in place.
- No changes to the header bar (`<header>`) — it already has `flex-wrap: wrap` and degrades reasonably; not touched unless the plan's manual verification pass finds a real problem.
- No reduction of the JSON tree editor's per-level indentation (`margin-left:16px`) — deferred; the width fix in §4 is expected to be sufficient, and reducing indentation is a cosmetic nice-to-have, not a fix for a concrete reported problem.
- No JS restructuring of how the Agents table is built — the row-template string keeps its current shape, just gains `data-label` attributes.

## 6. Testing

- New string-marker tests confirming the `data-label` attributes are present in the Agents-table row template, and the `@media (max-width: 900px)` rule and its `display: block`/`::before` declarations exist in `DASHBOARD_HTML`.
- The existing JS-parse-safety test (`DASHBOARD_HTML`'s `<script>` block parses via `new Function(...)`) continues to run — this change touches HTML/CSS primarily and one JS line (§4), so the risk here is much lower than the tree editor's, but the check is free and this file has burned this codebase before.
- No automated test can verify actual visual layout (no CSS rendering test harness in this repo, consistent with every other UI change this session). Verified instead by a manual pass: load the dashboard in a browser, resize to under 900px (or use real device / browser devtools responsive mode) and confirm the Agents table renders as cards with visible column labels, no horizontal page scroll appears anywhere on the page at a ~375px width, and the JSON tree editor's text inputs no longer overflow their row at a few levels of nesting.

## 7. Build order

1. `hub/web.ts`: add `data-label` attributes to the Agents-table row template, add the responsive CSS (§2), add the overflow safety-net CSS (§3), fix the tree editor's fixed-width input (§4) — plus the corresponding string-marker tests.
2. Deploy + manual verification (real device or browser responsive mode, per §6).
