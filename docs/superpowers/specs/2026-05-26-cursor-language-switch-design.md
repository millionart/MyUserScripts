# Cursor Dashboard Language Switch Design

## Summary

Create a Violentmonkey userscript for `https://cursor.com/*` that adds a `Language` setting to Cursor's existing Settings UI and enables interface language switching across reachable authenticated Cursor dashboard pages.

Initial language support:

- `Default`: no translation behavior runs; the page remains in Cursor's original language
- `简体中文`: userscript-driven Simplified Chinese translation for Cursor dashboard UI text

The script must preserve brand names and other proper nouns such as `GitHub`, `Slack`, `Teams`, `OpenAI`, `API`, `MCP`, `SSO`, and `OAuth`.

The script must not rely on browser-native translation features. This is a hard requirement because browser translation, especially in Edge, can destabilize the page after load.

## Goals

- Add a `Language` option inside Cursor's existing Settings page
- Persist the selected language using userscript-managed storage only
- Apply the selected language across reachable Cursor dashboard pages
- Keep proper nouns and technical identifiers in their original form
- Avoid heavy DOM rewriting patterns that could break Cursor's frontend runtime
- Support SPA navigation and async rendering without requiring reinstallation

## Non-Goals

- Translating user-generated content such as workspace names, prompts, email addresses, logs, code snippets, or URLs
- Translating the public marketing site outside the authenticated dashboard flow
- Using machine translation or external translation APIs
- Modifying Cursor backend responses or React internal state
- Supporting languages other than Simplified Chinese in the first version

## Constraints

- Storage must use `GM_getValue` and `GM_setValue`
- `Default` mode must disable translation logic rather than mapping to English strings
- The userscript must restore original visible text when switching from `简体中文` back to `Default`
- The implementation must be safe against repeated SPA renders and mutation bursts
- The implementation must not use browser translation features or extension storage manipulation workflows

## User Experience

On the Settings page, the user sees a new `Language` setting styled like nearby native controls.

Available values:

- `Default`
- `简体中文`

Behavior:

- Choosing `Default` stores the value and disables translation activity
- Choosing `简体中文` stores the value and applies Simplified Chinese translations to supported dashboard UI text
- The choice persists across refreshes and route changes
- Switching back to `Default` restores the original UI text captured before translation

## Architecture

The userscript will be split into the following runtime responsibilities inside a single `.user.js` file, with pure logic extracted into a testable helper module if helpful:

1. `languageStore`
   Reads and writes the selected language via `GM_getValue` and `GM_setValue`.

2. `settingsInjector`
   Detects the Cursor Settings page, finds an appropriate insertion point, and mounts the `Language` control using DOM elements styled to match neighboring settings controls.

3. `translationRegistry`
   Contains translation rules:
   - exact phrase mappings
   - optional pattern-based mappings for controlled text variants
   - protected proper nouns that must remain unchanged

4. `translationRuntime`
   Scans eligible visible UI text nodes and supported attribute targets, applies translations when the selected language is `简体中文`, and stores enough original text state to restore the UI when returning to `Default`.

5. `routeObserver`
   Watches SPA navigation and async DOM updates, schedules incremental rescans, and avoids duplicate work.

## Translation Strategy

### Target Content

Translate stable dashboard UI text including:

- side navigation labels
- page headings
- settings group titles
- field labels
- buttons
- menus
- modal titles
- toast or inline status messages
- table headers
- empty-state copy

### Excluded Content

Do not translate:

- `input`, `textarea`, `code`, `pre`, `kbd`, `script`, `style`
- user-generated content
- workspace or project names
- repository names
- emails
- URLs
- API keys
- logs and stack traces
- code blocks or shell commands

### Proper Noun Protection

Protected proper nouns remain unchanged even inside a larger translated string. The first version will use a curated protected-term set that includes:

- `GitHub`
- `Slack`
- `Teams`
- `OpenAI`
- `API`
- `MCP`
- `SSO`
- `OAuth`
- `Cursor`

