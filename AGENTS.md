# Project Agent Notes

## Browser Control + Violentmonkey Workflow

These notes define the mandatory workflow for testing Violentmonkey userscripts against sites that block DevTools or synthetic browser behavior.

### Hard Gates

- The agent MUST use the site-specific approved target-page tool for all target-page work. The default tool is the Google Chrome plugin. The Boss Zhipin exception below overrides that default.
- The agent MUST run this workflow in order: static verification, local source update, auto-reload observation gate, target-page verification gate, final report.
- The agent MUST NOT claim the script is ready, fixed, deployed, updated, or verified until every required gate passes.
- If a gate fails, the agent MUST report the exact gate and the exact failing command or tool call.
- The agent MUST NOT use browser install pages, localhost `.user.js` URLs, clipboard replacement, manual paste workflows, extension storage edits, LevelDB edits, or IndexedDB edits to install, update, or remove scripts.
- The final report MUST separately state whether the Violentmonkey auto-reload observation gate completed and which target-page verification path completed.

### Google Chrome Control Plan

- The agent MUST use the Google Chrome plugin for the actual target website after the local source update unless a site-specific exception below overrides that rule. This includes observing the page after Violentmonkey reloads it, clicking page items or controls, clicking userscript buttons, checking layout, and capturing screenshots.
- Boss Zhipin is a site-specific exception. For Boss Zhipin target-page testing and verification, the agent MUST use Windows UI Automation against a real Microsoft Edge window instead of the Google Chrome plugin.
- For Boss Zhipin debugging, the agent MUST NOT use `goto` to access the site. The agent MUST either reuse the current tab if `https://www.zhipin.com/web/geek/jobs` is already open, or directly launch Microsoft Edge to `https://www.zhipin.com/web/geek/jobs` and then use that page.
- The agent MUST NOT assume the backend can be acquired with `agent.browsers.get('chrome')`. The agent MUST first call `agent.browsers.list()`, find the browser descriptor with `type: "extension"` and `name: "Chrome"`, then call `agent.browsers.get(descriptor.id)`.
- If Chrome-specific local detection scripts report no Google Chrome install, the agent MUST NOT conclude the extension backend is unavailable. In this environment the "Chrome" extension backend may control Microsoft Edge tabs.
- The agent MUST verify page behavior from the user's perspective first: visible version markers, toolbar placement, button text, style consistency, hidden or visible item changes, active or selected item changes, and visible status text.
- The agent MUST NOT switch to extension-page tools or browser-debugging tools for target-page verification.
- For visual style changes, the agent MUST compare against nearby native target-page controls and reuse the page's spacing, colors, borders, sizes, and interaction patterns.

### Violentmonkey Auto-Reload Gate

- After editing a tracked userscript file, the agent MUST rely on Violentmonkey's file-watching behavior instead of any manual install, update, delete, pairing, or extension-mediated write flow.
- The agent MUST confirm that the intended local `.user.js` file was updated on disk before moving to page verification.
- The agent MUST observe that the corresponding target page reloads or that the updated userscript version marker or behavior appears without any manual extension install step.
- If the page does not reflect the local edit, the agent MUST troubleshoot the local file path, the userscript metadata match, and Violentmonkey's tracking state before claiming the auto-reload gate passed.
- If the installed userscript may be stale, the agent MUST bump the userscript `@version` before relying on the auto-reload result.
- The agent MUST NOT edit Violentmonkey's extension storage files, LevelDB, IndexedDB, or browser profile state while the browser is running.

### Browser Testing On Protected Sites

- For sites that block F12 or DevTools, the agent MUST use the approved visible-browser path for that site instead of opening DevTools. The default path is the Google Chrome plugin. The Boss Zhipin path is Windows UI Automation on a real Microsoft Edge window.
- When adding or changing page UI, the agent MUST first reuse or mirror the target page's existing styles: nearby classes, spacing, button sizes, borders, colors, hover and disabled states, and placement patterns.
- If normal DOM clicks do not trigger site behavior, the agent MAY inspect page-owned framework state from the page context when available.
- The agent SHOULD prefer the site's own framework methods over untrusted synthetic events when those methods can be identified safely.
- Violentmonkey runs in an isolated userscript world. If page-world access is required, the agent MUST add `@grant unsafeWindow`.
- If `unsafeWindow` access is still insufficient, the agent MUST inject a narrow page-world bridge script and communicate through `CustomEvent` using simple JSON payloads.
- For sorting or stateful UI behavior controlled by framework state, the agent MUST verify both the visible DOM and the framework-backed state.

