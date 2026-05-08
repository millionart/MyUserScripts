# Project Agent Notes

## Google Chrome Control + Tampermonkey Workflow

These notes capture the working pattern used for testing Tampermonkey userscripts against sites that block DevTools or synthetic browser behavior.

### Browser Automation Tooling

- Prefer Codex's computer-control Google Chrome plugin for browser automation, DOM reads, page evaluation, navigation, screenshots, clicks, and Tampermonkey installation/testing workflows.
- Do not use older browser-control workflows or refer to verification through deprecated browser tooling in this project. The active browser path is direct Google Chrome control through Codex computer control.
- The normal fallback for browser-level verification is still to use the Google Chrome plugin's visible-page and interaction tools. Use OS-level automation only for browser/extension surfaces that Chrome itself blocks from scripted inspection, such as Tampermonkey's protected confirmation page.

### Installing Or Updating Userscripts

- Prefer serving the `.user.js` file from a temporary local HTTP server, then navigate Google Chrome to the localhost URL:

  ```powershell
  python -m http.server 17893 --bind 127.0.0.1
  ```

  Open:

  ```text
  http://localhost:17893/Script%20Name.user.js
  ```

- Prefer `localhost` in browser navigation for the userscript install URL. If that fails, try `127.0.0.1` and verify the server separately from PowerShell.
- If `python` is unavailable or unreliable, create a temporary Node HTTP server script in the project directory and remove it after testing. Keep it read-only, bound to `127.0.0.1`, scoped to the project directory, and preferably restricted to `.user.js` files. Starting `node -e ...` through `Start-Process` can fail because inline quoting is fragile; a temporary `.cjs` server file is the verified fallback.
- If the Codex sandbox prevents the browser or Tampermonkey from reaching the local server, start the HTTP server outside the sandbox through the approval flow. Verify the server from PowerShell with `Invoke-WebRequest` before opening it in Google Chrome.
- Tampermonkey extension pages such as `chrome-extension://.../ask.html` may block DOM reads, page JavaScript injection, and selector clicks because extension pages are protected browser surfaces.
- For Tampermonkey's install/update confirmation page, first try the Google Chrome plugin's visible-page interaction tools, including screenshots and coordinate clicks. If those cannot access or operate the confirmation page, use OS-level UI automation or an OS-level screenshot with a narrowly targeted coordinate click. Reconfirm button coordinates from a fresh screenshot before clicking if the browser window may have moved, and report that this confirmation click used OS-level fallback.
- When the problem might be a stale installed userscript, bump the userscript `@version` before installing. Add a lightweight page-visible version marker, such as a toolbar `data-version`, when practical so the browser verification can confirm which userscript copy is actually running after refresh.
- Do not edit Tampermonkey's extension storage files, LevelDB, IndexedDB, or browser profile state while the browser is running. Treat that as high-risk browser application state.
- Directly patching Tampermonkey LevelDB/IndexedDB is usually the wrong automation path: Edge may already have the profile open, the storage format is not a normal script file, and forced writes risk corrupting extension data. A temporary localhost `.user.js` install flow plus OS-level confirmation is safer and easier to audit.
- Stop the temporary HTTP server and remove screenshots/logs after installation testing.

### Browser Testing On Protected Sites

- For sites that block F12 or DevTools, use the Google Chrome plugin's page reads and JavaScript evaluation instead of opening DevTools.
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

- For this BOSS Zhipin userscript, do not finish after static tests only. Before declaring the task complete, actually install or update `BOSS Zhipin Job Tools.user.js` through Tampermonkey using Google Chrome, then refresh the BOSS Zhipin page and verify the requested behavior through the browser.
- Extract pure logic into a small CommonJS helper when practical, and cover it with `node --test`.
- At minimum, test:
  - ID extraction from page URLs.
  - active-time ranking and tie ordering.
  - choosing the next visible item after ignore.
  - storage normalization/serialization.
  - framework list reorder logic for sorted records.
- Also syntax-check the `.user.js` with Node's `vm.Script` so userscript syntax errors are caught before browser installation.
- After installing through Tampermonkey, refresh the target page and verify real behavior in Google Chrome:
  - the toolbar or another page-visible marker shows the expected userscript version when a version marker exists;
  - toolbar placement does not create layout gaps;
  - ignore hides the current item and activates the next visible item;
  - refresh does not leave details focused on a hidden ignored item;
  - show/hide ignored toggles visibility without clearing storage;
  - hidden keyword filters hide both title matches and job-card tag/keyword matches;
  - sorting changes the rendered order and survives the site's framework re-render.

### Cleanup

- Remove temporary screenshots, crops, and local server logs after testing.
- Stop any local HTTP server started for Tampermonkey installation.
- Leave only source files and intentional tests in `git status`.
