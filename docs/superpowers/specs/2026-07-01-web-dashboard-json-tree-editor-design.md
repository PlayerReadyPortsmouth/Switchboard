# Web Dashboard — JSON Tree/Outline Editor

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**One-liner:** Replace the raw JSON textarea used to edit agent configs and hub config with a collapsible tree/outline editor — expand/collapse nested objects, edit individual fields inline, with long multi-line string fields (like an agent's `appendSystemPrompt`) collapsed by default behind an "Edit" toggle instead of dumping a wall of escaped-newline text on screen.

This is a frontend-only change (`hub/web.ts`'s `DASHBOARD_HTML` template). It replaces zero backend surface — `GET /api/agents`, `GET /api/hub-config`, and the `preview`/`confirm` routes built in the prior two phases are untouched; this only changes how the browser builds the JSON it sends to `preview`.

---

## 0. Why this, why now

Editing an agent or the hub config currently means pretty-printing the whole `AgentConfig`/`HubConfig` object into one `<textarea>` and hand-editing raw JSON. For most fields this is fine, but any agent with a long `runtime.appendSystemPrompt` (several hundred to several thousand characters, itself containing escaped `\n` sequences for the model's benefit) turns the textarea into a wall of near-unreadable text — visible in the reported screenshot, where the whole page becomes unusable on a phone screen. A tree editor fixes this by collapsing exactly the fields that cause the problem, while leaving short/simple fields as quick inline edits.

## 1. Scope

- Replaces `<textarea id="agentEditorText">` and `<textarea id="hubConfigEditorText">` with a collapsible tree container each (`<div id="agentEditorTree">` / `<div id="hubConfigEditorTree">`).
- One shared set of tree-rendering functions, used by both editors — the tree logic is generic over any JSON value, so there's no reason to duplicate it the way the surrounding panel logic was duplicated in the prior two phases (there, the *panels* differed structurally — create/remove vs. singleton; here, the *tree renderer* doesn't care which config shape it's rendering).
- Editing an existing agent/hub config, and creating a new agent via "+ New Agent", both go through the tree editor. Removing an agent is unaffected (still a `{config: null}` preview + diff, no tree involved).
- Out of scope: reordering array items or object keys; a raw-JSON fallback/paste mode (can be added later if it turns out to be missed — not requested); schema-driven field suggestions or autocomplete; validating field values beyond what the existing backend `previewAgentChange`/`previewHubConfigChange` already do (the tree editor can only ever produce syntactically valid JSON, but a semantically wrong value, e.g. a typo'd model name, is still caught server-side exactly as today).

## 2. Data model

When an editor opens (Edit, +New Agent, or Edit hub config), the fetched or templated config becomes a live in-memory JS object — not a JSON string. Every input in the tree is bound directly to a location in that object via closures over `(parentObject, key)`; typing in a field, or a structural add/delete, mutates the object in place. There is no intermediate JSON-string representation until the moment "Preview" is clicked, when the current object is sent as the `config` field of the existing `preview` POST body — exactly as today, just sourced from a live object instead of `JSON.parse(textarea.value)`.

One consequence worth calling out: **the "invalid JSON" error path is eliminated**. Today, hand-typing malformed JSON into the textarea shows an inline parse error. A tree editor can only ever construct valid JSON by construction (every leaf is a typed input; every structural edit is an explicit add/delete action) — that whole failure mode goes away.

## 3. Rendering

Recursive, driven by the JS `typeof`/shape of each value:

- **Object or array** → an expandable block: a ▼/▶ toggle controlling a header row, one child row per key (object) or index (array) — each child row recursively renders its own value, plus a "×" delete button for that key/item — and a trailing "+ field" (object) / "+ item" (array) row. "+ field" prompts for a key name (via `prompt()`, the same mechanism already used by "+ New Agent" for naming); both "+ field" and "+ item" add a new empty-string value, immediately visible and editable as a short-string input per §3's string case. Nesting increases left-indentation per level so structure stays legible.
- **Short string or number** → a single inline `<input>`, bound on `change`/`input` to `parentObject[key] = <parsed value>` (numbers go through `Number(...)`).
- **Boolean** → a two-option `<select>` (true/false), bound the same way.
- **Long string** — defined as containing a newline OR exceeding ~100 characters (this is the specific fix for the `appendSystemPrompt` case) — renders **collapsed by default**: a truncated preview (first ~60 characters + an ellipsis) plus a character count and an "Edit" button. Clicking "Edit" swaps in a multi-row `<textarea>` containing the REAL string with actual line breaks (not the escaped `\n` sequences JSON.stringify would show) for comfortable editing, plus a "Collapse" button to hide it again once done (re-showing the truncated preview, updated to reflect any edit).
- **null** → a small muted "(null)" indicator with a button to replace it with an empty string, after which it behaves as a normal short-string field. Rare in practice across `AgentConfig`/`HubConfig`; kept minimal deliberately.

## 4. Integration with the existing editor panels

- `openAgentEditor(name, data, isNew)` and the hub-config equivalent now take the parsed config **object** (not a JSON string) and render the tree into the container instead of setting `.value` on a textarea. Both must unconditionally reset the tree container's visibility to shown on every open — the per-agent editor already had one fix round earlier this session for exactly this class of bug (a separate Remove flow leaving the edit surface hidden for the next Edit/New open); this design calls it out explicitly so the same mistake isn't repeated.
- The Edit-button handler (fetching an existing agent/hub config) passes the fetched object straight into the tree renderer — no more `JSON.stringify(..., null, 2)` step, since there's no textarea to populate.
- "+ New Agent" passes the same starter-template object it already constructs, just as an object literal instead of stringifying it first.
- The Preview button's handler drops its `try { JSON.parse(...) } catch` block entirely (per §2, that failure mode no longer exists) and sends the live tree-data object directly.
- The diff view (the BEFORE/AFTER/CLASSIFICATION text block shown after Preview) is unchanged — it's a read-only summary rendered from the preview response, not part of the editing surface itself.
- Remove-agent's flow (`{config: null}` preview) is unaffected; it still hides the tree container the same way it previously hid the textarea.

## 5. Known tradeoff

This dashboard has no build step — a deliberate, standing constraint (self-contained single-file page, no bundler, no external assets, trivial deploy: `git pull` + `pm2 restart`). That means the tree editor's actual interactive behavior (expand/collapse, add/delete, type coercion, the long-string collapse threshold) cannot get real unit-test coverage the way this session's backend work has throughout — bun:test can't drive real DOM interaction here. This isn't a new gap this feature introduces; every existing piece of interactive dashboard JS (the agent/hub-config panels themselves, channel chat, approvals) already has the same limitation, verified only via `DASHBOARD_HTML.toContain(...)` string-marker tests plus the JS-parse-safety test added after this session's earlier incident. This feature follows the same, already-established pattern rather than introducing a new one — mitigated by a thorough manual verification pass as the plan's final task.

## 6. Testing

- The existing JS-parse-safety test (`DASHBOARD_HTML`'s `<script>` block parses via `new Function(...)`) continues to guard against a repeat of the earlier newline-escaping incident — critical given this feature adds a meaningful amount of new inline JS.
- New string-marker tests confirming the new DOM structure exists (`id="agentEditorTree"`, `id="hubConfigEditorTree"`, absence of the old `id="agentEditorText"`/`id="hubConfigEditorText"` textareas, presence of the shared tree-render function name).
- No behavioral/unit tests for the tree logic itself (per §5) — covered instead by a manual verification checklist as the plan's final task: expand/collapse a nested object; edit a short string, a number, and a boolean field; add a new field to an object and a new item to an array; delete a field; expand and edit a long string field (specifically the triage agent's real `appendSystemPrompt`, since that's the motivating case); Preview + confirm end-to-end for both a safe-tier and a restart-tier change; confirm "+ New Agent" still produces a valid preview.

## 7. Non-goals

- No raw-JSON fallback/paste mode.
- No reordering of object keys or array items.
- No schema-driven autocomplete or per-field validation beyond what the backend already enforces.
- No change to the backend preview/confirm/classify/audit machinery built in the prior two phases — this is purely how the browser constructs the object it was already sending.
