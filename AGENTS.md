# Project Agent Notes

## Browser Control + Tampermonkey Workflow

These notes define the mandatory workflow for testing Tampermonkey userscripts against sites that block DevTools or synthetic browser behavior.

### Hard Gates

- The agent MUST deploy, update, and delete Tampermonkey scripts only through `tampermonkey-mcp`.
- The agent MUST use the site-specific approved target-page tool for all target-page work. The default tool is the Google Chrome plugin. The Boss Zhipin exception below overrides that default.
- The agent MUST run this workflow in order: static verification, MCP connection gate, MCP read gate, MCP write gate, MCP post-write verification gate, target-page verification gate, final report.
- The agent MUST NOT claim the script is ready, fixed, deployed, updated, or verified until every required gate passes.
- If a gate fails, the agent MUST report the exact gate and the exact failing command or tool call.
- The agent MUST NOT use browser install pages, localhost `.user.js` URLs, Windows UI Automation, clipboard replacement, manual paste workflows, extension storage edits, LevelDB edits, or IndexedDB edits for deployment.
- The final report MUST name the MCP tool used for the write operation and MUST separately state which target-page verification path completed.

### Google Chrome Control Plan

- The agent MUST use the Google Chrome plugin for the actual target website after MCP deployment unless a site-specific exception below overrides that rule. This includes refreshing the page, clicking page items or controls, clicking userscript buttons, checking layout, and capturing screenshots.
- Boss Zhipin is a site-specific exception. For Boss Zhipin target-page testing and verification, the agent MUST use Windows UI Automation against a real Microsoft Edge window instead of the Google Chrome plugin.
- For Boss Zhipin debugging, the agent MUST NOT use `goto` to access the site. The agent MUST either reuse the current tab if `https://www.zhipin.com/web/geek/jobs` is already open, or directly launch Microsoft Edge to `https://www.zhipin.com/web/geek/jobs` and then use that page.
- The agent MUST NOT assume the backend can be acquired with `agent.browsers.get('chrome')`. The agent MUST first call `agent.browsers.list()`, find the browser descriptor with `type: "extension"` and `name: "Chrome"`, then call `agent.browsers.get(descriptor.id)`.
- If Chrome-specific local detection scripts report no Google Chrome install, the agent MUST NOT conclude the extension backend is unavailable. In this environment the "Chrome" extension backend may control Microsoft Edge tabs.
- The agent MUST verify page behavior from the user's perspective first: visible version markers, toolbar placement, button text, style consistency, hidden or visible item changes, active or selected item changes, and visible status text.
- The agent MUST NOT switch to extension-page tools or browser-debugging tools for target-page verification.
- For visual style changes, the agent MUST compare against nearby native target-page controls and reuse the page's spacing, colors, borders, sizes, and interaction patterns.

### Tampermonkey MCP Connection Gate

- Before any deploy write, the agent MUST make the `tampermonkey` MCP connection live.
- If the session is not already paired, the agent MUST call `tampermonkey.get-connection-code`, return the code, and complete the Tampermonkey Editors pairing before attempting `tampermonkey.list`, `tampermonkey.get`, `tampermonkey.patch`, `tampermonkey.put`, or `tampermonkey.delete`.
- If the MCP connection is not live, the agent MUST troubleshoot in this order:
  1. verify the Codex-side `tampermonkey` MCP server is configured and enabled;
  2. verify the local `tampermonkey-mcp` entry point still starts and can return a connection code;
  3. verify Tampermonkey Editors is installed in the browser and repeat pairing with a fresh `tampermonkey.get-connection-code`;
  4. rebuild or restart the local MCP server if the local checkout or build artifacts are stale;
  5. retry `tampermonkey.list`.
- The agent MUST NOT continue to script writes until `tampermonkey.list` succeeds.
- Only after the full troubleshooting sequence fails may the agent report the MCP gate as blocked.

### Tampermonkey MCP Read And Write Gates

