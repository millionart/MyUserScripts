# Cursor Language Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Violentmonkey userscript for `https://cursor.com/*` that injects a `Language` setting into Cursor Settings, supports `Default` and `简体中文`, preserves proper nouns, and applies stable UI translation across reachable authenticated Cursor dashboard pages.

**Architecture:** Keep the runtime userscript in a single `.user.js` file and extract pure helper logic into a focused `.cjs` module for fast `node --test` coverage. The userscript handles DOM observation, Settings injection, and reversible UI translation, while the helper module owns language normalization, text translation, proper-noun protection, and node-eligibility decisions.

**Tech Stack:** Violentmonkey userscript APIs (`GM_getValue`, `GM_setValue`, `GM_addStyle`), plain DOM APIs, `node:test`, `node:assert/strict`, Node `vm.Script`, Chrome plugin verification on a live Cursor dashboard session.

---

## File Map

- Create: `C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js`
  Runtime userscript for Cursor dashboard pages.
- Create: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.cjs`
  Pure helper logic for language mode normalization, phrase translation, protected terms, and target filtering.
- Create: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`
  Unit tests for extracted helper logic.
- Create: `C:\Users\milli\Git\MyUserScripts\docs\superpowers\plans\2026-05-26-cursor-language-switch.md`
  This implementation plan.
- Modify later if needed: `C:\Users\milli\Git\MyUserScripts\.gitignore`
  Only if temporary artifacts need ignoring; avoid this unless verification creates unavoidable files.

## Task 1: Build And Test The Translation Core

**Files:**
- Create: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.cjs`
- Create: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLanguageMode,
  createTranslationEngine,
  shouldTranslateText,
  isExcludedTagName,
} = require('./cursor-language-switch-core.cjs');

test('normalizes unknown language values to default', () => {
  assert.equal(normalizeLanguageMode(undefined), 'default');
  assert.equal(normalizeLanguageMode('DEFAULT'), 'default');
  assert.equal(normalizeLanguageMode('zh-CN'), 'zh-CN');
  assert.equal(normalizeLanguageMode('gibberish'), 'default');
});

test('translates an exact UI phrase in zh-CN mode', () => {
  const engine = createTranslationEngine();
  assert.equal(engine.translateText('Settings', 'zh-CN'), '设置');
});

test('preserves protected proper nouns inside a translated phrase', () => {
  const engine = createTranslationEngine();
  assert.equal(
    engine.translateText('Connect GitHub account', 'zh-CN'),
    '连接 GitHub 账号',
  );
});

test('returns original text in default mode', () => {
  const engine = createTranslationEngine();
  assert.equal(engine.translateText('Settings', 'default'), 'Settings');
});

test('rejects excluded tag names from translation targeting', () => {
  assert.equal(isExcludedTagName('CODE'), true);
  assert.equal(isExcludedTagName('BUTTON'), false);
});

test('skips text that looks like user data or technical output', () => {
  assert.equal(shouldTranslateText('sk-live-123456789', { tagName: 'SPAN' }), false);
  assert.equal(shouldTranslateText('https://cursor.com/settings', { tagName: 'SPAN' }), false);
  assert.equal(shouldTranslateText('Members', { tagName: 'SPAN' }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: `FAIL` with a module-not-found or missing-export error for `cursor-language-switch-core.cjs`.

- [ ] **Step 3: Write minimal implementation**

```js
const EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SCRIPT', 'STYLE']);
const LANGUAGE_MODES = new Set(['default', 'zh-CN']);
const PROTECTED_TERMS = ['GitHub', 'Slack', 'Teams', 'OpenAI', 'API', 'MCP', 'SSO', 'OAuth', 'Cursor'];
const EXACT_TRANSLATIONS = new Map([
  ['Settings', '设置'],
  ['Members', '成员'],
  ['Billing', '计费'],
  ['Usage', '用量'],
  ['Security', '安全'],
  ['Connect GitHub account', '连接 GitHub 账号'],
]);

function normalizeLanguageMode(value) {
  if (typeof value !== 'string') return 'default';
  const normalized = value.trim();
  if (!normalized) return 'default';
  if (normalized.toLowerCase() === 'default') return 'default';
  return LANGUAGE_MODES.has(normalized) ? normalized : 'default';
}

function isExcludedTagName(tagName) {
  return EXCLUDED_TAGS.has(String(tagName || '').toUpperCase());
}

function looksLikeTechnicalText(text) {
  return /https?:\/\/|sk-[\w-]{6,}|@[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+/.test(text);
}

function shouldTranslateText(text, context = {}) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (isExcludedTagName(context.tagName)) return false;
  if (looksLikeTechnicalText(value)) return false;
  if (value.length > 120 && !EXACT_TRANSLATIONS.has(value)) return false;
  return true;
}

