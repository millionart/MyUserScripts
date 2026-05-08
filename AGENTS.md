# Project Agent Notes

## Browser Control + Tampermonkey Workflow

These notes capture the working pattern used for testing Tampermonkey userscripts against sites that block DevTools or synthetic browser behavior.

### Browser Automation Tooling

- Keep browser responsibilities separated. Use Windows UI Automation only for browser/plugin surfaces such as Tampermonkey install/update pages. Use Codex's computer-control Google Chrome plugin for the target website itself.
- Use the Google Chrome plugin for all target-page work: visual inspection, page navigation, screenshots, clicks, form input, layout checks, and confirming whether userscript UI matches the live page.
- Use a real browser window plus Windows UI Automation for Tampermonkey installation/update confirmation. Keep OS-level automation narrowly scoped to the extension window/button; avoid broad desktop screenshots unless explicitly approved.
- Report verification by surface. Say which tool installed or updated the script, and separately say that target-page behavior was verified through the Google Chrome plugin. If only static tests were run, say so.

### Google Chrome Control Plan

- Use the Google Chrome plugin for the actual target website after installation. This includes refreshing the page, clicking page items or controls, clicking userscript buttons, checking layout, and capturing screenshots.
- Do not assume the backend can be acquired with `agent.browsers.get('chrome')`. First call `agent.browsers.list()`, find the browser descriptor with `type: "extension"` and `name: "Chrome"`, then call `agent.browsers.get(descriptor.id)`. In this environment that "Chrome" extension backend may control Microsoft Edge tabs.
- If Chrome-specific local detection scripts report no Google Chrome install, do not conclude the extension backend is unavailable. Those scripts check Google Chrome paths and registry keys; they can be misleading when the Codex Chrome Extension backend is attached to Edge.
- Verify page behavior from the user's perspective first: visible version markers, toolbar placement, button text, style consistency, hidden/visible item changes, active or selected item changes, and visible status text.
- When userscript behavior depends on page internals, prefer adding page-visible debug markers or status text that the Google Chrome plugin can observe. Do not switch to extension-page or browser-debugging tools for target-page JavaScript evaluation just to inspect internals.
- For visual style changes, compare against nearby native target-page controls and reuse the page's spacing, colors, borders, sizes, and interaction patterns.

### Tampermonkey Install/Update Window Flow

- Do not use Codex Chrome `tabs.new()` for Tampermonkey install/update verification. It can open inside the current tab group and may route through Tampermonkey's public `script_installation.php` page or a blocked localhost page instead of the real extension confirmation page.
- Start a temporary read-only local HTTP server from the project directory, verify the `.user.js` URL with PowerShell `Invoke-WebRequest`, and record the server PID for cleanup.
- Open the `.user.js` URL in a real browser new window through OS process launch, such as `msedge.exe --new-window http://localhost:17893/Script%20Name.user.js`. On this machine Edge is the available Chrome-compatible browser and may be controlled by the Codex "Chrome" extension backend.
- Use Windows UI Automation only for protected extension UI that browser tools cannot access, especially Tampermonkey's Install/Update confirmation page.
- Prefer locating the Tampermonkey window and invoking a button by accessible name such as `更新`, `Update`, `安装`, or `Install`.
- After invoking the button, confirm the Tampermonkey confirmation window closes or changes state. When practical, read the installed-scripts page with Windows UI Automation and verify the target script name and `@version`.
- If accessible button invocation fails, use a narrowly targeted coordinate click based on the extension window bounds. Avoid full-desktop screenshots unless the user explicitly approves the privacy risk.
- Never use Windows UI Automation as a substitute for validating target-page behavior. After installation/update is complete, switch back to the Google Chrome plugin for the target website.

### Installing Or Updating Userscripts

- Do not assume browser automation APIs will accept a `localhost` or `127.0.0.1` `.user.js` URL for installation. Browser-tool navigation can land on Tampermonkey's public `script_installation.php` page or be blocked by the browser/client instead of opening the extension update confirmation page.
- A temporary local HTTP server plus real browser new-window launch is the verified Tampermonkey install/update path on this machine.
- For Tampermonkey install/update, use the local HTTP server plus real browser new-window flow first. If that cannot open the real Tampermonkey confirmation window, switch to direct extension/editor workflows such as opening the existing script in Tampermonkey's editor and replacing its contents through browser/clipboard automation. If that cannot be automated safely, give the user the script content or exact file path to paste manually.
- If a local HTTP server is used for a check, keep it temporary and read-only:

  ```powershell
  python -m http.server 17893 --bind 127.0.0.1
  ```

  Open:

  ```text
  http://localhost:17893/Script%20Name.user.js
  ```

