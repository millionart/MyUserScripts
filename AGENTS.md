# Project Agent Notes

## Chrome MCP + Tampermonkey Workflow

These notes capture the working pattern used for testing Tampermonkey userscripts against sites that block DevTools or synthetic browser behavior.

### MCP Tool Restrictions

- This project should use Chrome MCP for browser automation, browser DOM reads, page evaluation, navigation, screenshots, clicks, and Tampermonkey installation/testing workflows.
- Do not use Windows MCP, Edge automation, Playwright, generic desktop automation, or any other MCP as a substitute for Chrome MCP browser/site verification.
- The only allowed fallback is the narrow OS-level Tampermonkey confirmation-page exception below. If Chrome MCP is not available for the browser/site verification itself, stop and report that the required verification cannot be completed. Do not claim Chrome MCP verification was done through another tool.

### Installing Or Updating Userscripts

- Prefer serving the `.user.js` file from a temporary local HTTP server, then navigate Chrome MCP to the localhost URL:

  ```powershell
  python -m http.server 17893 --bind 127.0.0.1
  ```

  Open:

  ```text
  http://localhost:17893/Script%20Name.user.js
  ```

- Use `localhost` in Chrome MCP navigation. In this environment, `127.0.0.1` may be rewritten into an invalid browser URL pattern by the MCP navigation layer.
- If the Codex sandbox prevents the browser or Tampermonkey from reaching the local server, start the HTTP server outside the sandbox through the approval flow. Keep it read-only, bound to `127.0.0.1`, and scoped to the project directory.
- Tampermonkey extension pages such as `chrome-extension://.../ask.html` usually block content-script DOM reads, page JavaScript injection, and selector/ref clicks from Chrome MCP because another extension's page is protected.
- For Tampermonkey's install/update confirmation page, first try Chrome MCP tab-level interaction paths: `chrome_computer` with `action="screenshot"`, `chrome_screenshot` without full-page/selector options, and coordinate clicks. If those cannot access or operate the confirmation page, use OS-level UI automation or an OS-level screenshot with a narrowly targeted coordinate click as the only fallback exception. Reconfirm button coordinates from a fresh screenshot before clicking if the browser window may have moved, and report that this confirmation click used the OS fallback rather than Chrome MCP.
- Do not edit Tampermonkey's extension storage files, LevelDB, IndexedDB, or browser profile state while the browser is running. Treat that as high-risk browser application state.
- Directly patching Tampermonkey LevelDB/IndexedDB is usually the wrong automation path: Edge may already have the profile open, the storage format is not a normal script file, and forced writes risk corrupting extension data. A temporary localhost `.user.js` install flow plus OS-level confirmation is safer and easier to audit.
- Stop the temporary HTTP server and remove screenshots/logs after installation testing.

### Browser Testing On Protected Sites

- For sites that block F12 or DevTools, use Chrome MCP page reads and JavaScript evaluation instead of opening DevTools.
- When adding or changing page UI, first reuse or mirror the target page's existing styles: nearby classes, spacing, button sizes, borders, colors, hover/disabled states, and placement patterns. Add only the minimum custom CSS needed for the userscript-specific controls.
- If normal DOM clicks do not trigger site behavior, inspect page-owned framework state from the page context. On BOSS Zhipin, job cards expose Vue instances through `card.__vue__` in the page world.
- Prefer the site's own framework methods over untrusted synthetic events. For BOSS Zhipin, activating a job card worked reliably through Vue methods such as `clickJobCardAction(jobData)`, `clickJobCard(jobData)`, or `loadJobDetail(jobData)`.
- Tampermonkey runs in an isolated userscript world. Page-owned objects such as Vue `__vue__` may not be directly usable from the userscript. Add `@grant unsafeWindow` when page-world access is needed.
- If direct `unsafeWindow` access is not enough, inject a tiny page-world bridge script and communicate via `CustomEvent`. Keep the bridge narrow: pass simple JSON payloads such as sorted job IDs, and let the page context mutate page-owned Vue state.
- When testing sorting or stateful UI behavior, verify both the visible DOM and the framework state if possible. A direct DOM reorder can be reverted by the site's framework re-render; for Vue-backed lists, reorder the Vue `jobList` and use DOM movement only as a fallback.

### Tampermonkey Storage

- Store user data with `GM_getValue` and `GM_setValue`, not `localStorage`, when the data should be available for Tampermonkey cloud sync.
- Keep stored values JSON-serializable and keyed by stable IDs. For job-ignore scripts, store ignored jobs and active-time cache as plain objects keyed by job ID.
- It is useful to keep a `localStorage` fallback only for degraded environments, but Tampermonkey storage should be the primary path.

### Verification Pattern

- For this BOSS Zhipin userscript, do not finish after static tests only. Before declaring the task complete, actually install or update `BOSS Zhipin Job Tools.user.js` through Tampermonkey using Chrome MCP, then refresh the BOSS Zhipin page and verify the requested behavior with Chrome MCP.
- Extract pure logic into a small CommonJS helper when practical, and cover it with `node --test`.
- At minimum, test:
  - ID extraction from page URLs.
  - active-time ranking and tie ordering.
  - choosing the next visible item after ignore.
  - storage normalization/serialization.
  - framework list reorder logic for sorted records.
- Also syntax-check the `.user.js` with Node's `vm.Script` so userscript syntax errors are caught before browser installation.
- After installing through Tampermonkey, refresh the target page and verify real behavior with Chrome MCP:
  - toolbar placement does not create layout gaps;
  - ignore hides the current item and activates the next visible item;
  - refresh does not leave details focused on a hidden ignored item;
  - show/hide ignored toggles visibility without clearing storage;
  - sorting changes the rendered order and survives the site's framework re-render.

### Cleanup

- Remove temporary screenshots, crops, and local server logs after testing.
- Stop any local HTTP server started for Tampermonkey installation.
- Leave only source files and intentional tests in `git status`.