function createTranslationEngine() {
  function translateText(text, languageMode) {
    if (normalizeLanguageMode(languageMode) === 'default') return text;
    const exact = EXACT_TRANSLATIONS.get(text);
    if (exact) return exact;

    let output = String(text);
    PROTECTED_TERMS.forEach((term) => {
      output = output.replace(term, `__PROTECTED__${term}__`);
    });

    output = output
      .replace(/^Connect\s+(.+)\s+account$/u, '连接 $1 账号')
      .replace(/^Language$/u, '语言')
      .replace(/^Default$/u, '默认')
      .replace(/^Chinese \(Simplified\)$/u, '简体中文');

    PROTECTED_TERMS.forEach((term) => {
      output = output.replace(`__PROTECTED__${term}__`, term);
    });

    return output;
  }

  return { translateText };
}

module.exports = {
  normalizeLanguageMode,
  createTranslationEngine,
  shouldTranslateText,
  isExcludedTagName,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

- [ ] **Step 5: Expand the failing test for restoration and node-marking helpers**

```js
test('creates a stable node cache payload for translated content', () => {
  const { createNodeCacheValue } = require('./cursor-language-switch-core.cjs');
  assert.deepEqual(
    createNodeCacheValue('Settings', '设置'),
    { originalText: 'Settings', translatedText: '设置' },
  );
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: `FAIL` with `createNodeCacheValue is not a function`.

- [ ] **Step 7: Write minimal implementation**

```js
function createNodeCacheValue(originalText, translatedText) {
  return {
    originalText: String(originalText),
    translatedText: String(translatedText),
  };
}

module.exports = {
  normalizeLanguageMode,
  createTranslationEngine,
  shouldTranslateText,
  isExcludedTagName,
  createNodeCacheValue,
};
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

- [ ] **Step 9: Commit**

```bash
git add cursor-language-switch-core.cjs cursor-language-switch-core.test.cjs
git commit -m "Add Cursor language switch core helpers"
```

## Task 2: Add The Userscript Shell And Static Syntax Validation

**Files:**
- Create: `C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js`
- Modify: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.cjs`
- Modify: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`

- [ ] **Step 1: Write the failing test for runtime-facing helper behavior**

```js
test('provides seed settings translations for the language selector', () => {
  const engine = createTranslationEngine();
  assert.equal(engine.translateText('Language', 'zh-CN'), '语言');
  assert.equal(engine.translateText('Default', 'zh-CN'), '默认');
  assert.equal(engine.translateText('Chinese (Simplified)', 'zh-CN'), '简体中文');
});
```

- [ ] **Step 2: Run test to verify it fails if the mappings are missing**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: `FAIL` on one or more missing translation assertions.

- [ ] **Step 3: Write minimal implementation and runtime shell**

```js
// ==UserScript==
// @name         Cursor Dashboard Language Switch
// @name:zh-CN   Cursor 后台语言切换
// @namespace    https://github.com/milli/myuserscripts
// @version      0.1.0
// @description  Add a language setting to Cursor dashboard Settings and support Simplified Chinese UI translation.
// @license      MIT
// @match        https://cursor.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.1.0';
  const LANGUAGE_STORAGE_KEY = 'cursor-dashboard-language-switch:language';
  const TRANSLATED_ATTR = 'data-cursor-language-switch';
  const ORIGINAL_TEXT_ATTR = 'data-cursor-language-switch-original';

  function normalizeLanguageMode(value) {
    if (typeof value !== 'string') return 'default';
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'default') return 'default';
    return trimmed === 'zh-CN' ? 'zh-CN' : 'default';
  }

  const translations = new Map([
    ['Settings', '设置'],
    ['Language', '语言'],
    ['Default', '默认'],
    ['Chinese (Simplified)', '简体中文'],
  ]);

  function translateText(text, languageMode) {
    if (normalizeLanguageMode(languageMode) === 'default') return text;
    return translations.get(text) || text;
  }

  async function getLanguageMode() {
    const stored = await GM_getValue(LANGUAGE_STORAGE_KEY, 'default');
    return normalizeLanguageMode(stored);
  }

  window.__cursorLanguageSwitchTest = {
    SCRIPT_VERSION,
    LANGUAGE_STORAGE_KEY,
    translateText,
    normalizeLanguageMode,
    TRANSLATED_ATTR,
    ORIGINAL_TEXT_ATTR,
  };
})();
```

- [ ] **Step 4: Run tests and syntax validation**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

Run:

```powershell
@'
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('Cursor Dashboard Language Switch.user.js', 'utf8');
new vm.Script(code, { filename: 'Cursor Dashboard Language Switch.user.js' });
console.log('syntax ok');
'@ | node -
```

Expected: `syntax ok`.

- [ ] **Step 5: Commit**

```bash
git add cursor-language-switch-core.cjs cursor-language-switch-core.test.cjs "Cursor Dashboard Language Switch.user.js"
git commit -m "Add Cursor language switch userscript shell"
```

## Task 3: Implement Reversible DOM Translation Runtime

**Files:**
- Modify: `C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js`
- Modify: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.cjs`
- Modify: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`

- [ ] **Step 1: Write the failing tests for higher-value phrase coverage**

```js
test('translates common dashboard navigation labels', () => {
  const engine = createTranslationEngine();
  assert.equal(engine.translateText('Workspace', 'zh-CN'), '工作区');
  assert.equal(engine.translateText('Members', 'zh-CN'), '成员');
  assert.equal(engine.translateText('Security', 'zh-CN'), '安全');
  assert.equal(engine.translateText('Usage', 'zh-CN'), '用量');
});

test('does not translate unknown long content blocks', () => {
  const engine = createTranslationEngine();
  const text = 'This is a long block of descriptive content coming from a dynamic area that should stay unchanged.';
  assert.equal(engine.translateText(text, 'zh-CN'), text);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: `FAIL` on missing phrase translations.

- [ ] **Step 3: Write minimal implementation for runtime translation**

```js
function applyTranslationToElement(element, languageMode) {
  if (!element || !element.isConnected) return;
  if (isExcludedElement(element)) return;

  const sourceText = getElementTextValue(element);
  if (!shouldTranslateText(sourceText, { tagName: element.tagName })) return;

  if (normalizeLanguageMode(languageMode) === 'default') {
    restoreElementText(element);
    return;
  }

  const translatedText = translateText(sourceText, languageMode);
  if (translatedText === sourceText) return;

  if (!element.hasAttribute(ORIGINAL_TEXT_ATTR)) {
    element.setAttribute(ORIGINAL_TEXT_ATTR, sourceText);
  }
  setElementTextValue(element, translatedText);
  element.setAttribute(TRANSLATED_ATTR, '1');
}

function restoreElementText(element) {
  if (!element || !element.hasAttribute(ORIGINAL_TEXT_ATTR)) return;
  setElementTextValue(element, element.getAttribute(ORIGINAL_TEXT_ATTR) || '');
  element.removeAttribute(ORIGINAL_TEXT_ATTR);
  element.removeAttribute(TRANSLATED_ATTR);
}

function applyTranslations(root, languageMode) {
  const elements = root.querySelectorAll('button, a, span, div, label, p, h1, h2, h3, h4, th');
  elements.forEach((element) => applyTranslationToElement(element, languageMode));
}

function restoreTranslations(root) {
  root.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((element) => restoreElementText(element));
}
```

- [ ] **Step 4: Run helper tests and syntax validation**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

Run the same `vm.Script` syntax-check command from Task 2.

Expected: `syntax ok`.

- [ ] **Step 5: Commit**

```bash
git add cursor-language-switch-core.cjs cursor-language-switch-core.test.cjs "Cursor Dashboard Language Switch.user.js"
git commit -m "Add Cursor dashboard translation runtime"
```

## Task 4: Inject The Settings Language Control And Wire Persistence

**Files:**
- Modify: `C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js`
- Modify: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`

- [ ] **Step 1: Write the failing runtime smoke test for exported selectors**

```js
test('exposes stable settings selectors for test inspection', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const scriptPath = path.join(__dirname, 'Cursor Dashboard Language Switch.user.js');
  const code = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = {
    console,
    window: {},
    document: { readyState: 'loading', addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    GM_getValue: async () => 'default',
    GM_setValue: async () => {},
    GM_addStyle() {},
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: scriptPath });
  assert.equal(sandbox.__cursorLanguageSwitchTest.SETTINGS_ROW_ID, 'cursor-language-switch-setting');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: `FAIL` because `SETTINGS_ROW_ID` is missing.

- [ ] **Step 3: Write minimal implementation**

```js
const SETTINGS_ROW_ID = 'cursor-language-switch-setting';
const LANGUAGE_SELECT_ID = 'cursor-language-switch-select';

function isSettingsRoute() {
  return /\/settings(?:\/|$|\?)/.test(window.location.pathname);
}

function createLanguageRow(currentMode) {
  const row = document.createElement('div');
  row.id = SETTINGS_ROW_ID;
  row.className = 'cursor-language-switch-row';

  const label = document.createElement('label');
  label.setAttribute('for', LANGUAGE_SELECT_ID);
  label.textContent = 'Language';

  const select = document.createElement('select');
  select.id = LANGUAGE_SELECT_ID;
  [['default', 'Default'], ['zh-CN', 'Chinese (Simplified)']].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === currentMode) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', async () => {
    const nextMode = normalizeLanguageMode(select.value);
    await GM_setValue(LANGUAGE_STORAGE_KEY, nextMode);
    await refreshPageLanguage(nextMode);
  });

  row.append(label, select);
  return row;
}
```

- [ ] **Step 4: Run tests and syntax validation**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

Run the `vm.Script` syntax-check command from Task 2.

Expected: `syntax ok`.

- [ ] **Step 5: Commit**

```bash
git add cursor-language-switch-core.test.cjs "Cursor Dashboard Language Switch.user.js"
git commit -m "Inject Cursor language setting and persistence"
```

## Task 5: Add SPA Observation And Auto-Reapply Behavior

**Files:**
- Modify: `C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js`
- Modify: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`

