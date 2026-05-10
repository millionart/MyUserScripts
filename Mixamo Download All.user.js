// ==UserScript==
// @name         Mixamo Download All With Resume
// @namespace    local.codex.mixamo
// @version      0.1.3
// @description  Download all Mixamo motions and motion packs with the currently selected uploaded character.
// @match        https://www.mixamo.com/*
// @connect      *
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const STATE_KEY = 'codex.mixamoDownloadAll.v1';
  const SCRIPT_VERSION = '0.1.3';
  const MAX_RETRIES = 4;
  const MONITOR_DELAY_MS = 2500;
  const PAGE_LIMIT = 96;
  const DEFAULT_CONCURRENCY = 2;
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 8;
  const globalObject = typeof window !== 'undefined' ? window : globalThis;

  let paused = false;
  let running = false;
  let ui = null;
  let uiSearch = null;
  let capturedCharacterId = '';
  let downloadWindow = null;

  function sanitizeName(value) {
    const cleaned = String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'Untitled';
  }

  function productName(product) {
    return sanitizeName(product.description || product.name || product.label || product.id);
  }

  function motionName(product) {
    return sanitizeName(product.name || product.label || product.description || product.id || product.product_id || product.motion_id);
  }

  function packName(product) {
    return sanitizeName(product.name || product.label || product.description || product.id);
  }

  function createStandaloneEntry(product) {
    const motionName = productName(product);
    return {
      key: `standalone/${product.id}`,
      id: product.id,
      productId: product.id,
      productType: 'Motion',
      packId: null,
      packName: 'Standalone',
      motionName,
      downloadName: `Standalone__${motionName}`,
    };
  }

  function createPackEntry(pack, motion) {
    const packNameValue = packName(pack);
    const motionNameValue = motionName(motion);
    const productId = motion.product_id || motion.productId || motion.id || motion.motion_id;
    const motionId = motion.motion_id || motion.motionId || motion.id || productId;
    return {
      key: `packs/${pack.id}/${productId}`,
      id: motionId,
      productId,
      productType: 'Motion',
      packId: pack.id,
      packName: packNameValue,
      motionName: motionNameValue,
      downloadName: `${packNameValue}__${motionNameValue}`,
    };
  }

  function resolveEntryDownloadName(entry, product) {
    if (entry && entry.packId && product) {
      return `${entry.packName}__${motionName(product)}`;
    }
    return entry.downloadName;
  }

  function filterPendingQueue(queue, state) {
    const completed = state && state.completed ? state.completed : {};
    return queue.filter((item) => !completed[item.key]);
  }

  function getRetryDelayMs(error, attempt) {
    const status = error && (error.status || error.statusCode);
    if (status === 429) {
      return Math.min(30000 * Math.pow(2, attempt), 300000);
    }
    return Math.min(5000 * Math.pow(2, attempt), 60000);
  }

  function extractCharacterIdFromText(value) {
    const text = String(value || '');
    const queryMatch = text.match(/[?&]character_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
    if (queryMatch) {
      return queryMatch[1];
    }
    const pathMatch = text.match(/\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[/?#]|$)/i);
    if (pathMatch) {
      return pathMatch[1];
    }
    const jsonMatch = text.match(/["']character[_-]?id["']\s*:\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})["']/i);
    if (jsonMatch) {
      return jsonMatch[1];
    }
    return '';
  }

  function rememberCharacterId(characterId) {
    if (!characterId || characterId === capturedCharacterId) {
      return;
    }
    capturedCharacterId = characterId;
    const state = loadState();
    state.characterId = characterId;
    saveState(state);
    if (ui && ui.characterInput) {
      ui.characterInput.value = characterId;
      ui.characterInput.style.display = 'none';
    }
    setStatus(`Captured character ${characterId}`);
  }

  function captureCharacterIdFromValue(value) {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return extractCharacterIdFromText(value);
    }
    if (typeof URL !== 'undefined' && value instanceof URL) {
      return extractCharacterIdFromText(value.href);
    }
    if (typeof Request !== 'undefined' && value instanceof Request) {
      return extractCharacterIdFromText(value.url);
    }
    try {
      return extractCharacterIdFromText(JSON.stringify(value));
    } catch (error) {
      return '';
    }
  }

  function installCharacterIdCapture() {
    if (globalObject.__mixamoDownloadAllCaptureInstalled) {
      return;
    }
    globalObject.__mixamoDownloadAllCaptureInstalled = true;

    const originalFetch = globalObject.fetch;
    if (typeof originalFetch === 'function') {
      globalObject.fetch = function patchedFetch(input, init) {
        rememberCharacterId(captureCharacterIdFromValue(input));
        if (init && init.body) {
          rememberCharacterId(captureCharacterIdFromValue(init.body));
        }
        return originalFetch.apply(this, arguments);
      };
    }

    const Xhr = globalObject.XMLHttpRequest;
    if (Xhr && Xhr.prototype) {
      const originalOpen = Xhr.prototype.open;
      const originalSend = Xhr.prototype.send;
      Xhr.prototype.open = function patchedOpen(method, url) {
        this.__mixamoDownloadAllUrl = url;
        rememberCharacterId(captureCharacterIdFromValue(url));
        return originalOpen.apply(this, arguments);
      };
      Xhr.prototype.send = function patchedSend(body) {
        rememberCharacterId(captureCharacterIdFromValue(this.__mixamoDownloadAllUrl));
        rememberCharacterId(captureCharacterIdFromValue(body));
        return originalSend.apply(this, arguments);
      };
    }
  }

  function getInitialUiModel() {
    return {
      characterInputVisible: false,
      statusVisible: false,
      buttonLabels: {
        crawl: 'Crawl',
        download: 'Download All',
        pause: 'Pause',
        reset: 'Reset',
        importDone: 'Import Done',
      },
    };
  }

  function defaultState() {
    return {
      version: 1,
      completed: {},
      failed: {},
      retryCounts: {},
      queue: [],
      characterId: '',
      preferences: { format: 'fbx7', skin: 'false', fps: '30', reducekf: '0' },
      concurrency: DEFAULT_CONCURRENCY,
      updatedAt: null,
    };
  }

  function getDownloadConcurrency(state) {
    const value = Number(state && state.concurrency);
    if (!Number.isFinite(value)) {
      return DEFAULT_CONCURRENCY;
    }
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(value)));
  }

  function loadState() {
    try {
      return Object.assign(defaultState(), JSON.parse(localStorage.getItem(STATE_KEY) || '{}'));
    } catch (error) {
      console.warn('[Mixamo Download All] Failed to read state; starting clean.', error);
      return defaultState();
    }
  }

  function saveState(state) {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    refreshUiCounts(state);
  }

  function resetState() {
    const state = loadState();
    const nextState = defaultState();
    nextState.characterId = state.characterId || '';
    nextState.completed = Object.fromEntries(
      Object.entries(state.completed || {}).filter((entry) => entry[1] && entry[1].source === 'imported-file'),
    );
    saveState(nextState);
  }


  function setStatus(message) {
    if (ui && ui.status) {
      ui.status.textContent = message;
      ui.status.title = message;
      ui.status.style.display = running || /character id|failed|error|pause|reset/i.test(message) ? 'inline-block' : 'none';
    }
    if (ui && ui.root) {
      ui.root.title = message;
    }
    console.log('[Mixamo Download All]', message);
  }

  function formatDownloadButtonLabel(state) {
    const queue = Array.isArray(state && state.queue) ? state.queue : [];
    if (!queue.length) {
      return 'Download All';
    }
    const completed = state && state.completed ? state.completed : {};
    const remaining = filterPendingQueue(queue, state).length;
    const completedCount = Object.keys(completed).length;
    return `Download All (${remaining}/${queue.length})`;
  }

  function refreshUiCounts(state) {
    if (ui && ui.downloadButton) {
      ui.downloadButton.textContent = formatDownloadButtonLabel(state || loadState());
    }
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') {
      return;
    }
    GM_registerMenuCommand('Set Mixamo Download Concurrency', () => {
      const state = loadState();
      const current = getDownloadConcurrency(state);
      const input = globalObject.prompt(
        `How many Mixamo files should download at the same time? (${MIN_CONCURRENCY}-${MAX_CONCURRENCY})`,
        String(current),
      );
      if (input === null) {
        return;
      }
      const next = getDownloadConcurrency({ concurrency: input });
      state.concurrency = next;
      saveState(state);
      setStatus(`Download concurrency set to ${next}.`);
    });
  }

  function authHeaders() {
    const bearer = localStorage.access_token;
    if (!bearer) {
      throw new Error('Mixamo access token was not found. Log in to Mixamo first.');
    }
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'X-Api-Key': 'mixamo2',
      'X-Requested-With': 'XMLHttpRequest',
    };
  }

  async function apiFetch(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const error = new Error(`Mixamo API returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function getAnimationList(page) {
    const url = `https://www.mixamo.com/api/v1/products?page=${page}&limit=${PAGE_LIMIT}&order=&type=Motion%2CMotionPack&query=`;
    return apiFetch(url, { method: 'GET', headers: authHeaders() });
  }

  async function getProduct(productId, characterId) {
    const url = `https://www.mixamo.com/api/v1/products/${productId}?similar=0&character_id=${encodeURIComponent(characterId)}`;
    return apiFetch(url, { method: 'GET', headers: authHeaders() });
  }

  async function exportAnimation(characterId, gmsHashArray, productNameForDownload, preferences) {
    return apiFetch('https://www.mixamo.com/api/v1/animations/export', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        character_id: characterId,
        gms_hash: gmsHashArray,
        preferences,
        product_name: productNameForDownload,
        type: 'Motion',
      }),
    });
  }

  async function monitorAnimation(characterId) {
    const url = `https://www.mixamo.com/api/v1/characters/${encodeURIComponent(characterId)}/monitor`;
    const msg = await apiFetch(url, { method: 'GET', headers: authHeaders() });
    if (msg.status === 'completed') {
      return msg.job_result;
    }
    if (msg.status === 'processing') {
      await wait(MONITOR_DELAY_MS);
      return monitorAnimation(characterId);
    }
    const error = new Error(`Mixamo export failed: ${msg.message || JSON.stringify(msg.job_result || msg)}`);
    error.status = msg.status;
    throw error;
  }

  function normalizeGmsHash(gmsHash) {
    if (!gmsHash || !Array.isArray(gmsHash.params)) {
      return gmsHash;
    }
    return Object.assign({}, gmsHash, {
      params: gmsHash.params.map((param) => param[1]).join(','),
    });
  }

  function createDownloadRequest(url, downloadName) {
    const name = /\.fbx$/i.test(downloadName) ? downloadName : `${downloadName}.fbx`;
    return { url, name };
  }

  function buildManifestExport(state) {
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const completed = state.completed || {};
    const failed = state.failed || {};
    return {
      exportedAt: new Date().toISOString(),
      version: state.version || 1,
      characterId: state.characterId || '',
      preferences: state.preferences || {},
      totalQueued: queue.length,
      totalCompleted: Object.keys(completed).length,
      totalFailed: Object.keys(failed).length,
      queue,
      completed,
      failed,
      missingFromCompleted: queue.filter((entry) => !completed[entry.key]),
    };
  }

  function normalizeDownloadedFileName(fileName) {
    return sanitizeName(String(fileName || '').replace(/\\/g, '/').split('/').pop().replace(/\.fbx$/i, '')).toLowerCase();
  }

  function normalizeDownloadedPath(fileName) {
    return String(fileName || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => sanitizeName(part.replace(/\.fbx$/i, '')).toLowerCase())
      .filter(Boolean)
      .join('/');
  }

  function organizedEntryPath(entry) {
    return `${sanitizeName(entry.packName).toLowerCase()}/${sanitizeName(entry.motionName).toLowerCase()}`;
  }

  function matchDownloadedFilesToQueue(fileNames, queue) {
    const entriesByDownloadName = new Map();
    const entriesByOrganizedPath = new Map();
    const entriesByMotionName = new Map();
    const ambiguousMotionNames = new Set();
    for (const entry of queue || []) {
      entriesByDownloadName.set(normalizeDownloadedFileName(entry.downloadName), entry);
      entriesByOrganizedPath.set(organizedEntryPath(entry), entry);
      const motionKey = sanitizeName(entry.motionName).toLowerCase();
      if (entriesByMotionName.has(motionKey)) {
        ambiguousMotionNames.add(motionKey);
      } else {
        entriesByMotionName.set(motionKey, entry);
      }
    }

    const matchedKeys = [];
    const matchedEntries = [];
    const unmatchedFiles = [];
    const seenKeys = new Set();

    for (const fileName of fileNames || []) {
      if (!/\.fbx$/i.test(String(fileName))) {
        unmatchedFiles.push(fileName);
        continue;
      }
      const normalizedPath = normalizeDownloadedPath(fileName);
      const normalizedName = normalizeDownloadedFileName(fileName);
      const entry = entriesByDownloadName.get(normalizedName)
        || entriesByOrganizedPath.get(normalizedPath)
        || (!ambiguousMotionNames.has(normalizedName) ? entriesByMotionName.get(normalizedName) : null);
      if (!entry) {
        unmatchedFiles.push(fileName);
        continue;
      }
      if (!seenKeys.has(entry.key)) {
        seenKeys.add(entry.key);
        matchedKeys.push(entry.key);
        matchedEntries.push(entry);
      }
    }

    return { matchedKeys, matchedEntries, unmatchedFiles };
  }

  function importDownloadedFilesIntoState(state, fileNames, queue) {
    const nextState = Object.assign(defaultState(), state || {});
    nextState.completed = Object.assign({}, nextState.completed || {});
    nextState.failed = Object.assign({}, nextState.failed || {});
    nextState.retryCounts = Object.assign({}, nextState.retryCounts || {});
    const result = matchDownloadedFilesToQueue(fileNames, queue || nextState.queue || []);
    const importedAt = new Date().toISOString();

    for (const entry of result.matchedEntries) {
      nextState.completed[entry.key] = {
        at: importedAt,
        source: 'imported-file',
        downloadName: entry.downloadName,
        packName: entry.packName,
        motionName: entry.motionName,
      };
      delete nextState.failed[entry.key];
      delete nextState.retryCounts[entry.key];
    }

    return {
      state: nextState,
      importedCount: result.matchedEntries.length,
      unmatchedFiles: result.unmatchedFiles,
      matchedKeys: result.matchedKeys,
    };
  }

  function applyCrawledQueueToState(state, queue, characterId) {
    const nextState = Object.assign(defaultState(), state || {});
    nextState.queue = Array.isArray(queue) ? queue : [];
    nextState.characterId = characterId || nextState.characterId || '';
    nextState.completed = Object.assign({}, nextState.completed || {});
    nextState.failed = {};
    nextState.retryCounts = {};
    return nextState;
  }

  function summarizeQueue(queue) {
    const packIds = new Set();
    let packAnimations = 0;
    let standalone = 0;
    for (const entry of queue || []) {
      if (entry.packId) {
        packAnimations += 1;
        packIds.add(entry.packId);
      } else {
        standalone += 1;
      }
    }
    return {
      total: (queue || []).length,
      standalone,
      packAnimations,
      packs: packIds.size,
    };
  }

  function formatCrawlStatus(summary) {
    return `Crawled ${summary.total} animation(s): ${summary.standalone} standalone, ${summary.packAnimations} from ${summary.packs} pack(s).`;
  }

  function selectDownloadedFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.fbx,model/fbx,application/octet-stream';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', () => {
        resolve(Array.from(input.files || []).map((file) => file.name));
        input.remove();
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  async function importDoneFiles() {
    if (running) {
      setStatus('Pause before importing completed files.');
      return;
    }
    const state = loadState();
    const fileNames = await selectDownloadedFiles();
    await finishImportDoneFiles(state, fileNames);
  }

  async function planImportDoneFlow(options) {
    const state = options.state || defaultState();
    const fileNames = await options.selectFiles();
    let queue = Array.isArray(state.queue) ? state.queue : [];
    if (queue.length === 0) {
      throw new Error('Crawl first before importing downloaded files.');
    }
    return importDownloadedFilesIntoState(state, fileNames, queue);
  }

  async function finishImportDoneFiles(state, fileNames) {
    if (!Array.isArray(state.queue) || state.queue.length === 0) {
      setStatus('Crawl first before importing downloaded files.');
      return;
    }
    const result = importDownloadedFilesIntoState(state, fileNames, state.queue);
    saveState(result.state);
    setStatus(`Imported ${result.importedCount} file(s); ${result.unmatchedFiles.length} unmatched.`);
  }

  async function crawlAllAnimations() {
    if (running) {
      setStatus('Pause before crawling.');
      return;
    }
    running = true;
    try {
      const state = loadState();
      const characterId = await resolveCharacterId();
      setStatus('Crawling full animation list...');
      const queue = await buildQueue(characterId);
      const nextState = applyCrawledQueueToState(state, queue, characterId);
      saveState(nextState);
      setStatus(formatCrawlStatus(summarizeQueue(queue)));
    } catch (error) {
      setStatus(error.message || String(error));
    } finally {
      running = false;
    }
  }

  function formatError(error) {
    if (!error) {
      return 'unknown error';
    }
    if (error.message) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch (jsonError) {
      return String(error);
    }
  }

  function formatRetryStatus(downloadName, error, delayMs) {
    return `Retrying ${downloadName} in ${Math.round(delayMs / 1000)}s: ${formatError(error)}`;
  }

  function downloadWithAnchor(request) {
    const anchor = document.createElement('a');
    anchor.href = request.url;
    anchor.download = request.name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return wait(1000);
  }

  function downloadWithGmDownload(request) {
    if (typeof GM_download !== 'function') {
      return Promise.reject(new Error('GM_download is not available'));
    }
    return new Promise((resolve, reject) => {
      GM_download({
        url: request.url,
        name: request.name,
        saveAs: false,
        onload: resolve,
        onerror: (error) => reject(new Error(`GM_download failed: ${formatError(error)}`)),
        ontimeout: () => reject(new Error('GM_download timed out')),
      });
    });
  }

  function downloadWithGmXhrBlob(request) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      return Promise.reject(new Error('GM_xmlhttpRequest is not available'));
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: request.url,
        responseType: 'blob',
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`GM_xmlhttpRequest download returned HTTP ${response.status}`));
            return;
          }
          const blobUrl = URL.createObjectURL(response.response);
          downloadWithAnchor({ url: blobUrl, name: request.name })
            .then(resolve, reject)
            .finally(() => URL.revokeObjectURL(blobUrl));
        },
        onerror: (error) => reject(new Error(`GM_xmlhttpRequest failed: ${formatError(error)}`)),
        ontimeout: () => reject(new Error('GM_xmlhttpRequest timed out')),
      });
    });
  }

  function downloadWithWindow(request) {
    if (downloadWindow && !downloadWindow.closed) {
      downloadWindow.location.href = request.url;
      return wait(1500);
    }
    return Promise.reject(new Error('Download window is not available'));
  }

  async function triggerDownload(url, downloadName) {
    const request = createDownloadRequest(url, downloadName);
    const errors = [];
    for (const strategy of [downloadWithGmDownload, downloadWithGmXhrBlob, downloadWithWindow]) {
      try {
        await strategy(request);
        return;
      } catch (error) {
        errors.push(formatError(error));
        console.warn('[Mixamo Download All] Download strategy failed:', errors[errors.length - 1]);
      }
    }
    throw new Error(`All download strategies failed: ${errors.join(' | ')}`);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isPackProduct(product) {
    const typeText = [
      product.type,
      product.product_type,
      product.productType,
      product.category,
      product.subtype,
    ].filter(Boolean).join(' ');
    const nameText = [
      product.name,
      product.label,
    ].filter(Boolean).join(' ');
    return /motion\s*pack|motionpack|\bpack\b/i.test(typeText)
      || /\bpack\b/i.test(nameText)
      || Boolean(product.num_animations || product.animation_count || product.animationCount || product.motion_count || product.motionCount)
      || (Array.isArray(product.motions) && product.motions.length > 0);
  }

  function isMotionProduct(product) {
    const type = String(product.type || product.product_type || product.productType || '');
    return type === 'Motion' || (!isPackProduct(product) && product.id);
  }

  function collectPackMotions(value, packId, seen) {
    if (!value || typeof value !== 'object') {
      return [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => collectPackMotions(item, packId, seen));
    }
    const found = [];
    if (value.id && value.id !== packId && isMotionProduct(value) && !seen.has(value.id)) {
      seen.add(value.id);
      found.push(value);
    }
    for (const key of Object.keys(value)) {
      if (['similar', 'character', 'characters'].includes(key)) {
        continue;
      }
      found.push(...collectPackMotions(value[key], packId, seen));
    }
    return found;
  }

  async function expandPack(product, characterId) {
    if (Array.isArray(product.motions) && product.motions.length > 0) {
      return product.motions.map((motion) => createPackEntry(product, motion));
    }
    const details = await getProduct(product.id, characterId);
    const motions = collectPackMotions(details, product.id, new Set());
    return motions.map((motion) => createPackEntry(product, motion));
  }

  async function buildQueue(characterId) {
    const queue = [];
    let page = 1;
    let totalPages = 1;
    do {
      setStatus(`Fetching product page ${page}/${totalPages}`);
      const json = await getAnimationList(page);
      totalPages = Number(json.pagination && json.pagination.num_pages) || totalPages;
      const products = Array.isArray(json.results) ? json.results : [];
      for (const product of products) {
        if (isPackProduct(product)) {
          queue.push(...await expandPack(product, characterId));
        } else if (isMotionProduct(product)) {
          queue.push(createStandaloneEntry(product));
        }
      }
      page += 1;
    } while (page <= totalPages);
    return queue;
  }

  function getSavedCharacterId() {
    const manual = ui && ui.characterInput ? ui.characterInput.value.trim() : '';
    if (manual) {
      return manual;
    }
    if (capturedCharacterId) {
      return capturedCharacterId;
    }
    return loadState().characterId || '';
  }

  function findUuidNearCharacter(text) {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
    const matches = String(text || '').match(uuidPattern) || [];
    return matches[0] || '';
  }

  function detectCharacterIdFromStorage() {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!/character|mixamo|redux|state|user/i.test(key || '')) {
          continue;
        }
        const value = storage.getItem(key);
        if (/character/i.test(value || '')) {
          const uuid = findUuidNearCharacter(value);
          if (uuid) {
            return uuid;
          }
        }
      }
    }
    return '';
  }

  async function resolveCharacterId() {
    const saved = getSavedCharacterId();
    if (saved) {
      return saved;
    }
    const detected = detectCharacterIdFromStorage();
    if (detected) {
      return detected;
    }
    throw new Error('Could not detect the current character ID. Refresh Mixamo once, then select your uploaded character or open the native Download dialog so this userscript can capture Mixamo\'s own character_id request.');
  }

  function showManualCharacterInput(message) {
    if (ui && ui.characterInput) {
      ui.characterInput.style.display = 'inline-block';
      ui.characterInput.focus();
    }
    setStatus(message);
  }

  async function downloadEntry(entry, characterId, state) {
    const product = await getProduct(entry.productId, characterId);
    const gmsHash = product && product.details && product.details.gms_hash;
    if (!gmsHash) {
      throw new Error(`Product ${entry.productId} did not include a gms_hash.`);
    }
    const downloadName = resolveEntryDownloadName(entry, product);
    await exportAnimation(characterId, [normalizeGmsHash(gmsHash)], downloadName, state.preferences);
    const url = await monitorAnimation(characterId);
    await triggerDownload(url, downloadName);
    return downloadName;
  }

  async function runWithRetries(entry, characterId, state) {
    const previousAttempts = state.retryCounts[entry.key] || 0;
    for (let attempt = previousAttempts; attempt < MAX_RETRIES; attempt += 1) {
      if (paused) {
        throw new Error('Paused');
      }
      try {
        const downloadName = await downloadEntry(entry, characterId, state);
        delete state.failed[entry.key];
        delete state.retryCounts[entry.key];
        state.completed[entry.key] = {
          at: new Date().toISOString(),
          downloadName,
          packName: entry.packName,
          motionName: entry.motionName,
        };
        saveState(state);
        return;
      } catch (error) {
        state.retryCounts[entry.key] = attempt + 1;
        state.failed[entry.key] = {
          at: new Date().toISOString(),
          attempts: attempt + 1,
          reason: error.message || String(error),
          status: error.status || null,
        };
        saveState(state);
        if (attempt + 1 >= MAX_RETRIES) {
          throw error;
        }
        const delay = getRetryDelayMs(error, attempt);
        setStatus(formatRetryStatus(entry.downloadName, error, delay));
        await wait(delay);
      }
    }
  }

  async function runConcurrentQueue(options) {
    const entries = Array.isArray(options.entries) ? options.entries : [];
    const concurrency = getDownloadConcurrency({ concurrency: options.concurrency });
    let nextIndex = 0;
    let finished = 0;
    let started = 0;

    async function worker() {
      while (nextIndex < entries.length && !options.isPaused()) {
        const entry = entries[nextIndex];
        nextIndex += 1;
        started += 1;
        options.onProgress(entry, started, entries.length);
        try {
          await options.runEntry(entry);
        } catch (error) {
          options.onEntryError(entry, error);
        } finally {
          finished += 1;
        }
      }
    }

    const workerCount = Math.min(concurrency, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { finished, total: entries.length };
  }

  async function startDownloadAll() {
    if (running) {
      return;
    }
    running = true;
    paused = false;
    if (!downloadWindow || downloadWindow.closed) {
      downloadWindow = window.open('', 'mixamo-download-all');
    }
    try {
      const state = loadState();
      const characterId = await resolveCharacterId();
      state.characterId = characterId;
      if (ui && ui.characterInput) {
        ui.characterInput.value = characterId;
      }
      if (!Array.isArray(state.queue) || state.queue.length === 0) {
        state.queue = await buildQueue(characterId);
        saveState(state);
      }
      const pending = filterPendingQueue(state.queue, state);
      const concurrency = getDownloadConcurrency(state);
      const result = await runConcurrentQueue({
        entries: pending,
        concurrency,
        isPaused: () => paused,
        onProgress: (entry, started, total) => {
          setStatus(`Downloading ${started}/${total} (${concurrency} parallel): ${entry.downloadName}`);
        },
        runEntry: (entry) => runWithRetries(entry, characterId, state),
        onEntryError: (entry, error) => {
          if (!paused) {
            console.warn('[Mixamo Download All] Skipping after retries:', entry, error);
          }
        },
      });
      if (paused) {
        setStatus(`Paused after ${result.finished}/${pending.length}`);
      }
      if (!paused) {
        setStatus('Finished queue. Check failed records before resetting.');
      }
    } catch (error) {
      const message = error.message || String(error);
      if (/character id/i.test(message)) {
        showManualCharacterInput(message);
      } else {
        setStatus(message);
      }
    } finally {
      running = false;
    }
  }

  function positionUi() {
    if (!ui || !ui.root || !uiSearch) {
      return;
    }
    const parent = ui.root.offsetParent || uiSearch.offsetParent || uiSearch.parentElement;
    const left = uiSearch.offsetLeft + uiSearch.offsetWidth + 10;
    const top = uiSearch.offsetTop + Math.max(0, Math.floor((uiSearch.offsetHeight - 30) / 2));
    ui.root.style.left = `${left}px`;
    ui.root.style.top = `${top}px`;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
  }

  function insertUi() {
    if (ui || !document.body) {
      return;
    }
    const search = document.querySelector('input[name="search"], input[type="search"]');
    if (!search || !search.parentElement) {
      return;
    }

    const root = document.createElement('div');
    root.id = 'codex-mixamo-download-all';
    root.dataset.version = SCRIPT_VERSION;
    root.style.cssText = [
      'position:absolute',
      'z-index:10000',
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'height:30px',
      'white-space:nowrap',
      'font:12px Arial,sans-serif',
      'color:#e8e8e8',
    ].join(';');

    const characterInput = document.createElement('input');
    characterInput.placeholder = 'Character ID';
    characterInput.title = 'Current uploaded Mixamo character ID. Used only if automatic detection fails.';
    characterInput.style.cssText = 'display:none;width:220px;height:28px;padding:2px 6px;background:#111;color:#eee;border:1px solid #777;';
    characterInput.value = loadState().characterId || '';

    const crawlButton = document.createElement('button');
    crawlButton.type = 'button';
    crawlButton.textContent = getInitialUiModel().buttonLabels.crawl;
    crawlButton.title = 'Crawl and save the full Mixamo animation list without downloading.';
    crawlButton.style.cssText = 'height:30px;min-width:58px;padding:0 10px;cursor:pointer;background:#1f1f1f;color:#eee;border:1px solid #867b67;';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.textContent = formatDownloadButtonLabel(loadState());
    downloadButton.title = `Download all Mixamo motions and packs using the current uploaded character. Script ${SCRIPT_VERSION}.`;
    downloadButton.style.cssText = 'height:30px;min-width:128px;padding:0 10px;cursor:pointer;background:#1f1f1f;color:#eee;border:1px solid #867b67;line-height:14px;';

    const pauseButton = document.createElement('button');
    pauseButton.type = 'button';
    pauseButton.textContent = getInitialUiModel().buttonLabels.pause;
    pauseButton.title = 'Pause after the current Mixamo request finishes.';
    pauseButton.style.cssText = 'height:30px;min-width:64px;padding:0 10px;cursor:pointer;background:#1f1f1f;color:#eee;border:1px solid #867b67;';

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.textContent = getInitialUiModel().buttonLabels.reset;
    resetButton.title = 'Reset queue, failed items, and retry counts while keeping imported completed files.';
    resetButton.style.cssText = 'height:30px;min-width:58px;padding:0 10px;cursor:pointer;background:#1f1f1f;color:#eee;border:1px solid #867b67;';

    const importDoneButton = document.createElement('button');
    importDoneButton.type = 'button';
    importDoneButton.textContent = getInitialUiModel().buttonLabels.importDone;
    importDoneButton.title = 'Select already downloaded FBX files and mark matching queue entries as completed.';
    importDoneButton.style.cssText = 'height:30px;min-width:92px;padding:0 10px;cursor:pointer;background:#1f1f1f;color:#eee;border:1px solid #867b67;';

    const status = document.createElement('span');
    status.textContent = '';
    status.style.cssText = 'display:none;max-width:260px;height:30px;line-height:30px;padding:0 8px;background:rgba(0,0,0,.78);border:1px solid #867b67;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

    root.append(characterInput, crawlButton, importDoneButton, downloadButton, pauseButton, resetButton, status);
    const host = search.offsetParent || search.parentElement || document.body;
    host.appendChild(root);

    ui = { root, characterInput, crawlButton, downloadButton, pauseButton, resetButton, importDoneButton, status };
    uiSearch = search;
    positionUi();
    globalObject.addEventListener('resize', positionUi);
    crawlButton.addEventListener('click', crawlAllAnimations);
    downloadButton.addEventListener('click', startDownloadAll);
    pauseButton.addEventListener('click', () => {
      paused = true;
      setStatus('Pausing after current request finishes...');
    });
    resetButton.addEventListener('click', () => {
      if (running) {
        setStatus('Pause before resetting record.');
        return;
      }
      resetState();
      characterInput.value = '';
      characterInput.style.display = 'none';
      setStatus('Progress reset; imported completed files kept.');
    });
    importDoneButton.addEventListener('click', () => {
      importDoneFiles().catch((error) => setStatus(error.message || String(error)));
    });
  }

  function boot() {
    insertUi();
    const observer = new MutationObserver(insertUi);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  globalObject.__mixamoDownloadAllTest = {
    sanitizeName,
    createStandaloneEntry,
    createPackEntry,
    resolveEntryDownloadName,
    isPackProduct,
    filterPendingQueue,
    getRetryDelayMs,
    getInitialUiModel,
    extractCharacterIdFromText,
    createDownloadRequest,
    formatRetryStatus,
    buildManifestExport,
    matchDownloadedFilesToQueue,
    importDownloadedFilesIntoState,
    planImportDoneFlow,
    formatDownloadButtonLabel,
    getDownloadConcurrency,
    runConcurrentQueue,
    applyCrawledQueueToState,
    summarizeQueue,
    formatCrawlStatus,
  };

  installCharacterIdCapture();
  registerMenuCommands();

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
})();