If a source string mixes UI text with protected terms, the translator will preserve the protected terms and translate the surrounding UI copy only.

### Matching Rules

The translation registry will support:

- exact string matches for known UI labels
- normalized whitespace matching to tolerate small formatting differences
- limited pattern rules for controlled variants where exact matching is too brittle

The first release should favor exact mappings over broad patterns to reduce accidental translations and frontend instability.

## DOM Safety Strategy

To avoid the type of instability seen with browser-native translation:

- never rewrite large containers with `innerHTML`
- never rewrite the entire document or `body`
- only update targeted text nodes or narrowly scoped text-bearing elements
- mark translated nodes to avoid redundant work
- keep a reversible record of original text for translated nodes
- throttle mutation processing and batch rescans

When the selected language is `Default`, mutation observers may remain available for Settings page injection if needed, but translation work itself must not run.

## State Restoration

The script must support toggling from `简体中文` back to `Default` without requiring a full page reload.

Restoration strategy:

- before translating a text target, capture the original value in a per-node cache
- when returning to `Default`, restore cached original values for all nodes still present
- clear translated-node markers after restoration
- newly rendered nodes in `Default` mode remain untouched

If a node disappears and later reappears through a framework rerender, the runtime should treat it as a fresh node and leave it untouched in `Default` mode.

## Settings Injection

The script will:

- detect the Settings page through URL and structural cues
- locate a stable settings section near existing preference controls
- insert a `Language` row that visually matches native spacing, borders, font sizes, and control sizing
- use a native-looking select or dropdown pattern based on nearby page controls

The userscript may also expose a lightweight visible version marker in or near the injected setting row if needed for Violentmonkey auto-reload verification.

## Page Coverage

The userscript should activate on authenticated Cursor dashboard pages under `https://cursor.com/*` and only translate UI in the dashboard experience.

The script should not assume one fixed route. It must continue working as the user navigates between reachable backend pages without manual reinjection.

## Testing Strategy

Pure logic extracted from the userscript must be covered with `node --test`.

Minimum logic tests for the first version:

- language storage normalization
- exact translation lookup
- protected proper noun preservation
- excluded-node detection
- restoration behavior for translated text targets
- route or mutation scheduling helpers if extracted

Static verification:

- syntax-check the `.user.js` using Node `vm.Script`

## Manual Verification Strategy

Required verification flow:

1. Confirm the intended local `.user.js` file changed on disk
2. If needed, bump `@version` so the changed build is obvious
3. Rely on Violentmonkey file tracking rather than manual reinstall
4. Use the Chrome plugin on Cursor dashboard pages to observe whether the updated script reapplies
5. Verify the Settings page shows the new `Language` option
6. Verify `Default` mode leaves UI untranslated
7. Verify switching to `简体中文` updates supported UI text on the current page
8. Verify protected terms such as `GitHub` remain unchanged
9. Verify navigating to other reachable dashboard pages preserves the selected language
10. Verify switching back to `Default` restores original text
11. Verify the injected setting visually fits the existing Settings layout

## Risks And Mitigations

### Risk: Cursor UI changes frequently

Mitigation:

- prefer resilient text and structure matching over brittle deep selectors
- isolate settings injection selectors from translation rules

### Risk: Translation breaks React-managed UI

Mitigation:

- only patch visible text targets
- avoid changing component identity, attributes unrelated to copy, or event wiring
- batch and throttle mutation handling

### Risk: Over-translation of user content

Mitigation:

- default to exclusion unless a node is clearly part of product UI
- keep broad pattern rules to a minimum

### Risk: Default mode does not fully restore

Mitigation:

- capture original text before first translation
- test restoration explicitly
- prefer node-local reversible updates over global text replacement

## Implementation Notes

- The first implementation should prioritize stability over coverage completeness
- Translation coverage can grow iteratively through the registry without changing the storage or injection architecture
- Any helper module introduced for tests should stay narrowly scoped and avoid coupling to browser-only runtime APIs