### Userscript Storage

- The agent MUST store user data with `GM_getValue` and `GM_setValue` when the data should be available through the userscript manager's sync-capable storage path.
- The agent MUST keep stored values JSON-serializable and keyed by stable IDs.
- The agent MUST NOT make `localStorage` the primary storage path. A `localStorage` fallback is allowed only as an explicit degraded-environment fallback and MUST NOT replace userscript-manager storage as the default path.

### Verification Pattern

- After every userscript compile or edit cycle, the agent MUST run the full verification flow before declaring the script ready.
- The agent MUST NOT stop after static checks if the auto-reload observation gate and the required target-page verification path are available.
- If pure logic was extracted into a helper, the agent MUST cover it with `node --test`.
- The agent MUST run tests that cover at minimum:
  - ID extraction from page URLs;
  - ranking or sorting logic and tie ordering relevant to the feature;
  - choosing the next visible item after hide, ignore, or removal actions;
  - storage normalization and serialization;
  - framework list reorder logic for sorted records.
- The agent MUST syntax-check the `.user.js` with Node's `vm.Script` before target-page verification.
- The agent MUST complete the auto-reload observation gate:
  - confirm the intended local `.user.js` file was updated on disk;
  - if needed, bump `@version` so the updated build is unambiguous on the page;
  - observe that Violentmonkey tracks the changed file and refreshes or re-applies the page state for the matching target page without a manual install or update flow;
  - confirm the updated version marker or intended behavior is now present on the page.
- The agent MUST complete the target-page verification gate after the auto-reload observation gate.
- For non-Boss-Zhipin targets, the agent MUST use the Google Chrome plugin and MUST:
  - prefer observing the Violentmonkey-triggered page refresh or re-application first, and only perform a manual refresh if the feature under test requires an additional clean reload;
  - verify that the toolbar or another page-visible marker shows the expected userscript version when a version marker exists;
  - verify that toolbar placement does not create layout gaps;
  - verify that custom toolbar controls visually match neighboring native page controls;
  - verify that detail-pane action buttons visually match the scale and spacing of neighboring native action buttons, except for intentional destructive coloring;
  - verify that hide, ignore, or removal actions hide the current item and activate the next visible item when the feature promises that behavior;
  - verify that feedback toasts show a visible undo action when undo is part of the feature;
  - verify that refresh does not leave details focused on a hidden or ignored item;
  - verify that show or hide toggles change visibility without clearing stored state;
  - verify that hidden keyword filters hide both title matches and item-card tag or keyword matches;
  - verify that sorting changes the rendered order and survives the site's framework re-render.
- For Boss Zhipin, the agent MUST use Windows UI Automation on a real Microsoft Edge window and MUST:
  - reuse the current `https://www.zhipin.com/web/geek/jobs` tab if it already exists, or directly launch Microsoft Edge to that URL;
  - MUST NOT use `goto` to access the page;
  - prefer observing the Violentmonkey-triggered page refresh or re-application first, and only perform a manual refresh through the visible Edge window if the feature under test requires an additional clean reload;
  - verify that the toolbar or another page-visible marker shows the expected userscript version when a version marker exists;
  - verify that toolbar placement does not create layout gaps;
  - verify that custom toolbar controls visually match neighboring native page controls;
  - verify that detail-pane action buttons visually match the scale and spacing of neighboring native action buttons, except for intentional destructive coloring;
  - verify that hide, ignore, or removal actions hide the current item and activate the next visible item when the feature promises that behavior;
  - verify that feedback toasts show a visible undo action when undo is part of the feature;
  - verify that refresh does not leave details focused on a hidden or ignored item;
  - verify that show or hide toggles change visibility without clearing stored state;
  - verify that hidden keyword filters hide both title matches and item-card tag or keyword matches;
  - verify that sorting changes the rendered order and survives the site's framework re-render.
- If the required site-specific verification path is unavailable, the agent MUST report that the auto-reload observation gate completed but target-page verification did not complete.
- The agent MUST NOT use the words `ready`, `done`, `fixed`, `verified`, or equivalent completion claims unless static verification, the auto-reload observation gate, and the required target-page verification path all passed.

### Cleanup

- The agent MUST remove temporary screenshots and crops after testing.
- The agent MUST leave only source files and intentional tests in `git status`.