- [ ] **Step 1: Write the failing helper test for debounced rescan scheduling**

```js
test('coalesces repeated route refresh requests', async () => {
  const { createRescanScheduler } = require('./cursor-language-switch-core.cjs');
  const calls = [];
  const scheduler = createRescanScheduler(() => calls.push('run'));
  scheduler.schedule();
  scheduler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['run']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: `FAIL` because `createRescanScheduler` is missing.

- [ ] **Step 3: Write minimal implementation**

```js
function createRescanScheduler(run, delayMs = 10) {
  let timer = null;
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}

function installObservers() {
  const scheduler = createRuntimeScheduler();
  const observer = new MutationObserver(() => scheduler.schedule());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  let previousHref = location.href;
  setInterval(() => {
    if (location.href !== previousHref) {
      previousHref = location.href;
      scheduler.schedule();
    }
  }, 500);
}
```

- [ ] **Step 4: Run tests and syntax validation**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

Run the `vm.Script` syntax-check command from Task 2.

Expected: `syntax ok`.

- [ ] **Step 5: Commit**

```bash
git add cursor-language-switch-core.cjs cursor-language-switch-core.test.cjs "Cursor Dashboard Language Switch.user.js"
git commit -m "Handle Cursor SPA rerenders for language updates"
```

## Task 6: Local Verification And Chrome Plugin Validation

**Files:**
- Modify only if validation exposes a bug: `C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js`
- Modify only if validation exposes a bug: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.cjs`
- Modify only if validation exposes a bug: `C:\Users\milli\Git\MyUserScripts\cursor-language-switch-core.test.cjs`

