# Web Dashboard JSON Tree/Outline Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-JSON `<textarea>` used to edit agent configs and the hub config with a collapsible tree/outline editor — expand/collapse nested objects, edit fields inline, and collapse long multi-line strings (like an agent's `appendSystemPrompt`) behind an "Edit" toggle instead of dumping a wall of text on screen.

**Architecture:** A generic, recursive vanilla-JS tree renderer (`jsonTree*` function family) that operates directly on a live in-memory JS object — edits mutate that object in place via closures, eliminating the JSON.parse/stringify round-trip and the "invalid JSON" error path entirely. One renderer, reused by both the agent editor and the hub-config editor.

**Tech Stack:** Bun + TypeScript (hub), `bun:test`, vanilla-JS dashboard (no build step) — this is a frontend-only change to `hub/web.ts`'s `DASHBOARD_HTML` template; no backend routes change.

## Global Constraints

- `hub/web.ts`'s `<script>` block uses plain `function(){}`/`var`/string concatenation — no arrow functions, no template literals, matching the file's existing style exactly.
- `DASHBOARD_HTML` is itself a backtick template literal. Any literal `\n`/`\t`/backslash meant to survive into the browser's JS as a real escape sequence must be double-escaped in the TS source (`\\n`, etc.) — this session already shipped one live bug from getting this wrong (see the `<!-- fixed in PR #33 -->` incident); the new code in this plan does not introduce any string containing `\n`/`\t` escapes, so this note is a reminder for reviewers, not a step this plan needs to take action on.
- No CSS classes on buttons — bare `<button type="button">`, styled only by element-selector CSS; existing convention.
- New DOM manipulation must use `textContent`/`createElement`/property assignment for any dynamic/untrusted string content (agent config values, field names) — never `innerHTML` string-concatenation for those. This is stricter than some existing code in this file (which uses an `esc()`+`innerHTML` pattern for agent names elsewhere), and is achievable here without extra ceremony since the tree renderer builds real DOM nodes throughout.
- No behavioral/unit tests are possible for the tree renderer's actual interactive behavior (no build step, no DOM test harness in this repo) — covered by string-marker tests (function/id presence), the existing JS-parse-safety test, and a manual verification checklist as this plan's final task. This mirrors every other piece of interactive JS already in this file.
- Known, accepted limitation: deleting or adding a field/item causes the browser to rebuild all sibling rows via `jsonTreeRenderChildren`, which resets any collapsed nested object/array back to its default (expanded) state. Config objects here are modest-sized and add/delete is infrequent relative to simple value edits, so this is an accepted trade-off, not a bug to fix in this plan.
- Commit after each task.

---

### Task 1: Core tree renderer + wire into the agent editor

**Files:**
- Modify: `hub/web.ts`
- Modify: `hub/web.test.ts`