- For updates, the agent MUST run `tampermonkey.list`, MUST resolve the target script path, MUST run `tampermonkey.get`, and MUST capture the current source and `lastModified` before writing.
- For an existing script, the agent MUST call `tampermonkey.patch` with the target `path`, the updated source, and the latest `lastModified`.
- For a new script, the agent MUST use `tampermonkey.list` to confirm the script is absent, MUST call `tampermonkey.put`, and MUST confirm the created script with `tampermonkey.get`.
- If `tampermonkey.patch` reports a concurrent edit or stale `lastModified`, the agent MUST immediately run `tampermonkey.get`, MUST review the new server-side source, MUST merge intentionally, and MUST retry against the latest `lastModified`.
- The agent MUST NOT force overwrite blindly after a stale-write failure.
- The agent MUST call `tampermonkey.get` immediately after every successful write and MUST confirm the returned source contains the expected `@version` and intended content.
- The agent MUST call `tampermonkey.list` after every successful write and MUST confirm the script appears under the expected name and path.
- If the installed userscript may be stale, the agent MUST bump the userscript `@version` before deployment.
- The agent MUST use `tampermonkey.delete` only for intentional removals.
- The agent MUST NOT edit Tampermonkey's extension storage files, LevelDB, IndexedDB, or browser profile state while the browser is running.

### Browser Testing On Protected Sites

- For sites that block F12 or DevTools, the agent MUST use the approved visible-browser path for that site instead of opening DevTools. The default path is the Google Chrome plugin. The Boss Zhipin path is Windows UI Automation on a real Microsoft Edge window.
- When adding or changing page UI, the agent MUST first reuse or mirror the target page's existing styles: nearby classes, spacing, button sizes, borders, colors, hover and disabled states, and placement patterns.
- If normal DOM clicks do not trigger site behavior, the agent MAY inspect page-owned framework state from the page context when available.
- The agent SHOULD prefer the site's own framework methods over untrusted synthetic events when those methods can be identified safely.
- Tampermonkey runs in an isolated userscript world. If page-world access is required, the agent MUST add `@grant unsafeWindow`.
- If `unsafeWindow` access is still insufficient, the agent MUST inject a narrow page-world bridge script and communicate through `CustomEvent` using simple JSON payloads.
- For sorting or stateful UI behavior controlled by framework state, the agent MUST verify both the visible DOM and the framework-backed state.

### Tampermonkey Storage

- The agent MUST store user data with `GM_getValue` and `GM_setValue` when the data should be available for Tampermonkey cloud sync.
- The agent MUST keep stored values JSON-serializable and keyed by stable IDs.
- The agent MUST NOT make `localStorage` the primary storage path. A `localStorage` fallback is allowed only as an explicit degraded-environment fallback and MUST NOT replace Tampermonkey storage as the default path.

### Verification Pattern

- After every userscript compile or edit cycle, the agent MUST run the full verification flow before declaring the script ready.
- The agent MUST NOT stop after static checks if MCP deployment and the required target-page verification path are available.
- If pure logic was extracted into a helper, the agent MUST cover it with `node --test`.
- The agent MUST run tests that cover at minimum:
  - ID extraction from page URLs;
  - ranking or sorting logic and tie ordering relevant to the feature;
  - choosing the next visible item after hide, ignore, or removal actions;
  - storage normalization and serialization;
  - framework list reorder logic for sorted records.
- The agent MUST syntax-check the `.user.js` with Node's `vm.Script` before MCP deployment.
- The agent MUST complete the MCP deployment verification gate:
  - make the Tampermonkey Editors connection live;
  - complete the full MCP troubleshooting sequence if the connection is down;
  - run `tampermonkey.list` to resolve the target script path and current metadata;
  - run `tampermonkey.get` to capture the current source and `lastModified`;
  - apply the update with `tampermonkey.patch`, or create the script with `tampermonkey.put` if it does not exist yet;
  - run `tampermonkey.get` again and confirm the returned source contains the expected `@version` and intended content;
  - run `tampermonkey.list` again and confirm the script still appears under the expected name and path;
  - handle stale-write failures by re-running `tampermonkey.get`, merging intentionally, and retrying.
- The agent MUST complete the target-page verification gate after MCP deployment.
- For non-Boss-Zhipin targets, the agent MUST use the Google Chrome plugin and MUST:
  - refresh the target page;
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
  - refresh the target page through the visible Edge window if a refresh is required;
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
- If the required site-specific verification path is unavailable, the agent MUST report that MCP deployment verification completed but target-page verification did not complete.
- The agent MUST NOT use the words `ready`, `done`, `fixed`, `verified`, or equivalent completion claims unless static verification, MCP deployment verification, and the required target-page verification path all passed.

### Cleanup

- The agent MUST remove temporary screenshots and crops after testing.
- The agent MUST leave only source files and intentional tests in `git status`.