- If a localhost userscript URL fails, do not keep retrying equivalent localhost variants. Record whether it opened Tampermonkey's extension confirmation page, a public Tampermonkey web page, a browser-blocked page, or the raw script text, then switch to the editor/manual update path.
- If `python` is unavailable or unreliable, create a temporary Node HTTP server script in the project directory and remove it after testing. Keep it read-only, bound to `127.0.0.1`, scoped to the project directory, and preferably restricted to `.user.js` files. Starting `node -e ...` through `Start-Process` can fail because inline quoting is fragile; a temporary `.cjs` server file is the verified fallback.
- If the Codex sandbox prevents the browser or Tampermonkey from reaching the local server, start the HTTP server outside the sandbox through the approval flow. Verify the server from PowerShell with `Invoke-WebRequest` before opening it in the real browser new window.
- Tampermonkey extension pages such as `chrome-extension://.../ask.html` may block DOM reads, page JavaScript injection, and selector clicks because extension pages are protected browser surfaces.
- For Tampermonkey's install/update confirmation page, use Windows UI Automation to invoke the accessible confirmation button. Reconfirm button coordinates from the extension window bounds if fallback coordinate clicking is needed, and report which path was used for this confirmation click.
- When the problem might be a stale installed userscript, bump the userscript `@version` before installing. Add a lightweight page-visible version marker, such as a toolbar `data-version`, when practical so the browser verification can confirm which userscript copy is actually running after refresh.
- Do not edit Tampermonkey's extension storage files, LevelDB, IndexedDB, or browser profile state while the browser is running. Treat that as high-risk browser application state.
- Directly patching Tampermonkey LevelDB/IndexedDB is usually the wrong automation path: Edge may already have the profile open, the storage format is not a normal script file, and forced writes risk corrupting extension data. A temporary localhost `.user.js` install flow plus OS-level confirmation is safer and easier to audit.
- Stop the temporary HTTP server and remove screenshots/logs after installation testing.

### Browser Testing On Protected Sites

- For sites that block F12 or DevTools, use the Google Chrome plugin to operate and inspect the target page from the visible browser UI instead of opening DevTools.
- When adding or changing page UI, first reuse or mirror the target page's existing styles: nearby classes, spacing, button sizes, borders, colors, hover/disabled states, and placement patterns. Add only the minimum custom CSS needed for the userscript-specific controls.
- If normal DOM clicks do not trigger site behavior, inspect page-owned framework state from the page context when available. Some sites expose framework instances on DOM nodes, such as Vue `__vue__`, React props, or site-specific data stores.
- Prefer the site's own framework methods over untrusted synthetic events when those methods can be identified safely. Keep site-specific activation logic scoped to the relevant userscript and document it near the implementation or test that depends on it.
- Tampermonkey runs in an isolated userscript world. Page-owned objects such as Vue `__vue__` may not be directly usable from the userscript. Add `@grant unsafeWindow` when page-world access is needed.
- If direct `unsafeWindow` access is not enough, inject a tiny page-world bridge script and communicate via `CustomEvent`. Keep the bridge narrow: pass simple JSON payloads such as sorted record or item IDs, and let the page context mutate page-owned framework state.
- When testing sorting or stateful UI behavior, verify both the visible DOM and the framework state if possible. A direct DOM reorder can be reverted by the site's framework re-render; for framework-backed lists, update the page-owned list data and use DOM movement only as a fallback.

### Tampermonkey Storage

- Store user data with `GM_getValue` and `GM_setValue`, not `localStorage`, when the data should be available for Tampermonkey cloud sync.
- Keep stored values JSON-serializable and keyed by stable IDs. For scripts that hide or ignore records, store hidden records and cached metadata as plain objects keyed by record or item ID.
- It is useful to keep a `localStorage` fallback only for degraded environments, but Tampermonkey storage should be the primary path.

### Verification Pattern

- After completing any userscript compile/edit cycle, automatically run the full verification flow below before declaring the script ready. This applies to every target website and every userscript edited in this project, including CSS-only changes. Do not stop after static checks when the browser/Tampermonkey flow is available. If a required tool or target page is unavailable, stop at the last completed step and state exactly which verification layer could not be completed and why.
- Extract pure logic into a small CommonJS helper when practical, and cover it with `node --test`.
- At minimum, test:
  - ID extraction from page URLs.
  - ranking or sorting logic and tie ordering relevant to the feature.
  - choosing the next visible item after hide, ignore, or removal actions.
  - storage normalization/serialization.
  - framework list reorder logic for sorted records.
- Also syntax-check the `.user.js` with Node's `vm.Script` so userscript syntax errors are caught before browser installation.
- Installation verification is required after static tests:
  - start a temporary read-only localhost HTTP server from the project directory;
  - verify the `.user.js` URL with PowerShell `Invoke-WebRequest`;
  - open the local `.user.js` URL in a real browser new window, for example with `msedge.exe --new-window`;
  - use Windows UI Automation to click Tampermonkey's `更新` / `Update` / `安装` / `Install` button;
  - confirm the Tampermonkey install/update window closes or otherwise indicates completion;
  - when practical, verify the installed-scripts page lists the expected script name and version;
  - stop the local HTTP server and remove temporary logs.
- After installing through Tampermonkey, refresh the target page and verify real behavior through the Google Chrome plugin:
  - the toolbar or another page-visible marker shows the expected userscript version when a version marker exists;
  - toolbar placement does not create layout gaps;
  - custom toolbar controls visually match neighboring native page controls;
  - detail-pane action buttons visually match the scale and spacing of neighboring native action buttons, except for intentional destructive coloring;
  - hide, ignore, or removal actions hide the current item and activate the next visible item when the feature promises that behavior;
  - feedback toasts show a visible undo action when undo is part of the feature;
  - refresh does not leave details focused on a hidden or ignored item;
  - show/hide toggles change visibility without clearing stored state;
  - hidden keyword filters hide both title matches and item-card tag or keyword matches;
  - sorting changes the rendered order and survives the site's framework re-render.
- Do not use extension-page or browser-debugging tools for the target-page verification step. If the Google Chrome plugin is unavailable in the current session, report that installation verification was completed but page-level verification could not be performed under the required tool separation.

### Cleanup

- Remove temporary screenshots, crops, and local server logs after testing.
- Stop any local HTTP server started for Tampermonkey installation.
- Leave only source files and intentional tests in `git status`.