**Interfaces:**
- Produces (new global functions inside `DASHBOARD_HTML`'s `<script>` block — not TypeScript exports, browser-global functions):
  - `jsonTreeIsLongString(s: string): boolean`
  - `jsonTreeRenderChildren(container: Element, obj: object|array, isArray: boolean): void`
  - `jsonTreeRenderValue(slot: Element, parentObj: object|array, key: string|number): void`
  - `jsonTreeRenderContainer(slot: Element, parentObj: object|array, key: string|number, isArray: boolean): void`
  - `jsonTreeRenderLongString(slot: Element, obj: object|array, key: string|number): void`
  - `jsonTreeRenderRoot(container: Element, data: object): void`
- Consumed by: Task 2 (hub-config editor wiring reuses all of the above unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `hub/web.test.ts`:

```ts
test("the dashboard has a tree-editor container for agents, not the old raw-JSON textarea", () => {
  expect(DASHBOARD_HTML).toContain('id="agentEditorTree"')
  expect(DASHBOARD_HTML).not.toContain('id="agentEditorText"')
})

test("the dashboard defines the shared jsonTree renderer functions", () => {
  expect(DASHBOARD_HTML).toContain("function jsonTreeIsLongString(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderChildren(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderValue(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderContainer(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderLongString(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderRoot(")
})

test("openAgentEditor no longer JSON.stringifies a template into a textarea", () => {
  expect(DASHBOARD_HTML).not.toContain("JSON.stringify(all[name], null, 2)")
  expect(DASHBOARD_HTML).toContain("openAgentEditor(name, all[name], false)")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test hub/web.test.ts`
Expected: FAIL — none of these markers/functions exist yet.

- [ ] **Step 3: Add the tree renderer functions**

In `hub/web.ts`, inside the `<script>` block, add these functions immediately before the existing `var editingAgentName = null;` line (currently line 291):

```js
function jsonTreeIsLongString(s){ return s.indexOf('\n') !== -1 || s.length > 100; }

function jsonTreeRenderChildren(container, obj, isArray){
  container.innerHTML = '';
  var keys = isArray ? obj.map(function(_, i){ return i; }) : Object.keys(obj);
  keys.forEach(function(key){
    var row = document.createElement('div');
    row.style.margin = '2px 0 2px 16px';
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function(){
      if (isArray) { obj.splice(key, 1); } else { delete obj[key]; }
      jsonTreeRenderChildren(container, obj, isArray);
    });
    var label = document.createElement('span');
    label.className = 'muted';
    label.textContent = (isArray ? '['+key+']' : key) + ': ';
    row.appendChild(delBtn);
    row.appendChild(label);
    var valueSlot = document.createElement('span');
    row.appendChild(valueSlot);
    jsonTreeRenderValue(valueSlot, obj, key);
    container.appendChild(row);
  });
  var addRow = document.createElement('div');
  addRow.style.margin = '2px 0 2px 16px';
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = isArray ? '+ item' : '+ field';
  addBtn.addEventListener('click', function(){
    if (isArray) {
      obj.push('');
    } else {
      var newKey = prompt('New field name:');
      if (!newKey) return;
      obj[newKey] = '';
    }
    jsonTreeRenderChildren(container, obj, isArray);
  });
  addRow.appendChild(addBtn);
  container.appendChild(addRow);
}

function jsonTreeRenderValue(slot, obj, key){
  slot.innerHTML = '';
  var value = obj[key];
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    jsonTreeRenderContainer(slot, obj, key, Array.isArray(value));
  } else if (value === null) {
    var nullBtn = document.createElement('button');
    nullBtn.type = 'button';
    nullBtn.textContent = '(null) set value';
    nullBtn.addEventListener('click', function(){ obj[key] = ''; jsonTreeRenderValue(slot, obj, key); });
    slot.appendChild(nullBtn);
  } else if (typeof value === 'boolean') {
    var sel = document.createElement('select');
    ['true', 'false'].forEach(function(opt){
      var o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if ((opt === 'true') === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function(){ obj[key] = sel.value === 'true'; });
    slot.appendChild(sel);
  } else if (typeof value === 'number') {
    var numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.value = value;
    numInput.addEventListener('change', function(){ obj[key] = Number(numInput.value); });
    slot.appendChild(numInput);
  } else {
    var str = String(value);
    if (jsonTreeIsLongString(str)) {
      jsonTreeRenderLongString(slot, obj, key);
    } else {
      var txtInput = document.createElement('input');
      txtInput.type = 'text';
      txtInput.value = str;
      txtInput.style.width = '240px';
      txtInput.addEventListener('change', function(){ obj[key] = txtInput.value; });
      slot.appendChild(txtInput);
    }
  }
}

function jsonTreeRenderLongString(slot, obj, key){
  slot.innerHTML = '';
  var str = String(obj[key]);
  var preview = document.createElement('span');
  preview.className = 'muted';
  preview.textContent = '"'+str.slice(0, 60)+(str.length > 60 ? '…' : '')+'" ('+str.length+' chars) ';
  var editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', function(){
    slot.innerHTML = '';
    var ta = document.createElement('textarea');
    ta.rows = 10;
    ta.style.width = '100%';
    ta.style.background = '#1a1d24';
    ta.style.border = '1px solid #232733';
    ta.style.color = '#e6e6e6';
    ta.style.padding = '8px';
    ta.style.fontFamily = 'ui-monospace,monospace';
    ta.style.fontSize = '12px';
    ta.value = str;
    ta.addEventListener('change', function(){ obj[key] = ta.value; });
    var collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.textContent = 'Collapse';
    collapseBtn.addEventListener('click', function(){ jsonTreeRenderLongString(slot, obj, key); });
    slot.appendChild(ta);
    slot.appendChild(document.createElement('br'));
    slot.appendChild(collapseBtn);
  });
  slot.appendChild(preview);
  slot.appendChild(editBtn);
}

function jsonTreeRenderContainer(slot, parentObj, key, isArray){
  slot.innerHTML = '';
  var obj = parentObj[key];
  var toggle = document.createElement('button');
  toggle.type = 'button';
  var childrenDiv = document.createElement('div');
  var expanded = true;
  toggle.textContent = '▼';
  toggle.addEventListener('click', function(){
    expanded = !expanded;
    toggle.textContent = expanded ? '▼' : '▶';
    childrenDiv.style.display = expanded ? 'block' : 'none';
  });
  slot.appendChild(toggle);
  slot.appendChild(document.createTextNode(isArray ? '[' : '{'));
  slot.appendChild(childrenDiv);
  jsonTreeRenderChildren(childrenDiv, obj, isArray);
  slot.appendChild(document.createTextNode(isArray ? ']' : '}'));
}

function jsonTreeRenderRoot(container, data){
  container.innerHTML = '';
  jsonTreeRenderChildren(container, data, false);
}

```

- [ ] **Step 4: Replace the agent editor's textarea with a tree container**

In `hub/web.ts`, find the `agentEditor` section's textarea (currently line 107):

```html
    <textarea id="agentEditorText" rows="16" style="width:100%;background:#1a1d24;border:1px solid #232733;color:#e6e6e6;padding:8px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
```

Replace it with:

```html
    <div id="agentEditorTree" style="font-family:ui-monospace,monospace;font-size:12px"></div>
```

- [ ] **Step 5: Rewrite `openAgentEditor` to render the tree instead of setting textarea value**

Find the current `openAgentEditor` function (lines 294-303):

```js
function openAgentEditor(name, template, isNew){
  editingAgentName = name;
  lastPreviewId = null;
  $('agentEditorTitle').textContent = isNew ? ('New agent: '+name) : ('Edit agent: '+name);
  $('agentEditorText').value = template;
  $('agentEditorText').style.display = 'block';
  $('agentDiff').textContent = '';
  $('agentConfirmRow').innerHTML = '';
  $('agentEditor').style.display = 'block';
}
```

Replace with:

```js
var agentTreeData = null;

function openAgentEditor(name, data, isNew){
  editingAgentName = name;
  lastPreviewId = null;
  agentTreeData = data;
  $('agentEditorTitle').textContent = isNew ? ('New agent: '+name) : ('Edit agent: '+name);
  $('agentEditorTree').style.display = 'block';
  jsonTreeRenderRoot($('agentEditorTree'), agentTreeData);
  $('agentDiff').textContent = '';
  $('agentConfirmRow').innerHTML = '';
  $('agentEditor').style.display = 'block';
}
```

(`openAgentEditor` now unconditionally resets `agentEditorTree`'s display to `'block'` on every open — the same fix an earlier phase needed for the textarea equivalent of this bug, applied here from the start rather than needing a follow-up round.)

- [ ] **Step 6: Update the "+ New Agent" handler to pass a plain object**

Find (lines 305-313):

```js
document.getElementById('newAgentBtn').addEventListener('click', function(){
  var name = prompt('New agent name:');
  if (!name) return;
  var template = JSON.stringify({
    emoji: "🤖", description: "", mode: "ephemeral",
    access: { roles: [] }, runtime: { cwd: "~" },
  }, null, 2);
  openAgentEditor(name, template, true);
});
```

Replace with:

```js
document.getElementById('newAgentBtn').addEventListener('click', function(){
  var name = prompt('New agent name:');
  if (!name) return;
  var template = {
    emoji: "🤖", description: "", mode: "ephemeral",
    access: { roles: [] }, runtime: { cwd: "~" },
  };
  openAgentEditor(name, template, true);
});
```

- [ ] **Step 7: Update the Edit-agent click handler to pass the fetched object directly**

Find (lines 315-322):

```js
document.addEventListener('click', function(ev){
  var editBtn = ev.target.closest('[data-edit-agent]');
  if (editBtn) {
    var name = editBtn.getAttribute('data-edit-agent');
    fetch('api/agents').then(function(r){ return r.json(); }).then(function(all){
      openAgentEditor(name, JSON.stringify(all[name], null, 2), false);
    });
    return;
  }
```

Replace the inner `.then` callback's body with:

```js
document.addEventListener('click', function(ev){
  var editBtn = ev.target.closest('[data-edit-agent]');
  if (editBtn) {
    var name = editBtn.getAttribute('data-edit-agent');
    fetch('api/agents').then(function(r){ return r.json(); }).then(function(all){
      openAgentEditor(name, all[name], false);
    });
    return;
  }
```

- [ ] **Step 8: Update the Remove-agent handler to hide the tree container instead of the textarea**

Find, inside the same click handler (lines 324-340):

```js
  var removeBtn = ev.target.closest('[data-remove-agent]');
  if (removeBtn) {
    var rname = removeBtn.getAttribute('data-remove-agent');
    editingAgentName = rname;
    lastPreviewId = null;
    $('agentEditorTitle').textContent = 'Remove agent: '+rname;
    $('agentEditorText').value = '';
    $('agentEditorText').style.display = 'none';
    $('agentDiff').textContent = '';
    $('agentConfirmRow').innerHTML = '';
    $('agentEditor').style.display = 'block';
    fetch('api/agents/'+rname+'/preview', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({config: null}),
    }).then(function(r){ return r.json(); }).then(renderAgentPreview);
    return;
  }
});
```

Replace with:

```js
  var removeBtn = ev.target.closest('[data-remove-agent]');
  if (removeBtn) {
    var rname = removeBtn.getAttribute('data-remove-agent');
    editingAgentName = rname;
    lastPreviewId = null;
    $('agentEditorTitle').textContent = 'Remove agent: '+rname;
    $('agentEditorTree').innerHTML = '';
    $('agentEditorTree').style.display = 'none';
    $('agentDiff').textContent = '';
    $('agentConfirmRow').innerHTML = '';
    $('agentEditor').style.display = 'block';
    fetch('api/agents/'+rname+'/preview', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({config: null}),
    }).then(function(r){ return r.json(); }).then(renderAgentPreview);
    return;
  }
});
```

- [ ] **Step 9: Simplify the Cancel handler**

Find (lines 343-346):

```js
document.getElementById('agentEditorCancel').addEventListener('click', function(){
  $('agentEditor').style.display = 'none';
  $('agentEditorText').style.display = 'block';
});
```

Replace with:

```js
document.getElementById('agentEditorCancel').addEventListener('click', function(){
  $('agentEditor').style.display = 'none';
});
```

(The old code restored the textarea's visibility on Cancel because the Remove flow could leave it hidden. `openAgentEditor` — Step 5 — now performs that reset unconditionally on every open instead, which is the correct chokepoint: it covers Edit, +New, AND the case where Cancel is skipped entirely and the operator clicks Edit/+New directly after a Remove.)

- [ ] **Step 10: Simplify the Preview button handler — no more JSON.parse/try-catch**

Find (lines 348-356):

```js
document.getElementById('agentPreviewBtn').addEventListener('click', function(){
  var parsed;
  try { parsed = JSON.parse($('agentEditorText').value); }
  catch (e) { $('agentDiff').textContent = 'invalid JSON: '+e.message; return; }
  fetch('api/agents/'+editingAgentName+'/preview', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({config: parsed}),
  }).then(function(r){ return r.json(); }).then(renderAgentPreview);
});
```

Replace with:

```js
document.getElementById('agentPreviewBtn').addEventListener('click', function(){
  fetch('api/agents/'+editingAgentName+'/preview', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({config: agentTreeData}),
  }).then(function(r){ return r.json(); }).then(renderAgentPreview);
});
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `bun test hub/web.test.ts`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 12: Run the full suite + typecheck**

Run: `bun test` — expect exactly 1 pre-existing failure (`tests/config.test.ts:8` `expandHome` on Windows, unrelated), everything else green.
Run: `bunx tsc --noEmit` — expect 0 errors.

- [ ] **Step 13: Manual verification (do this before moving to Task 2 — this is the only real behavioral check the renderer gets)**

If a live hub with a real Discord token/config is available: `bun run hub`, open the dashboard in a browser, and check:
- Click "Edit" on an existing agent (ideally one with a long `appendSystemPrompt`, like `triage`) — confirm the tree renders, the long string field shows collapsed with a char count and an "Edit" button, not raw escaped text.
- Click "Edit" on that long-string field — confirm a multi-line textarea appears with real line breaks; edit it; click "Collapse" — confirm the preview text updates.
- Edit a short string field, a number field (if any), and a boolean field (e.g. inside `access` or `runtime`) — confirm each is independently editable.
- Expand/collapse a nested object (e.g. `runtime`) — confirm the toggle works.
- Click "+ field" on the top-level tree — confirm it prompts for a name and adds an editable empty field.
- Click "×" on a field — confirm it's removed.
- Click "Preview" — confirm the diff view still renders correctly (unchanged from before this plan) and the classification tier is correct for the edit made.
- Click "Cancel" without submitting, then click "Edit" on a DIFFERENT agent — confirm the tree container is visible and correctly repopulated (this is the specific bug class called out in Step 9 above — verify it doesn't recur).
- Click "Remove" on a throwaway/test agent (not a real one) — confirm the tree container hides and the diff/classification still renders correctly for the removal preview. Do not confirm the removal unless you intend to actually remove that agent.
- Click "+ New Agent" — confirm the tree renders from the starter template, is fully editable, and Preview works.

If no live token is available in this sandbox, document that this step was skipped and why — do not mark it complete without either running it or explicitly noting the fallback.

- [ ] **Step 14: Commit**

```bash
git add hub/web.ts hub/web.test.ts
git commit -m "feat(web): JSON tree/outline editor for agent config, replacing the raw textarea"
```

---

### Task 2: Wire the same renderer into the hub-config editor

**Files:**
- Modify: `hub/web.ts`
- Modify: `hub/web.test.ts`

**Interfaces:**
- Consumes: `jsonTreeRenderRoot` (Task 1, unchanged).
- No new exports.

- [ ] **Step 1: Write the failing tests**

Add to `hub/web.test.ts`:

```ts
test("the dashboard has a tree-editor container for hub config, not the old raw-JSON textarea", () => {
  expect(DASHBOARD_HTML).toContain('id="hubConfigEditorTree"')
  expect(DASHBOARD_HTML).not.toContain('id="hubConfigEditorText"')
})

test("the hub config preview handler sends the live tree data, not a parsed textarea value", () => {
  expect(DASHBOARD_HTML).toContain("body: JSON.stringify({config: hubConfigTreeData})")
  expect(DASHBOARD_HTML).not.toContain("JSON.parse($('hubConfigEditorText').value)")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test hub/web.test.ts`
Expected: FAIL — the hub-config textarea markers are still present, the tree ones aren't.

- [ ] **Step 3: Replace the hub-config editor's textarea with a tree container**

Find (currently line 97):

```html
    <textarea id="hubConfigEditorText" rows="16" style="width:100%;background:#1a1d24;border:1px solid #232733;color:#e6e6e6;padding:8px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
```

Replace with:

```html
    <div id="hubConfigEditorTree" style="font-family:ui-monospace,monospace;font-size:12px"></div>
```

- [ ] **Step 4: Update the "Edit hub config" click handler to render the tree**

Find (lines 407-415):

```js
document.getElementById('editHubConfigBtn').addEventListener('click', function(){
  fetch('api/hub-config').then(function(r){ return r.json(); }).then(function(config){
    lastHubConfigPreviewId = null;
    $('hubConfigEditorText').value = JSON.stringify(config, null, 2);
    $('hubConfigDiff').textContent = '';
    $('hubConfigConfirmRow').innerHTML = '';
    $('hubConfigEditor').style.display = 'block';
  });
});
```

Replace with:

```js
var hubConfigTreeData = null;

document.getElementById('editHubConfigBtn').addEventListener('click', function(){
  fetch('api/hub-config').then(function(r){ return r.json(); }).then(function(config){
    lastHubConfigPreviewId = null;
    hubConfigTreeData = config;
    jsonTreeRenderRoot($('hubConfigEditorTree'), hubConfigTreeData);
    $('hubConfigDiff').textContent = '';
    $('hubConfigConfirmRow').innerHTML = '';
    $('hubConfigEditor').style.display = 'block';
  });
});
```

- [ ] **Step 5: Simplify the hub-config Preview button handler**

Find (lines 421-429):

```js
document.getElementById('hubConfigPreviewBtn').addEventListener('click', function(){
  var parsed;
  try { parsed = JSON.parse($('hubConfigEditorText').value); }
  catch (e) { $('hubConfigDiff').textContent = 'invalid JSON: '+e.message; return; }
  fetch('api/hub-config/preview', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({config: parsed}),
  }).then(function(r){ return r.json(); }).then(renderHubConfigPreview);
});
```

Replace with:

```js
document.getElementById('hubConfigPreviewBtn').addEventListener('click', function(){
  fetch('api/hub-config/preview', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({config: hubConfigTreeData}),
  }).then(function(r){ return r.json(); }).then(renderHubConfigPreview);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test hub/web.test.ts`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 7: Run the full suite + typecheck**

Run: `bun test` — expect exactly 1 pre-existing failure (`tests/config.test.ts:8` `expandHome` on Windows, unrelated), everything else green.
Run: `bunx tsc --noEmit` — expect 0 errors.

- [ ] **Step 8: Commit**

```bash
git add hub/web.ts hub/web.test.ts
git commit -m "feat(web): reuse the JSON tree editor for hub config, replacing its raw textarea"
```

---

### Task 3: End-to-end verification + deploy

**Files:** none (verification + deploy only)

- [ ] **Step 1: Full suite + typecheck on the merged branch**

```bash
bun test
bunx tsc --noEmit
```
Expected: all green (1 known pre-existing failure only).

- [ ] **Step 2: Deploy to the VPS**

```bash
ssh readyapp-newvps "cd /srv/switchboard && git pull --ff-only origin master && pm2 restart switchboard-hub"
```
Confirm clean boot: `ssh readyapp-newvps "tail -10 /home/ubuntu/.pm2/logs/switchboard-hub-error.log"` shows a clean `gateway connected` / `web dashboard on ...` with no crash.

- [ ] **Step 3: Verify the served page's script still parses (this caught a real production outage earlier this session — always check it after touching `hub/web.ts`)**

```bash
ssh readyapp-newvps "curl -s localhost:8080/ -o /tmp/dashboard.html && node -e \"
const fs = require('fs');
const html = fs.readFileSync('/tmp/dashboard.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
try { new Function(m[1]); console.log('JS PARSES OK'); }
catch (e) { console.log('JS SYNTAX ERROR:', e.message); process.exit(1); }
\""
```
Expected: `JS PARSES OK`.

- [ ] **Step 4: Manual verification against the live hub, in a real browser**

Repeat Task 1 Step 13's checklist against the live production hub (both the agent editor AND, using the same checklist adapted for a singleton, the hub-config editor: Edit → tree renders → expand/collapse → edit a short field → Preview → confirm classification renders correctly). Test on both a desktop browser and, since the original report was from a phone, a mobile browser — the tree editor itself doesn't yet have the dedicated responsive/mobile layout pass (that's the separate, not-yet-built "Responsive/mobile layout" project decomposed alongside this one), but confirm the tree editor is at least usable/readable on a phone even without that pass, since collapsing long strings by default was itself a major part of the mobile "mess" reported.

- [ ] **Step 5: Note follow-ups for whoever picks this up next**

The "Responsive/mobile layout" project (tables → stacked cards on narrow screens, activity feed wrapping, general spacing/overflow fixes) remains unbuilt — it was explicitly decomposed as a separate, later piece of work when this project was scoped. It's independent of this tree editor and can be picked up next.