- [ ] **Step 1: Run the full local static verification**

Run: `node --test .\cursor-language-switch-core.test.cjs`

Expected: all tests `PASS`.

Run:

```powershell
@'
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('Cursor Dashboard Language Switch.user.js', 'utf8');
new vm.Script(code, { filename: 'Cursor Dashboard Language Switch.user.js' });
console.log('syntax ok');
'@ | node -
```

Expected: `syntax ok`.

- [ ] **Step 2: Confirm the tracked userscript changed on disk**

Run:

```powershell
Get-Item "C:\Users\milli\Git\MyUserScripts\Cursor Dashboard Language Switch.user.js" | Select-Object FullName, LastWriteTime, Length
```

Expected: the file path, recent timestamp, and non-zero length are shown.

- [ ] **Step 3: Use the Chrome plugin to observe the auto-reload gate**

Verification actions:

- Open the logged-in Cursor dashboard in the Chrome plugin
- Navigate to a reachable Settings page without using browser translation
- Observe whether Violentmonkey reloads or reapplies the updated script after the local file change
- Confirm a visible script version marker or the new `Language` setting appears without any manual reinstall flow

Expected:

- the auto-reload observation gate passes only if the changed local file is reflected on the page

- [ ] **Step 4: Use the Chrome plugin to verify target-page behavior**

Verification actions:

- On Settings, confirm the injected `Language` row visually fits nearby controls
- Confirm `Default` is the stored initial mode unless a previous value exists
- Switch to `简体中文`
- Confirm high-value UI labels such as `Settings`, `Members`, `Billing`, or `Usage` appear in Chinese on reachable dashboard pages
- Confirm protected terms such as `GitHub` remain unchanged
- Navigate to at least one additional reachable dashboard route and confirm the chosen language persists
- Switch back to `Default` and confirm original text is restored

Expected:

- all requested behavior is visible from the page without browser-native translation

- [ ] **Step 5: Clean up temporary artifacts**

Run: `git status --short`

Expected: only intentional source or test changes remain; no screenshots or scratch files.

- [ ] **Step 6: Commit the final working implementation**

```bash
git add cursor-language-switch-core.cjs cursor-language-switch-core.test.cjs "Cursor Dashboard Language Switch.user.js"
git commit -m "Add Cursor dashboard language switch userscript"
```
