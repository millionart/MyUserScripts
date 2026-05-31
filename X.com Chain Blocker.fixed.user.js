// ==UserScript==
// @name         X.com Chain Blocker
// @name:zh-CN   X.com 九族拉黑
// @namespace    http://tampermonkey.net/
// @version      2.14.29
// @description  Block author, retweeters, repliers, and auto-block users based on rules (length, content, keywords, follower count). Manage block log, whitelist, and settings in a panel.
// @description:zh-CN 当拉黑作者时，自动拉黑所有转推者和回复者。支持根据长度、内容、关键词、长用户名粉丝数等规则自动拉黑，并提供黑/白名单管理面板。
// @author       Gemini 2.5 Pro
// @license      MIT
// @match        *://x.com/*
// @match        *://twitter.com/*
// @exclude      *://x.com/settings*
// @exclude      *://twitter.com/settings*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @grant        GM_getResourceURL
// @grant        unsafeWindow
// @resource     tesseractWorker https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js
// @resource     esearchOcr https://cdn.jsdelivr.net/npm/esearch-ocr@5.1.5/dist/esearch-ocr.js
// @connect      api.x.com
// @connect      x.com
// @connect      pbs.twimg.com
// @connect      abs.twimg.com
// @connect      cdn.jsdelivr.net
// @connect      tessdata.projectnaptha.com
// @connect      docs.opencv.org
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// ==/UserScript==
(function () {
'use strict';
// --- CONFIG & CONSTANTS ---
const MENU_ITEM_TEXT = "九族拉黑";
const STORAGE_KEY = 'CHAIN_BLOCKER_DATA';
const CONFIG_STORAGE_KEY = 'CHAIN_BLOCKER_CONFIG';
const BLOCK_INTERVAL_MS = 10 * 1000;
const PROCESS_CHECK_INTERVAL_MS = 5 * 1000;
const USERNAME_LENGTH_THRESHOLD = 25;
const DEFAULT_LONG_NAME_FOLLOWER_EXEMPT_THRESHOLD = 500;
const BLOCK_CONTEXT_TEXT_MAX = 120;
const DEFAULT_SPAM_IDENTIFY_MIN_SCORE = 3;
const AVATAR_OCR_CACHE_MS = 30 * 60 * 1000;
const AVATAR_OCR_MAX_FAILS = 4;
const AVATAR_OCR_STALE_PENDING_MS = 5 * 60 * 1000;
const avatarOcrCache = new Map();
const avatarOcrQueue = [];
let avatarOcrPumpRunning = false;
let avatarOcrTesseractFailed = false;
let avatarOcrPaddleFailed = false;
let avatarOcrWorkerPromise = null;
let paddleUserscriptInitPromise = null;
let paddleUserscriptHandle = null;
let avatarOcrInitSerial = Promise.resolve();
const SPAM_SCANNER_BUILD = '2.14.29';
const TESSERACT_CHI_SIM_LANG_GZ = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz';
const TESSERACT_LANG_CACHE_KEY = './chi_sim.traineddata';
let tesseractLangCachePromise = null;
const AVATAR_OCR_RING_C = 2 * Math.PI * 8;
let avatarOcrTesseractReady = false;
let avatarOcrPaddleReady = false;
let avatarOcrEngineUiToken = 0;
const AVATAR_OCR_ENGINE_TESSERACT = 'tesseract';
const AVATAR_OCR_ENGINE_PADDLE = 'paddle';
const DEFAULT_AVATAR_OCR_ENGINE = AVATAR_OCR_ENGINE_TESSERACT;
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist';
const TESSERACT_CORE_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
const PADDLE_BROWSER_ASSETS = 'https://cdn.jsdelivr.net/npm/paddleocr-browser@1.0.3/dist/';
const ESEARCH_OCR_URL = 'https://cdn.jsdelivr.net/npm/esearch-ocr@5.1.5/dist/esearch-ocr.js';
const ORT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js';
const OPENCV_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/opencv.js';
let userscriptCvLoadPromise = null;
function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
}
function normalizeAvatarOcrEngine(value) {
    const engine = String(value || '').trim().toLowerCase();
    if (engine === AVATAR_OCR_ENGINE_PADDLE) return AVATAR_OCR_ENGINE_PADDLE;
    return AVATAR_OCR_ENGINE_TESSERACT;
}
function getAvatarOcrEngine() {
    return normalizeAvatarOcrEngine(scriptConfig.spamAvatarOcrEngine);
}
function isAvatarOcrEngineFailed() {
    return getAvatarOcrEngine() === AVATAR_OCR_ENGINE_PADDLE ? avatarOcrPaddleFailed : avatarOcrTesseractFailed;
}
function shouldDeferBackgroundAvatarOcr() {
    if (scriptConfig.spamAvatarOcrEnabled === false || scriptConfig.spamIdentifyEnabled === false) return false;
    if (document.documentElement.dataset.cbSpamOcrUiState === 'loading') return true;
    const engine = getAvatarOcrEngine();
    if (engine === AVATAR_OCR_ENGINE_PADDLE) {
        return avatarOcrPaddleFailed || (!avatarOcrPaddleReady && Boolean(paddleUserscriptInitPromise));
    }
    if (avatarOcrTesseractFailed && !avatarOcrTesseractReady) return true;
    if (!avatarOcrTesseractReady && avatarOcrWorkerPromise) return true;
    return false;
}
function gmFetchText(url, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            timeout: timeoutMs,
            onload: (response) => {
                if (response.status >= 200 && response.status < 300) resolve(response.responseText);
                else reject(new Error(`fetch ${response.status} ${url}`));
            },
            onerror: () => reject(new Error(`fetch network ${url}`))
        });
    });
}
function gmFetchArrayBuffer(url, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            onload: (response) => {
                if (response.status >= 200 && response.status < 300 && response.response?.byteLength > 0) {
                    resolve(response.response);
                } else {
                    reject(new Error(`fetch ${response.status} ${url}`));
                }
            },
            onerror: () => reject(new Error(`fetch network ${url}`))
        });
    });
}
async function gmFetchBlobUrl(url) {
    const buffer = await gmFetchArrayBuffer(url);
    return URL.createObjectURL(new Blob([buffer]));
}
let cachedOpencvScriptText = null;
let tesseractBundledWorkerBlobUrl = null;
let tesseractCoreWasmBlobUrl = null;
function resetTesseractCoreBlobs() {
    if (tesseractBundledWorkerBlobUrl) {
        try {
            URL.revokeObjectURL(tesseractBundledWorkerBlobUrl);
        } catch {
            /* ignore */
        }
    }
    if (tesseractCoreWasmBlobUrl) {
        try {
            URL.revokeObjectURL(tesseractCoreWasmBlobUrl);
        } catch {
            /* ignore */
        }
    }
    tesseractBundledWorkerBlobUrl = null;
    tesseractCoreWasmBlobUrl = null;
}
function pickTesseractCoreVariant() {
    try {
        if (typeof WebAssembly === 'object') {
            const simdProbe = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11);
            if (WebAssembly.validate(simdProbe)) return 'tesseract-core-simd-lstm';
        }
    } catch {
        /* ignore */
    }
    return 'tesseract-core-lstm';
}
async function gunzipToUint8Array(buffer) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('DecompressionStream 不可用');
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
function idbKeyvalSet(key, value) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = (event) => {
            event.target.result.createObjectStore('keyval');
        };
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('keyval', 'readwrite');
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.objectStore('keyval').put(value, key);
        };
    });
}
function idbKeyvalGet(key) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = (event) => {
            event.target.result.createObjectStore('keyval');
        };
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('keyval', 'readonly');
            const getReq = tx.objectStore('keyval').get(key);
            getReq.onsuccess = () => {
                db.close();
                resolve(getReq.result);
            };
            getReq.onerror = () => reject(getReq.error);
        };
    });
}
/** Worker fetch to tessdata/CDN is blocked on x.com; preload via GM_xhr into tesseract idb cache. */
async function ensureChiSimLangInTesseractCache(onProgress) {
    if (!tesseractLangCachePromise) {
        tesseractLangCachePromise = (async () => {
            const cached = await idbKeyvalGet(TESSERACT_LANG_CACHE_KEY);
            if (cached?.byteLength > 0) return;
            onProgress?.(42, '下载简体中文模型…');
            const gz = await gmFetchArrayBuffer(TESSERACT_CHI_SIM_LANG_GZ);
            onProgress?.(48, '解压语言包…');
            const trained = await gunzipToUint8Array(gz);
            await idbKeyvalSet(TESSERACT_LANG_CACHE_KEY, trained);
        })().catch((error) => {
            tesseractLangCachePromise = null;
            throw error;
        });
    }
    return tesseractLangCachePromise;
}
/**
 * x.com CSP blocks importScripts(blob/CDN) inside workers (script-src).
 * Inline tesseract-core before worker.min.js so getCore() skips importScripts.
 */
async function ensureTesseractBundledWorkerBlobUrl() {
    if (tesseractBundledWorkerBlobUrl) return tesseractBundledWorkerBlobUrl;
    const variant = pickTesseractCoreVariant();
    const [workerText, coreText, wasmBuffer] = await Promise.all([
        gmFetchText(`${TESSERACT_CDN}/worker.min.js`),
        gmFetchText(`${TESSERACT_CORE_CDN}/${variant}.wasm.js`),
        gmFetchArrayBuffer(`${TESSERACT_CORE_CDN}/${variant}.wasm`)
    ]);
    tesseractCoreWasmBlobUrl = URL.createObjectURL(new Blob([wasmBuffer], { type: 'application/wasm' }));
    const preamble = `var Module=typeof Module!=="undefined"?Module:{};Module.locateFile=function(path){if(String(path).slice(-5)===".wasm")return ${JSON.stringify(tesseractCoreWasmBlobUrl)};return path;};`;
    const bundle = `${preamble}${coreText}\n${workerText}`;
    tesseractBundledWorkerBlobUrl = URL.createObjectURL(new Blob([bundle], { type: 'application/javascript' }));
    return tesseractBundledWorkerBlobUrl;
}
function formatAvatarOcrError(error, fallback = '模型加载失败') {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error != null && typeof error !== 'undefined') {
        const text = String(error).trim();
        if (text && text !== 'undefined') return text;
    }
    return fallback;
}
function getTesseractWorkerOptions(workerPath) {
    return {
        workerPath,
        corePath: `${TESSERACT_CORE_CDN}/`,
        workerBlobURL: false,
        gzip: true
    };
}
async function ensureTesseractWorkerOptions(onProgress) {
    await ensureChiSimLangInTesseractCache(onProgress);
    const workerPath = await ensureTesseractBundledWorkerBlobUrl();
    const opts = getTesseractWorkerOptions(workerPath);
    opts.cacheMethod = 'readOnly';
    opts.logger = (m) => {
        try {
            if (typeof m?.progress === 'number' && onProgress) {
                const pct = Math.min(92, Math.round(18 + m.progress * 74));
                onProgress(pct, m?.status ? String(m.status).slice(0, 48) : '正在加载模型…');
            }
        } catch {
            /* ignore */
        }
    };
    return opts;
}
function resetAvatarOcrWorker() {
    avatarOcrWorkerPromise = null;
    resetTesseractCoreBlobs();
}
function resetPaddleUserscriptState() {
    paddleUserscriptInitPromise = null;
    paddleUserscriptHandle = null;
    userscriptCvLoadPromise = null;
    const pageWin = getPageWindow();
    delete pageWin.__cbPaddleBrowser;
    delete pageWin.__cbPaddleBrowserLoadError;
    delete pageWin.__cbPaddleInitConfig;
    delete pageWin.__cbOrtScriptInjected;
    delete pageWin.__cbOpencvScriptInjected;
    delete pageWin.__cbPaddleBootstrapInjected;
    try {
        const doc = pageWin.document;
        ['cb-paddle-ort', 'cb-paddle-opencv', 'cb-paddle-browser-bootstrap', 'cb-userscript-ort', 'cb-userscript-opencv'].forEach((id) => {
            doc.getElementById(id)?.remove();
        });
    } catch {
        /* ignore */
    }
}
function resetAvatarOcrRuntime() {
    avatarOcrTesseractFailed = false;
    avatarOcrPaddleFailed = false;
    avatarOcrTesseractReady = false;
    avatarOcrPaddleReady = false;
    avatarOcrEngineUiToken += 1;
    resetAvatarOcrWorker();
    resetPaddleUserscriptState();
}
function prepareAvatarOcrEngineUiLoad(engine) {
    avatarOcrEngineUiToken += 1;
    const normalized = normalizeAvatarOcrEngine(engine);
    if (normalized === AVATAR_OCR_ENGINE_PADDLE) {
        avatarOcrPaddleFailed = false;
        paddleUserscriptInitPromise = null;
        paddleUserscriptHandle = null;
        userscriptCvLoadPromise = null;
        try {
            const pageWin = getPageWindow();
            delete pageWin.__cbOpencvInjected;
            delete pageWin.__cbPaddleModInjected;
            delete pageWin.__cbPaddleMod;
        } catch {
            /* ignore */
        }
    } else {
        avatarOcrTesseractFailed = false;
        resetAvatarOcrWorker();
    }
    try {
        delete document.documentElement.dataset.cbSpamOcrLastError;
    } catch {
        /* ignore */
    }
    setAvatarOcrEngineUiStatus('loading', 6, '正在加载模型…');
    return avatarOcrEngineUiToken;
}
function waitForPageOpenCv(timeoutMs = 300000) {
    const pageWin = getPageWindow();
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const finish = (cv) => {
            if (cv?.Mat) resolve(cv);
            else if (Date.now() - started > timeoutMs) reject(new Error('timeout waiting for cv'));
            else window.setTimeout(() => finish(pageWin.cv), 250);
        };
        if (pageWin.cv?.Mat) {
            resolve(pageWin.cv);
            return;
        }
        if (pageWin.cv && typeof pageWin.cv.onRuntimeInitialized === 'function') {
            const prev = pageWin.cv.onRuntimeInitialized;
            pageWin.cv.onRuntimeInitialized = () => {
                if (typeof prev === 'function') prev();
                resolve(pageWin.cv);
            };
        }
        window.setTimeout(() => finish(pageWin.cv), 250);
    });
}
async function loadPaddleModule() {
    const pageWin = getPageWindow();
    if (pageWin.__cbPaddleMod) return pageWin.__cbPaddleMod;
    let moduleUrl = ESEARCH_OCR_URL;
    try {
        if (typeof GM_getResourceURL === 'function') {
            moduleUrl = GM_getResourceURL('esearchOcr');
        }
    } catch {
        /* fallback */
    }
    if (!pageWin.__cbPaddleModInjected) {
        await injectPageScriptText(
            `import { init as paddleInit, ocr as paddleOcr } from ${JSON.stringify(moduleUrl)};
window.__cbPaddleMod = { init: paddleInit, ocr: paddleOcr };
window.dispatchEvent(new CustomEvent('cb-paddle-mod-ready'));`,
            { type: 'module', marker: '__cbPaddleModInjected' }
        );
        await new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('paddle module load timeout')), 120000);
            pageWin.addEventListener('cb-paddle-mod-ready', () => {
                window.clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }
    if (!pageWin.__cbPaddleMod) throw new Error('esearch-ocr 未加载');
    return pageWin.__cbPaddleMod;
}
function injectPageScriptText(text, { type = 'text/javascript', marker } = {}) {
    const pageWin = getPageWindow();
    if (marker && pageWin[marker]) return Promise.resolve();
    return new Promise((resolve, reject) => {
        GM_addElement('script', {
            parent: document.head,
            type,
            textContent: text,
            onload: () => {
                if (marker) pageWin[marker] = true;
                resolve();
            },
            onerror: () => reject(new Error('GM_addElement script inject failed'))
        });
    });
}
async function ensureSandboxCv() {
    const pageWin = getPageWindow();
    if (pageWin.cv?.Mat) return pageWin.cv;
    if (!userscriptCvLoadPromise) {
        userscriptCvLoadPromise = (async () => {
            if (!pageWin.__cbOpencvInjected) {
                await new Promise((resolve, reject) => {
                    GM_addElement('script', {
                        parent: document.head,
                        src: OPENCV_SCRIPT_URL,
                        onload: () => {
                            pageWin.__cbOpencvInjected = true;
                            resolve();
                        },
                        onerror: () => reject(new Error('opencv script load failed'))
                    });
                });
            }
            return waitForPageOpenCv();
        })().catch((error) => {
            userscriptCvLoadPromise = null;
            throw error;
        });
    }
    return userscriptCvLoadPromise;
}
function ensureUserscriptOrt() {
    if (!globalThis.ort?.InferenceSession) {
        throw new Error('onnxruntime-web 未加载（请在暴力猴中更新并启用本脚本）');
    }
    try {
        getPageWindow().ort = globalThis.ort;
    } catch {
        /* ignore */
    }
    return globalThis.ort;
}
function getAvatarOcrEngineStatusEl() {
    return document.querySelector('#nuke-spam-avatar-ocr-engine-status');
}
function renderAvatarOcrEngineRingSvg(progressPct) {
    const p = Math.max(0, Math.min(100, progressPct));
    const offset = AVATAR_OCR_RING_C * (1 - p / 100);
    return `<svg class="nuke-ocr-engine-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="nuke-ocr-engine-ring-track" cx="10" cy="10" r="8" fill="none" stroke-width="2"/><circle class="nuke-ocr-engine-ring-progress" cx="10" cy="10" r="8" fill="none" stroke-width="2" stroke-dasharray="${AVATAR_OCR_RING_C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 10 10)"/></svg>`;
}
function renderAvatarOcrEngineDoneSvg() {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="nuke-ocr-engine-done-fill" cx="10" cy="10" r="9"/><path class="nuke-ocr-engine-done-check" d="M6 10.5 8.5 13 14 7"/></svg>';
}
function renderAvatarOcrEngineErrorSvg() {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="nuke-ocr-engine-error-fill" cx="10" cy="10" r="9"/><path class="nuke-ocr-engine-error-mark" d="M7 7l6 6M13 7l-6 6"/></svg>';
}
function setAvatarOcrEngineUiStatus(state, progressPct = 0, title = '') {
    try {
        document.documentElement.dataset.cbSpamOcrUiState = state;
        document.documentElement.dataset.cbSpamOcrUiProgress = String(Math.round(progressPct));
        if (state === 'loading') delete document.documentElement.dataset.cbSpamOcrLastError;
    } catch {
        /* ignore */
    }
    const el = getAvatarOcrEngineStatusEl();
    if (!el) return;
    el.className = `nuke-ocr-engine-status nuke-ocr-engine-status--${state}`;
    el.title = title || '';
    if (state === 'loading') {
        el.innerHTML = renderAvatarOcrEngineRingSvg(progressPct);
        el.setAttribute('aria-label', title || `模型加载中 ${Math.round(progressPct)}%`);
    } else if (state === 'ready') {
        el.innerHTML = renderAvatarOcrEngineDoneSvg();
        el.setAttribute('aria-label', title || '模型已就绪');
    } else if (state === 'error') {
        const errText = String(title || document.documentElement.dataset.cbSpamOcrLastError || '模型加载失败').slice(0, 200);
        el.innerHTML = renderAvatarOcrEngineErrorSvg();
        el.title = errText;
        el.dataset.errorHint = errText;
        el.setAttribute('aria-label', errText);
        try {
            document.documentElement.dataset.cbSpamOcrLastError = errText;
        } catch {
            /* ignore */
        }
    } else {
        el.innerHTML = '';
        el.removeAttribute('aria-label');
    }
}
function isAvatarOcrEngineReady(engine) {
    const normalized = normalizeAvatarOcrEngine(engine);
    if (normalized === AVATAR_OCR_ENGINE_PADDLE) {
        return avatarOcrPaddleReady || Boolean(getPageWindow().__cbPaddleBrowser?.ready);
    }
    return avatarOcrTesseractReady && !avatarOcrTesseractFailed;
}
function syncAvatarOcrEngineStatusForSelect(selectEl) {
    if (!selectEl) return;
    const engine = normalizeAvatarOcrEngine(selectEl.value);
    if (isAvatarOcrEngineReady(engine)) {
        setAvatarOcrEngineUiStatus('ready', 100, engine === AVATAR_OCR_ENGINE_PADDLE ? 'PaddleOCR 已就绪' : 'Tesseract 已就绪');
        return;
    }
    if ((engine === AVATAR_OCR_ENGINE_PADDLE && paddleUserscriptInitPromise) ||
        (engine !== AVATAR_OCR_ENGINE_PADDLE && avatarOcrWorkerPromise)) {
        setAvatarOcrEngineUiStatus('loading', 8, '正在加载模型…');
        return;
    }
    setAvatarOcrEngineUiStatus('idle');
}
async function loadTesseractForUi(onProgress) {
    const report = (pct, label) => {
        try {
            onProgress?.(pct, label);
        } catch {
            /* ignore */
        }
    };
    report(15, '加载 Tesseract worker…');
    report(55, '加载简体中文模型…');
    const worker = await getAvatarOcrWorker();
    avatarOcrTesseractReady = true;
    report(100, 'Tesseract 已就绪');
    return worker;
}
let paddleUiProgressTimer = null;
function stopPaddleUiProgressPulse() {
    if (paddleUiProgressTimer) {
        clearInterval(paddleUiProgressTimer);
        paddleUiProgressTimer = null;
    }
}
function startPaddleUiProgressPulse(onProgress, fromPct = 52) {
    stopPaddleUiProgressPulse();
    let pct = fromPct;
    paddleUiProgressTimer = setInterval(() => {
        pct = Math.min(88, pct + 2);
        try {
            onProgress?.(pct, '下载识别模型…');
        } catch {
            /* ignore */
        }
    }, 2500);
}
async function preloadAvatarOcrEngineForUi(engine) {
    const normalized = normalizeAvatarOcrEngine(engine);
    const token = prepareAvatarOcrEngineUiLoad(engine);
    if (isAvatarOcrEngineReady(normalized)) {
        setAvatarOcrEngineUiStatus('ready', 100);
        return true;
    }
    const report = (pct, label) => {
        if (token !== avatarOcrEngineUiToken) return;
        setAvatarOcrEngineUiStatus('loading', pct, label);
    };
    report(4, '正在加载模型…');
    try {
        if (normalized === AVATAR_OCR_ENGINE_PADDLE) {
            await ensurePaddleUserscriptReady(report);
            avatarOcrPaddleReady = true;
        } else {
            await loadTesseractForUi(report);
        }
        if (token !== avatarOcrEngineUiToken) return true;
        stopPaddleUiProgressPulse();
        try {
            document.documentElement.dataset.cbSpamOcrReady = '1';
        } catch {
            /* ignore */
        }
        setAvatarOcrEngineUiStatus('ready', 100, '模型已就绪');
        return true;
    } catch (error) {
        stopPaddleUiProgressPulse();
        if (token !== avatarOcrEngineUiToken) return false;
        if (normalized === AVATAR_OCR_ENGINE_PADDLE) avatarOcrPaddleFailed = true;
        else avatarOcrTesseractFailed = true;
        const raw = formatAvatarOcrError(error);
        const hint = /opencv|timeout waiting for cv/i.test(raw)
            ? 'PaddleOCR 需 OpenCV，x.com 上请先用 Tesseract.js'
            : raw;
        setAvatarOcrEngineUiStatus('error', 0, hint);
        return false;
    }
}
function resetSpamScanMarkersForBuildUpgrade() {
    if (window.__cbSpamScannerBuild === SPAM_SCANNER_BUILD) return;
    window.__cbSpamScannerBuild = SPAM_SCANNER_BUILD;
    avatarOcrCache.clear();
    resetAvatarOcrRuntime();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        delete article.dataset.spamScanned;
        delete article.dataset.avatarOcrQueued;
        delete article.dataset.avatarOcrPending;
        delete article.dataset.avatarOcrQueuedAt;
        delete article.dataset.avatarOcrFailCount;
        article.classList.remove('nuke-spam-identified');
        article.querySelector('.nuke-spam-badge')?.remove();
    });
}
function markStatusRootTweetArticles() {
    if (!/\/status\/\d+/i.test(window.location.pathname)) return;
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const first = column?.querySelector('article[data-testid="tweet"]');
    document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"]').forEach((article) => {
        delete article.dataset.cbSpamRootTweet;
    });
    if (first) first.dataset.cbSpamRootTweet = 'true';
}
function shouldSkipAvatarOcrForArticle(article) {
    return article?.dataset?.cbSpamRootTweet === 'true';
}
function extractTwitterProfileImageId(url) {
    const match = String(url || '').match(/profile_images\/(\d+)\//);
    return match ? match[1] : '';
}
const FOLLOWER_COUNT_CACHE_MS = 10 * 60 * 1000;
const AUTO_SCAN_INTERVAL_MS = 2000;
const API_RETRY_DELAY_MS = 5 * 60 * 1000;
let currentUserId = null, currentUserScreenName = null, activeTweetArticle = null;
let isProcessingQueue = false, processIntervalId = null, apiLimitCountdownInterval = null;
let scriptConfig = {}, isConfigPanelBusy = false;
const followerCountCache = new Map();
const followerFetchPending = new Map();

// --- STYLES ---
GM_addStyle(`.nuke-toast{position:fixed;top:20px;right:20px;z-index:100000;background-color:#15202b;color:white;padding:10px 15px;border-radius:12px;border:1px solid #38444d;box-shadow:0 4px 12px rgba(0,0,0,0.4);width:auto;max-width:350px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;transition:all .5s ease-out;opacity:1;transform:translateX(0)}.nuke-toast.fading-out{opacity:0;transform:translateX(20px)}.nuke-toast-title{font-weight:bold;margin-bottom:8px;font-size:16px}.nuke-toast-status{font-size:14px;margin-bottom:0;line-height:1.5}#nuke-status-toast{background-color:#253341}#nuke-api-limit-toast{background-color:#d9a100;color:#15202b;border-color:#ffc107}.nuke-config-panel,.nuke-verify-modal{position:fixed;z-index:100001;background-color:#15202b;color:white;border-radius:16px;border:1px solid #38444d;box-shadow:0 8px 24px rgba(0,0,0,0.5);width:550px;max-width:90vw;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:0;margin:0}.nuke-verify-modal{top:50%;left:50%;transform:translate(-50%,-50%)}.nuke-config-panel{max-height:calc(100vh - 16px);overflow-y:auto;transform:none;top:0;left:0}.nuke-config-panel.nuke-dialog-dragging{user-select:none;will-change:left,top}.nuke-panel-header.nuke-dialog-drag-handle{cursor:grab;touch-action:none}.nuke-panel-header.nuke-dialog-drag-handle:active{cursor:grabbing}.nuke-config-panel::backdrop,.nuke-verify-modal::backdrop{background:rgba(91,112,131,0.45)}.nuke-panel-header{display:flex;align-items:center;justify-content:space-between;height:53px;padding:0 16px;border-bottom:1px solid #38444d}.nuke-header-item{flex-basis:56px;display:flex;align-items:center}.nuke-header-item.left{justify-content:flex-start}.nuke-header-item.right{justify-content:flex-end}.nuke-config-title{font-weight:bold;font-size:20px;flex-grow:1;text-align:center}.nuke-close-button{background:0 0;border:0;padding:0;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:9999px;transition:background-color .2s ease-in-out}.nuke-close-button:hover{background-color:rgba(239,243,244,0.1)}.nuke-close-button svg{fill:white;width:20px;height:20px}.nuke-panel-content{padding:16px}.nuke-config-textarea,.nuke-verify-textarea,.nuke-list-search,.nuke-setting-item input[type=number]{user-select:text;-webkit-user-select:text;pointer-events:auto}.nuke-config-textarea,.nuke-verify-textarea{width:100%;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:10px;font-size:14px;resize:vertical;box-sizing:border-box;margin-bottom:15px}.nuke-url-textarea{height:80px}.nuke-keywords-textarea{height:60px}.nuke-verify-textarea{height:110px;line-height:1.5}.nuke-config-button-container{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.nuke-config-button.save,.nuke-config-button.copy{background-color:#eff3f4;color:#0f1419;padding:8px 16px;border-radius:20px;border:none;font-weight:bold;cursor:pointer;transition:background-color .2s}.nuke-config-button.save:hover,.nuke-config-button.copy:hover{background-color:#d7dbdc}.nuke-config-tabs{display:flex;border-bottom:1px solid #38444d;margin-bottom:15px}.nuke-config-tab{background:0 0;border:none;color:#8899a6;padding:10px 15px;cursor:pointer;font-size:15px;font-weight:700;flex-grow:1;transition:background-color .2s}.nuke-config-tab:hover{background-color:rgba(239,243,244,0.1)}.nuke-config-tab.active{color:#1d9bf0;border-bottom:2px solid #1d9bf0;margin-bottom:-1px}.nuke-config-tab-content{animation:fadeIn .3s ease-in-out;padding-top:10px}.nuke-config-tab-content.hidden{display:none}@keyframes fadeIn{from{opacity:0}to{opacity:1}}.nuke-list{max-height:280px;overflow-y:auto;padding-right:10px}.nuke-list-search{width:100%;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:8px 12px;font-size:14px;box-sizing:border-box;margin-bottom:10px}.nuke-list-entry{display:flex;justify-content:space-between;align-items:center;padding:8px 5px;border-bottom:1px solid #253341}.nuke-list-user-info{display:flex;flex-direction:column;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:10px}.nuke-list-user-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nuke-list-user-handle{color:#8899a6;font-size:14px;cursor:pointer}.nuke-list-user-handle:hover{text-decoration:underline}.nuke-list-block-reason{display:block;font-size:12px;color:#8899a6;margin-top:4px;line-height:1.4;word-break:break-word;white-space:normal}.nuke-list-actions{font-size:12px;color:#8899a6;white-space:nowrap;cursor:pointer;flex-shrink:0;margin-left:8px}.nuke-list-actions:hover{color:#1d9bf0}.nuke-list-user-info a{color:inherit;text-decoration:none}.nuke-list-user-info a:hover .nuke-list-user-name{text-decoration:underline}.nuke-setting-item{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px}.nuke-setting-item label{font-size:14px;margin-right:10px}.nuke-setting-item input[type=number]{width:80px;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:5px 8px;font-size:14px}.nuke-setting-item select{max-width:240px;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:5px 8px;font-size:14px}.nuke-ocr-engine-item{align-items:center}.nuke-ocr-engine-controls{display:flex;align-items:center;gap:8px;flex-shrink:0}.nuke-ocr-engine-status{width:20px;height:20px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}.nuke-ocr-engine-status--idle{visibility:hidden;pointer-events:none}.nuke-ocr-engine-status svg{width:20px;height:20px;display:block}.nuke-ocr-engine-status--loading .nuke-ocr-engine-ring-track{stroke:#38444d}.nuke-ocr-engine-status--loading .nuke-ocr-engine-ring-progress{stroke:#1d9bf0;transition:stroke-dashoffset .25s ease}.nuke-ocr-engine-status--done .nuke-ocr-engine-done-fill{fill:#00ba7c}.nuke-ocr-engine-status--done .nuke-ocr-engine-done-check{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.nuke-ocr-engine-status--error .nuke-ocr-engine-error-fill{fill:#f4212e}.nuke-ocr-engine-status--error .nuke-ocr-engine-error-mark{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round}.nuke-ocr-engine-status--error{cursor:help}.nuke-setting-item input[type=checkbox]{height:20px;width:20px;accent-color:#1d9bf0}.nuke-settings-label{display:block;font-size:14px;color:#8899a6;margin-top:10px;margin-bottom:10px}.nuke-verify-note{font-size:14px;color:#8899a6;line-height:1.5;margin-bottom:10px}article[data-testid="tweet"].nuke-spam-identified{box-shadow:inset 0 0 0 1px rgba(255,173,31,.55);border-radius:12px}.nuke-spam-badge{display:inline-flex;align-items:center;margin:4px 12px 0;padding:2px 8px;font-size:12px;font-weight:700;color:#ffad1f;background:rgba(255,173,31,.12);border:1px solid rgba(255,173,31,.35);border-radius:9999px;cursor:help}`);

// --- CONFIGURATION MANAGEMENT ---
async function loadConfig() {
    const defaultConfig = {
        autoBlockEnabled: true,
        effectiveUrls: ['https://x.com/*/status/*', 'https://x.com/search*', 'https://x.com/*'],
        blockLogLimit: 500,
        longNameFollowerExemptThreshold: DEFAULT_LONG_NAME_FOLLOWER_EXEMPT_THRESHOLD,
        blockKeywordsStandard: [], // For any name
        spamIdentifyEnabled: true,
        spamIdentifyMinScore: DEFAULT_SPAM_IDENTIFY_MIN_SCORE,
        spamAvatarOcrEnabled: true,
        spamAvatarOcrEngine: DEFAULT_AVATAR_OCR_ENGINE,
        spamAvatarKeywords: ['全国安排', '点击主页'],
        spamAutoExpandHidden: true
    };
    const savedConfig = await GM_getValue(CONFIG_STORAGE_KEY, {});
    const migrated = { ...savedConfig };
    if (migrated.promoTargetAutoNukeEnabled === true && migrated.autoBlockEnabled === false) {
        migrated.autoBlockEnabled = true;
    }
    const legacyUrls = [
        ...(Array.isArray(migrated.effectiveUrls) ? migrated.effectiveUrls : []),
        ...(Array.isArray(migrated.autoBlockUrls) ? migrated.autoBlockUrls : []),
        ...(Array.isArray(migrated.spamIdentifyUrls) ? migrated.spamIdentifyUrls : []),
        ...(Array.isArray(migrated.promoTargetAutoNukeUrls) ? migrated.promoTargetAutoNukeUrls : [])
    ].map((url) => String(url).trim()).filter(Boolean);
    if (legacyUrls.length) migrated.effectiveUrls = [...new Set(legacyUrls)];
    delete migrated.autoBlockUrls;
    delete migrated.spamIdentifyUrls;
    delete migrated.promoTargetAutoNukeEnabled;
    delete migrated.promoTargetLearnOnNuke;
    delete migrated.promoTargetAutoNukeUrls;
    scriptConfig = { ...defaultConfig, ...migrated };
    return scriptConfig;
}
async function saveConfig(config) { await GM_setValue(CONFIG_STORAGE_KEY, config); scriptConfig = config; }
function updateMenuCommands() { GM_registerMenuCommand('配置与记录', showConfigPanel); }
function closeDialogSurface(surface) {
    if (!surface) return;
    if (typeof surface.close === 'function' && surface.open) surface.close();
    surface.remove();
}
const DIALOG_VIEWPORT_MARGIN = 8;
function clampDialogPosition(panel, left, top, margin = DIALOG_VIEWPORT_MARGIN) {
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop)
    };
}
function placeDialogInViewport(panel, options = {}) {
    const margin = options.margin ?? DIALOG_VIEWPORT_MARGIN;
    panel.style.transform = 'none';
    panel.style.margin = '0';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    let left = options.left;
    let top = options.top;
    if (options.center) {
        left = (window.innerWidth - panel.offsetWidth) / 2;
        top = (window.innerHeight - panel.offsetHeight) / 2;
    }
    const next = clampDialogPosition(panel, left ?? margin, top ?? margin, margin);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.dataset.nukePinnedPosition = 'true';
    return next;
}
function initializeDialogSurface(surface, options = {}) {
    if (!surface) return;
    const { initialFocusSelector = '', selectInitialText = false, show = true } = options;
    const stopEvent = (event) => event.stopPropagation();
    ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach((type) => {
        surface.addEventListener(type, stopEvent);
    });
    surface.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDialogSurface(surface);
    });
    surface.addEventListener('click', (event) => {
        if (event.target === surface) closeDialogSurface(surface);
    });
    surface.addEventListener('pointerdown', (event) => {
        const target = event.target;
        if (target && typeof target.matches === 'function' && target.matches('input, textarea')) {
            window.setTimeout(() => {
                if (typeof target.focus === 'function') target.focus({ preventScroll: true });
                if (selectInitialText && typeof target.select === 'function') target.select();
            }, 0);
        }
    }, true);
    document.body.appendChild(surface);
    if (show && typeof surface.showModal === 'function' && !surface.open) surface.showModal();
    if (!show) return;
    const initialField = initialFocusSelector ? surface.querySelector(initialFocusSelector) : null;
    window.setTimeout(() => {
        const target = initialField || surface;
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
        if (selectInitialText && initialField && typeof initialField.select === 'function') initialField.select();
    }, 0);
}
function focusDialogSurface(surface, initialFocusSelector = '') {
    const initialField = initialFocusSelector ? surface.querySelector(initialFocusSelector) : null;
    window.setTimeout(() => {
        const target = initialField || surface;
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }, 0);
}
function enableDraggableDialog(panel, options = {}) {
    if (!panel) return;
    const handle = panel.querySelector(options.handleSelector || '.nuke-panel-header');
    if (!handle) return;
    handle.classList.add('nuke-dialog-drag-handle');
    const margin = options.margin ?? DIALOG_VIEWPORT_MARGIN;
    let dragState = null;
    const applyPosition = (left, top) => {
        const next = clampDialogPosition(panel, left, top, margin);
        panel.style.left = `${next.left}px`;
        panel.style.top = `${next.top}px`;
    };
    const onWindowPointerMove = (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        event.preventDefault();
        applyPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
    };
    const endDrag = (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        dragState = null;
        panel.classList.remove('nuke-dialog-dragging');
        window.removeEventListener('pointermove', onWindowPointerMove, true);
        window.removeEventListener('pointerup', endDrag, true);
        window.removeEventListener('pointercancel', endDrag, true);
    };
    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('.nuke-close-button, button, a, input, textarea, select, label')) return;
        event.preventDefault();
        const rect = panel.getBoundingClientRect();
        dragState = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top
        };
        panel.classList.add('nuke-dialog-dragging');
        window.addEventListener('pointermove', onWindowPointerMove, { capture: true, passive: false });
        window.addEventListener('pointerup', endDrag, { capture: true });
        window.addEventListener('pointercancel', endDrag, { capture: true });
    });
    const onResize = () => {
        if (panel.dataset.nukePinnedPosition !== 'true') return;
        applyPosition(parseFloat(panel.style.left) || margin, parseFloat(panel.style.top) || margin);
    };
    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => onResize())
        : null;
    resizeObserver?.observe(panel);
    window.addEventListener('resize', onResize);
    const cleanupDragListeners = () => {
        dragState = null;
        panel.classList.remove('nuke-dialog-dragging');
        window.removeEventListener('pointermove', onWindowPointerMove, true);
        window.removeEventListener('pointerup', endDrag, true);
        window.removeEventListener('pointercancel', endDrag, true);
    };
    panel.addEventListener('remove', () => {
        cleanupDragListeners();
        resizeObserver?.disconnect();
        window.removeEventListener('resize', onResize);
    }, { once: true });
}
async function showConfigPanel() {
    if (isConfigPanelBusy) return;
    isConfigPanelBusy = true;
    try {
        closeDialogSurface(document.getElementById('nuke-url-config-panel'));
        let config = await loadConfig();
        const panel = document.createElement('dialog');
        panel.id = 'nuke-url-config-panel';
        panel.className = 'nuke-config-panel';
        panel.innerHTML = `
            <div class="nuke-panel-header">
                <div class="nuke-header-item left">
                    <button class="nuke-close-button" aria-label="关闭"><svg viewBox="0 0 24 24"><g><path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"></path></g></svg></button>
                </div>
                <h2 class="nuke-config-title">配置与记录</h2>
                <div class="nuke-header-item right"></div>
            </div>
            <div class="nuke-panel-content">
                <div class="nuke-config-tabs">
                    <button class="nuke-config-tab active" data-tab="settings">⚙️ 设置</button>
                    <button class="nuke-config-tab" data-tab="log">📓 拉黑记录</button>
                    <button class="nuke-config-tab" data-tab="whitelist">🛡️ 白名单</button>
                    <button class="nuke-config-tab" data-tab="promo">🎯 引流目标</button>
                </div>
                <div id="nuke-settings-content" class="nuke-config-tab-content">
                    <div class="nuke-setting-item">
                        <label for="nuke-auto-block-toggle">自动拉黑</label>
                        <input type="checkbox" id="nuke-auto-block-toggle">
                    </div>
                    <div class="nuke-setting-item">
                        <label for="nuke-log-limit-input">拉黑记录最大条数 (0为不限制)</label>
                        <input type="number" id="nuke-log-limit-input" min="0" step="100">
                    </div>
                    <label class="nuke-settings-label" for="nuke-keywords-standard-textarea">用户名无差别关键词 (无视长度与粉丝数, 每行一条; 支持纯文本或正则)</label>
                    <textarea id="nuke-keywords-standard-textarea" class="nuke-config-textarea nuke-keywords-textarea" placeholder="例如: 点击主页&#10;💚(少妇|姐姐|妈妈)💚"></textarea>
                    <div class="nuke-setting-item">
                        <label for="nuke-long-name-follower-input">长用户名粉丝数豁免 (粉丝数大于该值时不触发长用户名规则)</label>
                        <input type="number" id="nuke-long-name-follower-input" min="0" step="1">
                    </div>
                    <label class="nuke-settings-label" for="nuke-effective-urls-textarea">生效 URL (自动拉黑 / 引流识别, 每行一条, 支持*):</label>
                    <textarea id="nuke-effective-urls-textarea" class="nuke-config-textarea nuke-url-textarea"></textarea>
                    <div class="nuke-setting-item">
                        <label for="nuke-spam-identify-toggle">引流识别 (仅页面黄标, 不拉黑)</label>
                        <input type="checkbox" id="nuke-spam-identify-toggle">
                    </div>
                    <div class="nuke-setting-item">
                        <label for="nuke-spam-avatar-ocr-toggle">识别头像内文字 OCR (较慢, 并入引流识别)</label>
                        <input type="checkbox" id="nuke-spam-avatar-ocr-toggle">
                    </div>
                    <div class="nuke-setting-item nuke-ocr-engine-item">
                        <label for="nuke-spam-avatar-ocr-engine">头像 OCR 引擎</label>
                        <div class="nuke-ocr-engine-controls">
                            <span id="nuke-spam-avatar-ocr-engine-status" class="nuke-ocr-engine-status nuke-ocr-engine-status--idle" role="status" aria-live="polite" title=""></span>
                            <select id="nuke-spam-avatar-ocr-engine">
                                <option value="tesseract">Tesseract.js（默认，较轻）</option>
                                <option value="paddle">PaddleOCR（paddleocr-browser，较准）</option>
                            </select>
                        </div>
                    </div>
                    <div class="nuke-setting-item">
                        <label for="nuke-spam-auto-expand-toggle">推文页自动展开「可能的垃圾回复」</label>
                        <input type="checkbox" id="nuke-spam-auto-expand-toggle">
                    </div>
                    <label class="nuke-settings-label" for="nuke-spam-avatar-keywords-textarea">头像 OCR 关键词 (每行一条; 留空则用用户名关键词; 另自动识别头像内「全国安排」)</label>
                    <textarea id="nuke-spam-avatar-keywords-textarea" class="nuke-config-textarea nuke-keywords-textarea" placeholder="全国安排&#10;点击主页"></textarea>
                    <div class="nuke-setting-item">
                        <label for="nuke-spam-identify-score-input">推文引流识别最低得分</label>
                        <input type="number" id="nuke-spam-identify-score-input" min="1" max="10" step="1">
                    </div>
                    <div class="nuke-config-button-container">
                        <button class="nuke-config-button save">保存设置</button>
                    </div>
                </div>
                <div id="nuke-log-content" class="nuke-config-tab-content hidden">
                    <input type="search" class="nuke-list-search" id="nuke-log-search" placeholder="搜索记录 (用户名, @handle, ID)...">
                    <div class="nuke-list"></div>
                </div>
                <div id="nuke-whitelist-content" class="nuke-config-tab-content hidden">
                    <input type="search" class="nuke-list-search" id="nuke-whitelist-search" placeholder="搜索白名单 (用户名, @handle, ID)...">
                    <div class="nuke-list"></div>
                </div>
                <div id="nuke-promo-content" class="nuke-config-tab-content hidden">
                    <p class="nuke-verify-note">开启「自动拉黑」后，推文 @ 列表中账号会触发九族拉黑。手动九族拉黑时，推文里的 @ 会始终收录进此列表并立刻拉黑。</p>
                    <label class="nuke-settings-label" for="nuke-promo-targets-textarea">手动维护 @ (每行一个, 可带@):</label>
                    <textarea id="nuke-promo-targets-textarea" class="nuke-config-textarea nuke-url-textarea" placeholder="ChristineViu&#10;yeyebbz"></textarea>
                    <input type="search" class="nuke-list-search" id="nuke-promo-search" placeholder="搜索引流目标 @handle...">
                    <div class="nuke-list"></div>
                </div>
            </div>`;
        panel.tabIndex = -1;
        initializeDialogSurface(panel, { show: false });
        enableDraggableDialog(panel);
        panel.querySelector('#nuke-auto-block-toggle').checked = config.autoBlockEnabled;
        panel.querySelector('#nuke-log-limit-input').value = config.blockLogLimit;
        panel.querySelector('#nuke-effective-urls-textarea').value = (config.effectiveUrls || []).join('\n');
        panel.querySelector('#nuke-long-name-follower-input').value = config.longNameFollowerExemptThreshold ?? DEFAULT_LONG_NAME_FOLLOWER_EXEMPT_THRESHOLD;
        panel.querySelector('#nuke-keywords-standard-textarea').value = (config.blockKeywordsStandard || []).join('\n');
        panel.querySelector('#nuke-spam-identify-toggle').checked = config.spamIdentifyEnabled !== false;
        panel.querySelector('#nuke-spam-avatar-ocr-toggle').checked = config.spamAvatarOcrEnabled !== false;
        const engineSelect = panel.querySelector('#nuke-spam-avatar-ocr-engine');
        engineSelect.value = normalizeAvatarOcrEngine(config.spamAvatarOcrEngine);
        engineSelect.addEventListener('change', () => {
            void preloadAvatarOcrEngineForUi(normalizeAvatarOcrEngine(engineSelect.value));
        });
        if (config.spamAvatarOcrEnabled !== false) {
            syncAvatarOcrEngineStatusForSelect(engineSelect);
        } else {
            setAvatarOcrEngineUiStatus('idle');
        }
        panel.querySelector('#nuke-spam-auto-expand-toggle').checked = config.spamAutoExpandHidden !== false;
        panel.querySelector('#nuke-spam-avatar-keywords-textarea').value = (config.spamAvatarKeywords || []).join('\n');
        panel.querySelector('#nuke-spam-identify-score-input').value = config.spamIdentifyMinScore ?? DEFAULT_SPAM_IDENTIFY_MIN_SCORE;
        const promoData = await loadUserData();
        panel.querySelector('#nuke-promo-targets-textarea').value = (promoData?.promoTargets || []).map((e) => e.screenName).join('\n');

        const setActiveTab = (tabName) => {
            panel.querySelectorAll('.nuke-config-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
            panel.querySelectorAll('.nuke-config-tab-content').forEach(c => c.classList.toggle('hidden', c.id !== `nuke-${tabName}-content`));
        };
        panel.querySelectorAll('.nuke-config-tab').forEach(tab => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));
        panel.querySelector('.nuke-close-button').addEventListener('click', () => closeDialogSurface(panel));
        panel.querySelector('.nuke-config-button.save').addEventListener('click', async () => {
            config.autoBlockEnabled = panel.querySelector('#nuke-auto-block-toggle').checked;
            config.blockLogLimit = parseInt(panel.querySelector('#nuke-log-limit-input').value, 10) || 500;
            config.effectiveUrls = panel.querySelector('#nuke-effective-urls-textarea').value.split('\n').map(url => url.trim()).filter(Boolean);
            config.longNameFollowerExemptThreshold = Math.max(0, parseInt(panel.querySelector('#nuke-long-name-follower-input').value, 10) || DEFAULT_LONG_NAME_FOLLOWER_EXEMPT_THRESHOLD);
            config.blockKeywordsStandard = panel.querySelector('#nuke-keywords-standard-textarea').value.split('\n').map(kw => kw.trim()).filter(Boolean);
            config.spamIdentifyEnabled = panel.querySelector('#nuke-spam-identify-toggle').checked;
            const nextEngine = normalizeAvatarOcrEngine(panel.querySelector('#nuke-spam-avatar-ocr-engine').value);
            const engineChanged = normalizeAvatarOcrEngine(config.spamAvatarOcrEngine) !== nextEngine;
            if (engineChanged) {
                avatarOcrCache.clear();
                resetAvatarOcrRuntime();
            }
            config.spamAvatarOcrEnabled = panel.querySelector('#nuke-spam-avatar-ocr-toggle').checked;
            config.spamAvatarOcrEngine = nextEngine;
            config.spamAutoExpandHidden = panel.querySelector('#nuke-spam-auto-expand-toggle').checked;
            config.spamAvatarKeywords = panel.querySelector('#nuke-spam-avatar-keywords-textarea').value.split('\n').map((kw) => kw.trim()).filter(Boolean);
            config.spamIdentifyMinScore = Math.max(1, parseInt(panel.querySelector('#nuke-spam-identify-score-input').value, 10) || DEFAULT_SPAM_IDENTIFY_MIN_SCORE);
            await saveConfig(config);
            if (config.spamAvatarOcrEnabled !== false) {
                void preloadAvatarOcrEngineForUi(nextEngine);
            } else {
                setAvatarOcrEngineUiStatus('idle');
            }
            const userData = await loadUserData();
            if (userData) {
                const manualHandles = panel.querySelector('#nuke-promo-targets-textarea').value.split('\n').map(normalizePromoHandle).filter(Boolean);
                userData.promoTargets = mergePromoTargetEntries(userData.promoTargets, manualHandles, { sourceNote: '手动添加' });
                await saveUserData(userData);
            }
            showToast('nuke-config-toast', '设置已更新', '配置已成功保存', 3000);
        });
        panel.querySelector('#nuke-log-search').addEventListener('input', renderListsInPanel);
        panel.querySelector('#nuke-whitelist-search').addEventListener('input', renderListsInPanel);
        panel.querySelector('#nuke-promo-search').addEventListener('input', renderListsInPanel);
        if (typeof panel.showModal === 'function' && !panel.open) panel.showModal();
        panel.style.visibility = 'hidden';
        await renderListsInPanel();
        placeDialogInViewport(panel, { center: true });
        panel.style.visibility = '';
        focusDialogSurface(panel, '#nuke-keywords-standard-textarea');
    } finally { setTimeout(() => { isConfigPanelBusy = false; }, 200); }
}
function escapeHtml(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const SPAM_ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const SPAM_CJK_PUNCT_RE = /[·•・|，,。.!！?？:：;；\-—_~～*＊/\\[\]【】()（）「」『』《》〈〉"'‘’“”\s]/g;
const SPAM_SIGNAL_DEFS = [
    { id: 'scroll_time', label: '刷帖/逛推时长', weight: 1, test: (compact) => /(?:刷|逛|翻|看|扫).{0,12}?(?:半天|一晚|一天|一晚上|好久|很久|许久|好一会|一会儿|一会|小时)/.test(compact) || /刚.{0,4}?(?:刷|逛|翻)完/.test(compact) },
    { id: 'platform_ref', label: '提及X/推特', weight: 1, test: (compact) => /(?:^|[^a-z])x(?:[^a-z]|$)/i.test(compact) || /推特|小蓝鸟|twitter/.test(compact) },
    { id: 'profile_cta', label: '主页/空间导流', weight: 1, test: (compact) => /主页|个人页|主頁|空间|置顶|简介|资料|链接在|点主页|戳主页|看她主页|看他主页|她主页|他主页/.test(compact) },
    { id: 'adult_euphemism', label: '色情暗语/飞机', weight: 1, test: (compact, raw) => /打.{0,3}?飞|能飞|起飞|开飞|✈|🛫|🛩|飞机|打飞机|打飞機/.test(compact + raw) || /舅舅|涩涩|资源|福利|懂的都懂/.test(compact) },
    { id: 'age_tag', label: '年龄标签(30+等)', weight: 1, test: (compact, raw) => /\d{2}\+/.test(compact + raw) || /(?:20|30|40|五十|四十|三十|二十)多/.test(compact) || /三十加|四十加|二十加/.test(compact) },
    { id: 'persona_role', label: '职业/人设套词', weight: 1, test: (compact) => /体制内|女老师|老师|护士|御姐|人妻|空姐|校花|女大|熟女|少妇|萝莉|模特|舞蹈生|考研生|女高|单亲|宝妈/.test(compact) },
    { id: 'explore_tease', label: '探路/花样暗示', weight: 1, test: (compact) => /已探路|探过路|探路|花样多|花样不少|玩法多|会玩|懂玩|经验丰富|去过都说|真会玩/.test(compact) },
    { id: 'lewd_reaction', label: '色情反应话术', weight: 1, test: (compact) => /太涩|好涩|真涩|涩了|色了|太色|好色|顶不住|受不了|扛不住|绷不住|把持不住|定力不够|真顶|顶不住/.test(compact) },
    { id: 'lewd_slang', label: '骚/谐音sao', weight: 1, test: (compact) => /骚货|骚的很|很骚|太骚|真骚|骚死|骚批|比.*?骚/.test(compact) || /sao货|sao的很|sao死|sao批|很sao|真sao|太sao|巨sao|sao女|sao姐|sao哥/.test(compact) || /比她sao|比他还sao|没人比.{0,8}?sao|比.*sao/.test(compact) },
    { id: 'mention_promo', label: '@导流', weight: 1, test: (compact, raw) => /@[a-z0-9_]{2,}/i.test(raw) || /就.{0,8}?@|去@|看@|戳@|关注@/.test(compact) },
    { id: 'dating_hook', label: '交友/同城套词', weight: 1, test: (compact) => /同城|附近|搭子|固炮|真人|线下|见面|私聊|dd|约会|少妇|姐姐|妹妹/.test(compact) },
    { id: 'drive_link', label: '网盘链接', weight: 2, test: (compact, raw) => /pan\.quark\.cn|drive\.uc\.cn|aliyundrive\.com|115\.com|lanzou|mega\.nz/i.test(raw) },
    { id: 'core_template', label: '核心话术模板', weight: 2, test: (compact) => /刷.{0,18}?(?:半天|一晚|一天|一晚上|好久|很久).{0,24}?(?:x|推特|小蓝鸟).{0,18}?(?:她|他|这)?.{0,18}?主.?页.{0,24}?(?:打.{0,4}?飞|✈|起飞|能飞)/.test(compact) || /刷.{0,12}?(?:x|推特).{0,18}?主.?页.{0,18}?(?:打.{0,4}?飞|✈)/.test(compact) }
];
function normalizeSpamText(text) {
    let s = String(text || '');
    try { s = s.normalize('NFKC'); } catch { /* ignore */ }
    s = s.replace(SPAM_ZERO_WIDTH_RE, '').replace(/[Ⅹⅹ❌✖️]/g, 'x').replace(/[＠﹫]/g, '@').replace(/[ｘＸ]/g, 'x').replace(/\uFE0F/g, '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+\d+\s*(?:[iyh]|s)\s*$/i, '').trim();
    return s;
}
function compactSpamText(text) {
    return normalizeSpamText(text).replace(SPAM_CJK_PUNCT_RE, '').toLowerCase();
}
function detectSpamReply(text, options = {}) {
    const minScore = options.minScore ?? scriptConfig.spamIdentifyMinScore ?? DEFAULT_SPAM_IDENTIFY_MIN_SCORE;
    const raw = normalizeSpamText(text);
    if (!raw || raw.length < 8) return { match: false, score: 0, signals: [], summary: '' };
    if (!/[\u4e00-\u9fff]/.test(raw) && !/pan\.quark|drive\.uc/i.test(raw)) return { match: false, score: 0, signals: [], summary: '' };
    const compact = compactSpamText(raw);
    const signals = [];
    let score = 0;
    for (const def of SPAM_SIGNAL_DEFS) {
        if (def.test(compact, raw)) {
            signals.push({ id: def.id, label: def.label, weight: def.weight });
            score += def.weight;
        }
    }
    const coreIds = new Set(['scroll_time', 'platform_ref', 'profile_cta', 'adult_euphemism', 'mention_promo']);
    const coreHits = signals.filter((s) => coreIds.has(s.id)).length;
    const templateHit = signals.some((s) => s.id === 'core_template');
    const driveHit = signals.some((s) => s.id === 'drive_link');
    const euphemismAtProfile = signals.some((s) => s.id === 'adult_euphemism') && signals.some((s) => s.id === 'profile_cta') && signals.some((s) => s.id === 'mention_promo');
    const mentionHit = signals.some((s) => s.id === 'mention_promo');
    const lewdReactionHit = signals.some((s) => s.id === 'lewd_reaction');
    const lewdSlangHit = signals.some((s) => s.id === 'lewd_slang');
    const personaHit = signals.some((s) => s.id === 'persona_role');
    const exploreHit = signals.some((s) => s.id === 'explore_tease');
    const ageHit = signals.some((s) => s.id === 'age_tag');
    let match = score >= minScore;
    if (!match && templateHit) match = true;
    if (!match && driveHit && score >= 2) match = true;
    if (!match && euphemismAtProfile && coreHits >= 2) match = true;
    if (!match && coreHits >= 4) match = true;
    if (!match && mentionHit && lewdReactionHit) match = true;
    if (!match && mentionHit && lewdSlangHit) match = true;
    if (!match && mentionHit && personaHit && (exploreHit || ageHit || lewdReactionHit || lewdSlangHit)) match = true;
    if (!match && mentionHit && exploreHit && personaHit) match = true;
    if (!match && mentionHit && ageHit && personaHit) match = true;
    return { match, score, signals, summary: signals.map((s) => s.label).join('、') };
}
function getTweetTextFromArticle(article) {
    return article?.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
}
function normalizePromoHandle(handle) {
    return String(handle || '').trim().replace(/^@+/, '').toLowerCase();
}
function extractMentionHandlesFromText(text, excludeHandles = []) {
    const exclude = new Set((excludeHandles || []).map(normalizePromoHandle).filter(Boolean));
    const handles = new Set();
    const source = String(text || '');
    for (const match of source.matchAll(/@([a-z0-9_]{1,15})/gi)) {
        const handle = normalizePromoHandle(match[1]);
        if (handle && !exclude.has(handle)) handles.add(handle);
    }
    return [...handles];
}
function extractMentionHandlesFromArticle(article, authorHandle = '') {
    const exclude = [authorHandle, currentUserScreenName].map(normalizePromoHandle).filter(Boolean);
    const text = getTweetTextFromArticle(article);
    const handles = extractMentionHandlesFromText(text, exclude);
    article?.querySelectorAll('a[href*="/"]').forEach((link) => {
        const handle = normalizePromoHandle(getScreenNameFromProfileHref(link.href));
        if (!handle || exclude.includes(handle)) return;
        if (/\/status\/\d+/i.test(link.href)) return;
        handles.push(handle);
    });
    return [...new Set(handles)];
}
function getMatchedPromoTargetInTweet(tweetText, promoTargets = []) {
    const targetSet = new Set((promoTargets || []).map((entry) => normalizePromoHandle(entry.screenName)).filter(Boolean));
    if (!targetSet.size) return null;
    return extractMentionHandlesFromText(tweetText, []).find((handle) => targetSet.has(handle)) || null;
}
function mergePromoTargetEntries(existing = [], handles = [], meta = {}) {
    const byHandle = new Map((existing || []).map((entry) => [normalizePromoHandle(entry.screenName), entry]));
    const now = Date.now();
    handles.map(normalizePromoHandle).filter(Boolean).forEach((screenName) => {
        const prev = byHandle.get(screenName);
        byHandle.set(screenName, {
            userId: prev?.userId || meta.userId || null,
            screenName,
            userNameText: prev?.userNameText || meta.userNameText || screenName,
            addedAt: prev?.addedAt || now,
            sourceNote: meta.sourceNote || prev?.sourceNote || '手动添加',
            lastSeenAt: now
        });
    });
    return [...byHandle.values()].sort((a, b) => (b.lastSeenAt || b.addedAt || 0) - (a.lastSeenAt || a.addedAt || 0));
}
async function blockPromoTargetHandle(handle, userData, tweetContext, whitelistIds, exemptHandles) {
    const normalized = normalizePromoHandle(handle);
    if (!normalized || exemptHandles.includes(normalized) || normalized === normalizePromoHandle(currentUserScreenName)) return false;
    const existingIds = new Set([...userData.queue.map((u) => u.userId), ...userData.blockedLog.map((u) => u.userId)]);
    let userResult;
    try {
        userResult = await getUserDataByScreenName(normalized);
    } catch (error) {
        console.warn(`[CB] 无法获取引流目标 @${normalized}`, error);
        return false;
    }
    const userId = userResult?.rest_id;
    if (!userId || whitelistIds.has(userId) || existingIds.has(userId)) return false;
    await blockUserById(userId);
    userData.blockedLog.push({
        userId,
        screenName: normalized,
        userNameText: userResult.core?.name || userResult.legacy?.name || normalized,
        blockTimestamp: Date.now(),
        blockReason: 'promo_target',
        blockNote: `引流目标·@${normalized}${formatTweetContextSuffix(tweetContext)}`.trim(),
        sourceTweetId: tweetContext.tweetId || null,
        sourceTweetUrl: tweetContext.tweetUrl || '',
        sourceTweetText: tweetContext.tweetText || ''
    });
    const limit = scriptConfig.blockLogLimit || 500;
    if (limit > 0) { while (userData.blockedLog.length > limit) userData.blockedLog.shift(); }
    return true;
}
async function processPromoMentionsFromArticle(targetArticle, tweetContext, userData, authorHandle, whitelistIds, exemptHandles) {
    const mentions = extractMentionHandlesFromArticle(targetArticle, authorHandle);
    if (!mentions.length) return { added: [], blocked: 0 };
    userData.promoTargets = mergePromoTargetEntries(userData.promoTargets, mentions, {
        sourceNote: `九族收录·@${authorHandle || '未知'}`
    });
    let blocked = 0;
    for (const handle of mentions) {
        if (await blockPromoTargetHandle(handle, userData, tweetContext, whitelistIds, exemptHandles)) blocked += 1;
    }
    await saveUserData(userData);
    if (blocked > 0) {
        showToast('nuke-promo-target-toast', '引流目标已拉黑', `已拉黑 ${blocked} 个推文 @ 用户并加入列表`, 3500);
    }
    return { added: mentions, blocked };
}
function normalizeOcrText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
}
function upgradeProfileImageUrl(url) {
    const src = String(url || '').trim();
    if (!src) return '';
    return src.replace(/_(normal|bigger|mini|x96)(?=\.[a-z])/i, '_400x400');
}
function avatarImageFetchCandidates(url) {
    const src = String(url || '').trim();
    if (!src) return [];
    const candidates = [];
    const add = (candidate) => {
        if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };
    add(upgradeProfileImageUrl(src));
    add(src);
    if (/_normal(?=\.[a-z])/i.test(src)) add(src.replace(/_normal(?=\.[a-z])/i, '_bigger'));
    if (/_400x400(?=\.[a-z])/i.test(src)) add(src.replace(/_400x400(?=\.[a-z])/i, '_normal'));
    return candidates;
}
function getAvatarImageElement(article) {
    return [...(article?.querySelectorAll('img') || [])].find((node) => /profile_images|twimg\.com/i.test(node.currentSrc || node.src || node.getAttribute('data-src') || ''));
}
function getAvatarImageUrlFromArticle(article) {
    const img = getAvatarImageElement(article);
    return (img?.currentSrc || img?.src || img?.getAttribute('data-src') || '').trim();
}
function resolveAvatarKeywordPatterns() {
    const dedicated = scriptConfig.spamAvatarKeywords;
    if (Array.isArray(dedicated) && dedicated.length) return dedicated.filter(Boolean);
    return (scriptConfig.blockKeywordsStandard || []).filter(Boolean);
}
function hasRegexMeta(text) {
    return /[\\^$.*+?()[\]{}|]/.test(String(text || ''));
}
function levenshteinDistance(a, b, maxDistance = Infinity) {
    const left = String(a || '');
    const right = String(b || '');
    if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
    let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
        const curr = [i];
        let rowMin = curr[0];
        for (let j = 1; j <= right.length; j += 1) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            const value = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost
            );
            curr[j] = value;
            if (value < rowMin) rowMin = value;
        }
        if (rowMin > maxDistance) return maxDistance + 1;
        prev = curr;
    }
    return prev[right.length];
}
function commonSubsequenceLength(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    let prev = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i += 1) {
        const curr = new Array(right.length + 1).fill(0);
        for (let j = 1; j <= right.length; j += 1) {
            curr[j] = left[i - 1] === right[j - 1]
                ? prev[j - 1] + 1
                : Math.max(prev[j], curr[j - 1]);
        }
        prev = curr;
    }
    return prev[right.length];
}
function matchesFuzzyOcrKeyword(compact, keyword) {
    const target = normalizeOcrText(keyword);
    if (target.length < 4 || hasRegexMeta(target)) return false;
    if (compact.includes(target)) return true;
    const maxDistance = target.length <= 4 ? 2 : Math.max(2, Math.floor(target.length * 0.34));
    const minCommon = target.length - maxDistance;
    const minLen = Math.max(1, target.length - maxDistance);
    const maxLen = target.length + maxDistance;
    for (let start = 0; start < compact.length; start += 1) {
        for (let len = minLen; len <= maxLen && start + len <= compact.length; len += 1) {
            const candidate = compact.slice(start, start + len);
            if (commonSubsequenceLength(candidate, target) < minCommon) continue;
            if (levenshteinDistance(candidate, target, maxDistance) <= maxDistance) return true;
        }
    }
    return false;
}
function matchesAvatarOcrKeywords(ocrText, patterns = []) {
    const compact = normalizeOcrText(ocrText);
    if (!compact) return { match: false, hit: '' };
    if (!patterns.length) return { match: false, hit: '' };
    for (const pattern of patterns) {
        if (!pattern) continue;
        try {
            if (new RegExp(pattern, 'i').test(compact)) return { match: true, hit: pattern };
        } catch {
            if (compact.toLowerCase().includes(String(pattern).toLowerCase())) return { match: true, hit: pattern };
        }
        if (matchesFuzzyOcrKeyword(compact, pattern)) return { match: true, hit: pattern };
    }
    return { match: false, hit: '' };
}
function detectPromoAvatarSignature(imageUrl, ocrText, patterns) {
    const imageId = extractTwitterProfileImageId(imageUrl);
    const keywordHit = matchesAvatarOcrKeywords(ocrText, patterns);
    if (keywordHit.match) {
        return { match: true, hit: keywordHit.hit, source: 'ocr', imageId };
    }
    return { match: false, hit: '', source: 'none', imageId };
}
function fetchImageArrayBuffer(url) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'arraybuffer',
            onload: (response) => {
                if (response.status >= 200 && response.status < 300 && response.response?.byteLength > 64) {
                    resolve(response.response);
                } else {
                    reject(new Error(`avatar fetch ${response.status}`));
                }
            },
            onerror: () => reject(new Error('avatar fetch network error'))
        });
    });
}
async function fetchAvatarImageArrayBuffer(imageUrl) {
    const candidates = avatarImageFetchCandidates(imageUrl);
    let lastError = null;
    for (const url of candidates) {
        try {
            return await fetchImageArrayBuffer(url);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('avatar fetch failed');
}
function getActiveAvatarOcrEngineForUi() {
    const selectEl = document.querySelector('#nuke-spam-avatar-ocr-engine');
    if (selectEl) return normalizeAvatarOcrEngine(selectEl.value);
    return getAvatarOcrEngine();
}
function noteAvatarOcrError(error, engine = getActiveAvatarOcrEngineForUi()) {
    try {
        document.documentElement.dataset.cbSpamOcrLastError = formatAvatarOcrError(error, '').slice(0, 160);
        document.documentElement.dataset.cbSpamOcrEngine = engine;
    } catch {
        /* ignore */
    }
}
function markAvatarOcrEngineFailed(engine, error) {
    const normalized = normalizeAvatarOcrEngine(engine);
    const uiLoading = document.documentElement.dataset.cbSpamOcrUiState === 'loading';
    if (!uiLoading) {
        if (normalized === AVATAR_OCR_ENGINE_PADDLE) avatarOcrPaddleFailed = true;
        else avatarOcrTesseractFailed = true;
    }
    if (uiLoading && getActiveAvatarOcrEngineForUi() === normalized) {
        noteAvatarOcrError(error, normalized);
    }
}
function textFromPaddleBrowserResult(result) {
    if (!result) return '';
    if (Array.isArray(result.parragraphs)) {
        return normalizeOcrText(result.parragraphs.map((item) => item?.text || '').join(''));
    }
    if (Array.isArray(result)) {
        return normalizeOcrText(result.map((item) => (typeof item === 'string' ? item : item?.text || '')).join(''));
    }
    if (typeof result.text === 'string') return normalizeOcrText(result.text);
    return '';
}
function publishPaddleUserscriptHandle(handle) {
    paddleUserscriptHandle = handle;
    avatarOcrPaddleReady = true;
    try {
        getPageWindow().__cbPaddleBrowser = handle;
    } catch {
        /* ignore */
    }
}
function runSerializedAvatarOcrInit(task) {
    const run = avatarOcrInitSerial.then(() => task());
    avatarOcrInitSerial = run.catch(() => { /* keep queue alive */ });
    return run;
}
async function ensurePaddleUserscriptReady(onProgress) {
    return runSerializedAvatarOcrInit(() => ensurePaddleUserscriptReadyInner(onProgress));
}
async function ensurePaddleUserscriptReadyInner(onProgress) {
    const report = (pct, label) => {
        try {
            onProgress?.(pct, label);
        } catch {
            /* ignore */
        }
    };
    if (avatarOcrPaddleFailed) throw new Error('PaddleOCR 初始化已失败');
    if (!/^https?:$/i.test(location.protocol)) throw new Error('PaddleOCR 需要 https 页面');
    if (paddleUserscriptHandle?.ready) {
        report(100, 'PaddleOCR 已就绪');
        return paddleUserscriptHandle;
    }
    if (!paddleUserscriptInitPromise) {
        paddleUserscriptInitPromise = (async () => {
            report(8, '加载 OpenCV…');
            const cv = await ensureSandboxCv();
            if (!cv?.Mat) throw new Error('OpenCV 未就绪');
            report(18, '加载 ONNX Runtime…');
            const ortRef = ensureUserscriptOrt();
            report(28, '加载识别引擎…');
            const Paddle = await loadPaddleModule();
            report(32, '下载识别模型…');
            startPaddleUiProgressPulse(onProgress, 36);
            const [dic, detPath, recPath] = await Promise.all([
                gmFetchText(`${PADDLE_BROWSER_ASSETS}ppocr_keys_v1.txt`),
                gmFetchBlobUrl(`${PADDLE_BROWSER_ASSETS}ppocr_det.onnx`),
                gmFetchBlobUrl(`${PADDLE_BROWSER_ASSETS}ppocr_rec.onnx`)
            ]);
            report(52, '初始化 PaddleOCR…');
            await Paddle.init({
                detPath,
                recPath,
                dic,
                ort: ortRef,
                node: false,
                cv,
                dev: false
            });
            stopPaddleUiProgressPulse();
            return {
                ready: true,
                runOcr: (dataUrl) => Paddle.ocr(dataUrl)
            };
        })().then((handle) => {
            publishPaddleUserscriptHandle(handle);
            report(100, 'PaddleOCR 已就绪');
            return handle;
        }).catch((error) => {
            stopPaddleUiProgressPulse();
            paddleUserscriptInitPromise = null;
            markAvatarOcrEngineFailed(AVATAR_OCR_ENGINE_PADDLE, error);
            throw error;
        });
    } else if (onProgress) {
        report(12, '正在加载模型…');
        startPaddleUiProgressPulse(onProgress, 20);
    }
    return paddleUserscriptInitPromise;
}
async function getAvatarOcrWorker() {
    return runSerializedAvatarOcrInit(() => getAvatarOcrWorkerInner());
}
async function getAvatarOcrWorkerInner() {
    if (document.documentElement.dataset.cbSpamOcrUiState === 'loading') {
        avatarOcrTesseractFailed = false;
    }
    if (avatarOcrTesseractFailed) throw new Error('Tesseract 初始化已失败');
    if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js 未加载');
    if (!avatarOcrWorkerPromise) {
        const uiReport = document.documentElement.dataset.cbSpamOcrUiState === 'loading'
            ? (pct, label) => {
                const selectEl = document.querySelector('#nuke-spam-avatar-ocr-engine');
                if (!selectEl || normalizeAvatarOcrEngine(selectEl.value) !== AVATAR_OCR_ENGINE_TESSERACT) return;
                setAvatarOcrEngineUiStatus('loading', pct, label);
            }
            : null;
        avatarOcrWorkerPromise = ensureTesseractWorkerOptions(uiReport)
            .then((opts) => Tesseract.createWorker('chi_sim', 1, opts))
            .then(async (worker) => {
                if (typeof worker.setParameters === 'function') {
                    await worker.setParameters({ tessedit_pageseg_mode: '11' });
                }
                avatarOcrTesseractReady = true;
                return worker;
            })
            .catch((error) => {
                resetAvatarOcrWorker();
                markAvatarOcrEngineFailed(AVATAR_OCR_ENGINE_TESSERACT, error);
                avatarOcrTesseractReady = false;
                throw error;
            });
    }
    return avatarOcrWorkerPromise;
}
function warmUpAvatarOcr() {
    if (scriptConfig.spamIdentifyEnabled === false || scriptConfig.spamAvatarOcrEnabled === false) return;
    const engine = getAvatarOcrEngine();
    const report = (pct, label) => {
        const selectEl = document.querySelector('#nuke-spam-avatar-ocr-engine');
        if (!selectEl || normalizeAvatarOcrEngine(selectEl.value) !== engine) return;
        setAvatarOcrEngineUiStatus('loading', pct, label);
    };
    if (engine === AVATAR_OCR_ENGINE_PADDLE) {
        if (!avatarOcrPaddleFailed && !isAvatarOcrEngineReady(engine)) {
            void ensurePaddleUserscriptReady(report)
                .then(() => {
                    try {
                        document.documentElement.dataset.cbSpamOcrReady = '1';
                    } catch {
                        /* ignore */
                    }
                })
                .catch(() => { /* noted in ensurePaddleUserscriptReady */ });
        }
        return;
    }
    if (avatarOcrTesseractFailed || isAvatarOcrEngineReady(engine)) return;
    void loadTesseractForUi(report)
        .then(() => {
            try {
                document.documentElement.dataset.cbSpamOcrReady = '1';
            } catch {
                /* ignore */
            }
        })
        .catch(() => { /* noted in getAvatarOcrWorker */ });
}
const AVATAR_OCR_IMAGE_SCALE = 2.25;
async function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('avatar scale failed'));
        }, type, quality);
    });
}
function otsuThreshold(values) {
    const hist = new Array(256).fill(0);
    values.forEach((value) => { hist[value] += 1; });
    const total = values.length || 1;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];
    let sumB = 0;
    let weightB = 0;
    let best = 128;
    let bestScore = 0;
    for (let i = 0; i < 256; i += 1) {
        weightB += hist[i];
        if (!weightB) continue;
        const weightF = total - weightB;
        if (!weightF) break;
        sumB += i * hist[i];
        const meanB = sumB / weightB;
        const meanF = (sum - sumB) / weightF;
        const score = weightB * weightF * (meanB - meanF) * (meanB - meanF);
        if (score > bestScore) {
            bestScore = score;
            best = i;
        }
    }
    return best;
}
function processedAvatarCanvas(source, width, height, { channel = 'gray', invert = false, threshold = false } = {}) {
    const values = new Uint8ClampedArray(width * height);
    let min = 255;
    let max = 0;
    for (let i = 0; i < values.length; i += 1) {
        const j = i * 4;
        const r = source.data[j];
        const g = source.data[j + 1];
        const b = source.data[j + 2];
        let value = channel === 'min' ? Math.min(r, g, b) : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        if (invert) value = 255 - value;
        values[i] = value;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (max > min) {
        for (let i = 0; i < values.length; i += 1) {
            values[i] = Math.max(0, Math.min(255, Math.round((values[i] - min) * 255 / (max - min))));
        }
    }
    const thresholdValue = threshold ? otsuThreshold(values) : null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    const output = ctx.createImageData(width, height);
    for (let i = 0; i < values.length; i += 1) {
        const value = thresholdValue == null ? values[i] : (values[i] >= thresholdValue ? 255 : 0);
        const j = i * 4;
        output.data[j] = value;
        output.data[j + 1] = value;
        output.data[j + 2] = value;
        output.data[j + 3] = 255;
    }
    ctx.putImageData(output, 0, 0);
    return canvas;
}
async function createAvatarOcrImageBlobs(arrayBuffer) {
    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
    if (typeof createImageBitmap !== 'function') return [blob];
    const bitmap = await createImageBitmap(blob);
    const sourceSize = Math.max(bitmap.width || 0, bitmap.height || 0);
    const size = Math.max(576, Math.round(sourceSize * AVATAR_OCR_IMAGE_SCALE));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [blob];
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0, size, size);
    if (typeof bitmap.close === 'function') bitmap.close();
    const source = ctx.getImageData(0, 0, size, size);
    return [
        await canvasToBlob(canvas, 'image/jpeg', 0.95),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'gray' })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'gray', invert: true, threshold: true })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'min' }))
    ];
}
async function scaleAvatarBlobForOcr(arrayBuffer) {
    const blobs = await createAvatarOcrImageBlobs(arrayBuffer);
    return blobs[0];
}
async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('read image failed'));
        reader.readAsDataURL(blob);
    });
}
async function recognizeAvatarWithTesseract(arrayBuffer, patterns = []) {
    const blobs = await createAvatarOcrImageBlobs(arrayBuffer);
    const worker = await getAvatarOcrWorker();
    const texts = [];
    let lastError = null;
    for (const blob of blobs) {
        try {
            const { data: { text } } = await worker.recognize(blob);
            const compact = normalizeOcrText(text);
            if (compact && !texts.includes(compact)) texts.push(compact);
            const combined = texts.join('\n');
            if (matchesAvatarOcrKeywords(combined, patterns).match) return combined;
        } catch (error) {
            lastError = error;
        }
    }
    if (!texts.length && lastError) throw lastError;
    return texts.join('\n');
}
async function recognizeAvatarWithPaddleBrowser(arrayBuffer) {
    const scaledBlob = await scaleAvatarBlobForOcr(arrayBuffer);
    const paddle = await ensurePaddleUserscriptReady();
    const dataUrl = await blobToDataUrl(scaledBlob);
    const result = await paddle.runOcr(dataUrl);
    return textFromPaddleBrowserResult(result);
}
async function recognizeAvatarTextWithOcr(arrayBuffer, patterns = []) {
    if (getAvatarOcrEngine() === AVATAR_OCR_ENGINE_PADDLE) return recognizeAvatarWithPaddleBrowser(arrayBuffer);
    return recognizeAvatarWithTesseract(arrayBuffer, patterns);
}
async function analyzeAvatarImageBuffer(arrayBuffer, patterns, imageUrl = '') {
    const imageId = extractTwitterProfileImageId(imageUrl);
    if (isAvatarOcrEngineFailed()) {
        return { match: false, hit: '', source: 'none', imageId, ocrOk: false, ocrText: '' };
    }
    try {
        const ocrText = await recognizeAvatarTextWithOcr(arrayBuffer, patterns);
        const signature = detectPromoAvatarSignature(imageUrl, ocrText, patterns);
        return { ...signature, ocrOk: true, ocrText };
    } catch (error) {
        noteAvatarOcrError(error);
        return { match: false, hit: '', source: 'none', imageId, ocrOk: false, ocrText: '' };
    }
}
async function analyzeAvatarImageUrl(imageUrl, patterns) {
    const cached = avatarOcrCache.get(imageUrl);
    if (cached?.result?.match && Date.now() - cached.at < AVATAR_OCR_CACHE_MS) return cached.result;
    const buffer = await fetchAvatarImageArrayBuffer(imageUrl);
    const result = await analyzeAvatarImageBuffer(buffer, patterns, imageUrl);
    if (result.match) avatarOcrCache.set(imageUrl, { result, at: Date.now() });
    return result;
}
function ensureSpamBadge(article, detection, kind = 'text') {
    article.classList.add('nuke-spam-identified');
    let badge = article.querySelector('.nuke-spam-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'nuke-spam-badge';
        const anchor = article.querySelector('div[data-testid="tweetText"]');
        if (anchor?.parentElement) anchor.parentElement.insertBefore(badge, anchor);
        else article.prepend(badge);
    }
    if (kind === 'avatar') {
        const avatarPart = `头像·${detection.summary}`;
        if (badge.textContent && badge.textContent.includes('疑似引流')) {
            badge.title = `${badge.title || ''}\n头像 OCR: ${detection.summary}`;
            badge.textContent = `${badge.textContent}；${avatarPart}`;
        } else {
            badge.title = `头像 OCR 命中: ${detection.summary}`;
            badge.textContent = `头像疑似引流 · ${detection.summary}`;
        }
    } else {
        badge.title = `${detection.summary}\n得分: ${detection.score}`;
        badge.textContent = `疑似引流 · ${detection.score}分`;
    }
}
function finalizeSpamArticleScan(article) {
    if (!article) return;
    delete article.dataset.avatarOcrPending;
    delete article.dataset.avatarOcrQueued;
    delete article.dataset.avatarOcrQueuedAt;
    article.dataset.spamScanned = 'complete';
}
function releaseAvatarOcrForRetry(article) {
    if (!article) return;
    removeAvatarOcrJobsForArticle(article);
    delete article.dataset.avatarOcrPending;
    delete article.dataset.avatarOcrQueued;
    delete article.dataset.avatarOcrQueuedAt;
    delete article.dataset.spamScanned;
}
function removeAvatarOcrJobsForArticle(article) {
    if (!article) return;
    for (let i = avatarOcrQueue.length - 1; i >= 0; i -= 1) {
        if (avatarOcrQueue[i]?.article === article) avatarOcrQueue.splice(i, 1);
    }
}
function enqueueAvatarOcr(article, imageUrl) {
    if (article.dataset.avatarOcrPending === 'true' || article.dataset.avatarOcrQueued === 'true') return;
    removeAvatarOcrJobsForArticle(article);
    article.dataset.avatarOcrQueued = 'true';
    article.dataset.avatarOcrPending = 'true';
    article.dataset.avatarOcrQueuedAt = String(Date.now());
    avatarOcrQueue.push({ article, imageUrl });
    void pumpAvatarOcrQueue();
}
function hasStaleAvatarOcrPending(article) {
    if (article?.dataset?.avatarOcrPending !== 'true') return false;
    const queuedAt = parseInt(article.dataset.avatarOcrQueuedAt, 10) || 0;
    return !queuedAt || Date.now() - queuedAt > AVATAR_OCR_STALE_PENDING_MS;
}
function isArticleInViewport(article) {
    if (!article?.isConnected) return false;
    const rect = article.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
}
function takeNextAvatarOcrJob() {
    const visibleIndex = avatarOcrQueue.findIndex((job) => isArticleInViewport(job?.article));
    if (visibleIndex > 0) return avatarOcrQueue.splice(visibleIndex, 1)[0];
    return avatarOcrQueue.shift();
}
async function pumpAvatarOcrQueue() {
    if (avatarOcrPumpRunning) return;
    avatarOcrPumpRunning = true;
    const patterns = resolveAvatarKeywordPatterns();
    while (avatarOcrQueue.length) {
        const job = takeNextAvatarOcrJob();
        if (!job?.article?.isConnected) continue;
        if (shouldDeferBackgroundAvatarOcr()) {
            avatarOcrQueue.unshift(job);
            await new Promise((resolve) => window.setTimeout(resolve, 400));
            continue;
        }
        let matched = false;
        try {
            if (scriptConfig.spamIdentifyEnabled === false || scriptConfig.spamAvatarOcrEnabled === false) {
                if (job.article?.isConnected) finalizeSpamArticleScan(job.article);
                continue;
            }
            const analysis = await analyzeAvatarImageUrl(job.imageUrl, patterns);
            if (analysis.match) {
                ensureSpamBadge(job.article, { match: true, score: 1, summary: analysis.hit || '头像关键词' }, 'avatar');
                matched = true;
            }
        } catch (error) {
            noteAvatarOcrError(error);
            const failCount = (parseInt(job.article.dataset.avatarOcrFailCount, 10) || 0) + 1;
            job.article.dataset.avatarOcrFailCount = String(failCount);
            console.warn(`[CB] 头像识别失败 (${failCount}/${AVATAR_OCR_MAX_FAILS})`, job.imageUrl, error);
            if (failCount < AVATAR_OCR_MAX_FAILS) {
                releaseAvatarOcrForRetry(job.article);
                continue;
            }
        }
        if (job.article?.isConnected) finalizeSpamArticleScan(job.article);
        await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    avatarOcrPumpRunning = false;
    if (avatarOcrQueue.length) void pumpAvatarOcrQueue();
}
async function processSpamArticle(article) {
    if (shouldSkipSpamArticleScan(article)) return;
    const tweetText = getTweetTextFromArticle(article);
    if (tweetText) {
        const detection = detectSpamReply(tweetText);
        if (detection.match) ensureSpamBadge(article, detection, 'text');
    }
    const avatarUrl = getAvatarImageUrlFromArticle(article);
    if (avatarUrl && !shouldSkipAvatarOcrForArticle(article) && scriptConfig.spamAvatarOcrEnabled !== false) {
        enqueueAvatarOcr(article, avatarUrl);
        return;
    }
    finalizeSpamArticleScan(article);
}
const SPAM_EXPAND_LABEL_RE = /垃圾|spam|冒犯|offensive|可疑|probable|隐藏|更多回复|additional repl|显示可能的垃圾|可能含有垃圾/i;
const HIDDEN_SPAM_EXPAND_RE = /显示可能的垃圾|Show probable spam|probable spam|可能含有垃圾|冒犯性回复|Offensive replies/i;
function tryExpandHiddenSpamReplies() {
    if (scriptConfig.spamAutoExpandHidden === false || scriptConfig.spamIdentifyEnabled === false) return;
    if (!/\/status\/\d+/i.test(window.location.pathname)) return;
    if (window.__cbHiddenSpamExpandPath === window.location.pathname) return;
    const expandButton = [...document.querySelectorAll('[role="button"], button, a, div[tabindex="0"]')].find((element) => {
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        return text && text.length <= 120 && HIDDEN_SPAM_EXPAND_RE.test(text);
    });
    if (!expandButton) return;
    window.__cbHiddenSpamExpandPath = window.location.pathname;
    expandButton.click();
    scheduleSpamRescan([400, 1000, 2000, 3500]);
}
let spamScanDebounceId = null;
function articleHasAvatarSpamBadge(article) {
    const badge = article?.querySelector('.nuke-spam-badge');
    return !!(badge && /头像|全国安排/.test(badge.textContent || ''));
}
function shouldSkipSpamArticleScan(article) {
    if (hasStaleAvatarOcrPending(article)) {
        releaseAvatarOcrForRetry(article);
        return false;
    }
    if (article.dataset.avatarOcrPending === 'true') return true;
    if (article.dataset.spamScanned !== 'complete') return false;
    if (articleHasAvatarSpamBadge(article)) return true;
    const textBadge = article.querySelector('.nuke-spam-badge');
    if (textBadge && !/头像|全国安排/.test(textBadge.textContent || '')) return true;
    if (scriptConfig.spamAvatarOcrEnabled !== false && getAvatarImageUrlFromArticle(article) && !shouldSkipAvatarOcrForArticle(article)) {
        const failCount = parseInt(article.dataset.avatarOcrFailCount, 10) || 0;
        if (failCount < AVATAR_OCR_MAX_FAILS) {
            delete article.dataset.spamScanned;
            delete article.dataset.avatarOcrQueued;
            delete article.dataset.avatarOcrPending;
            return false;
        }
    }
    return true;
}
function isSpamSectionExpandControl(element) {
    if (!element) return false;
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 140) return false;
    return SPAM_EXPAND_LABEL_RE.test(text);
}
function scheduleSpamRescan(extraDelaysMs = [300, 900, 1800]) {
    scheduleSpamRescanDebounced();
    extraDelaysMs.forEach((ms) => {
        window.setTimeout(scanSpamIdentifyContent, ms);
        window.setTimeout(scanAndProcessContent, ms);
    });
}
function scheduleSpamRescanDebounced() {
    if (spamScanDebounceId) clearTimeout(spamScanDebounceId);
    spamScanDebounceId = window.setTimeout(() => {
        spamScanDebounceId = null;
        scanSpamIdentifyContent();
        scanAndProcessContent();
    }, 120);
}
function scanSpamIdentifyContent() {
    if (!currentUserId || scriptConfig.spamIdentifyEnabled === false) return;
    if (!isUrlMatch(window.location.href, scriptConfig.effectiveUrls || [])) return;
    resetSpamScanMarkersForBuildUpgrade();
    markStatusRootTweetArticles();
    tryExpandHiddenSpamReplies();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        void processSpamArticle(article);
    });
    try {
        const avatarBadges = document.querySelectorAll('article[data-testid="tweet"] .nuke-spam-badge');
        let avatarHits = 0;
        avatarBadges.forEach((node) => {
            if (/头像|全国安排/.test(node.textContent || '')) avatarHits += 1;
        });
        document.documentElement.dataset.cbSpamScannerBuild = SPAM_SCANNER_BUILD;
        document.documentElement.dataset.cbSpamAvatarBadgeCount = String(avatarHits);
        document.documentElement.dataset.cbSpamOcrEngine = getAvatarOcrEngine();
        document.documentElement.dataset.cbSpamOcrInitFailed = isAvatarOcrEngineFailed() ? '1' : '0';
        document.documentElement.dataset.cbSpamOcrQueueLen = String(avatarOcrQueue.length);
        document.documentElement.dataset.cbSpamOcrPending = String(document.querySelectorAll('article[data-avatar-ocr-pending="true"]').length);
    } catch {
        /* probe only */
    }
}
async function inspectTweetArticleForSpam(article) {
    const userLink = article.querySelector('div[data-testid="User-Name"] a[role="link"]');
    const screenName = getScreenNameFromProfileHref(userLink?.href) || '未知';
    const tweetText = getTweetTextFromArticle(article);
    let summary = '';
    if (tweetText) {
        const detection = detectSpamReply(tweetText);
        if (detection.match) {
            ensureSpamBadge(article, detection, 'text');
            summary = `${detection.summary}（${detection.score}分）`;
        }
    }
    const avatarUrl = getAvatarImageUrlFromArticle(article);
    if (avatarUrl && !shouldSkipAvatarOcrForArticle(article) && scriptConfig.spamAvatarOcrEnabled !== false) {
        try {
            const analysis = await analyzeAvatarImageUrl(avatarUrl, resolveAvatarKeywordPatterns());
            if (analysis.match) {
                ensureSpamBadge(article, { match: true, score: 1, summary: analysis.hit }, 'avatar');
                summary = summary ? `${summary}；头像:${analysis.hit}` : `头像:${analysis.hit}`;
            }
        } catch (error) {
            console.warn('[CB] 手动头像识别失败', error);
        }
    }
    if (summary) {
        showToast('nuke-spam-inspect-toast', `⚠️ 疑似引流 @${screenName}`, summary, 5000);
    } else if (!tweetText && !avatarUrl) {
        showToast('nuke-spam-inspect-toast', '无法识别', '没有推文正文或头像图片', 2600);
    } else {
        showToast('nuke-spam-inspect-toast', `未命中 @${screenName}`, '推文得分不足且头像 OCR 未命中', 3500);
    }
    finalizeSpamArticleScan(article);
}
function truncateBlockContextText(text, maxLen = BLOCK_CONTEXT_TEXT_MAX) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, maxLen - 1)}…`;
}
function formatTweetContextSuffix(context = {}) {
    const parts = [];
    const tweetText = truncateBlockContextText(context.tweetText);
    if (tweetText) parts.push(`「${tweetText}」`);
    if (context.tweetUrl) parts.push(context.tweetUrl);
    return parts.length ? ` ${parts.join(' ')}` : '';
}
function formatChainSourcesLabel(chainSources = []) {
    const labels = { retweet: '转推', reply: '回复', like: '点赞' };
    return [...new Set(chainSources)].map((source) => labels[source]).filter(Boolean).join('/') || '关联';
}
function resolveAuthorBlockReason(trigger = {}) {
    if (trigger.triggerMode === 'manual') return 'manual_author';
    if (trigger.autoReason === 'promo_target_mention') return 'auto_promo_target';
    if (trigger.autoReason === 'standard_keywords') return 'auto_author_keyword';
    if (trigger.autoReason === 'long_name_structure') return 'auto_author_long_name';
    return 'manual_author';
}
function buildAuthorBlockNote(trigger, context = {}) {
    const reason = resolveAuthorBlockReason(trigger);
    const reasonLabels = {
        manual_author: '九族拉黑·主推',
        auto_promo_target: '自动九族·引流目标',
        auto_author_keyword: '自动拉黑·关键词',
        auto_author_long_name: '自动拉黑·长用户名'
    };
    const handle = context.authorHandle ? `@${context.authorHandle}` : '该用户';
    let blockNote = `${reasonLabels[reason] || '拉黑·主推'} ${handle} 的推文${formatTweetContextSuffix(context)}`.trim();
    if (reason === 'auto_promo_target' && trigger.promoTargetHandle) {
        blockNote += `（命中 @${trigger.promoTargetHandle}）`;
    }
    if (reason === 'auto_author_keyword' && trigger.suspiciousDisplayName) {
        blockNote += `（显示名: ${truncateBlockContextText(trigger.suspiciousDisplayName, 60)}）`;
    }
    return { blockReason: reason, blockNote };
}
function buildChainBlockNote(chainSources, context = {}) {
    const handle = context.authorHandle ? `@${context.authorHandle}` : '某用户';
    const blockReason = chainSources.length === 1 ? `chain_${chainSources[0]}` : 'chain_mixed';
    const blockNote = `九族·${formatChainSourcesLabel(chainSources)} ${handle} 的推文${formatTweetContextSuffix(context)}`.trim();
    return { blockReason, blockNote };
}
function getTweetContextFromTarget(targetArticle, authorHandle) {
    const tweetTextEl = targetArticle?.querySelector?.('[data-testid="tweetText"]');
    const statusLink = targetArticle ? Array.from(targetArticle.querySelectorAll('a')).find(a => /\/status\/\d+/.test(a.href)) : null;
    const tweetId = statusLink?.href.match(/\/status\/(\d+)/)?.[1] || null;
    const handle = authorHandle || getScreenNameFromProfileHref(statusLink?.href) || '';
    const tweetUrl = tweetId && handle ? `https://x.com/${handle}/status/${tweetId}` : (statusLink?.href?.split('?')[0] || '');
    return {
        tweetId,
        tweetUrl,
        tweetText: truncateBlockContextText(tweetTextEl?.textContent?.trim() || ''),
        authorHandle: handle
    };
}
function createQueueEntryFromUser(userResult, chainSources, context) {
    const meta = buildChainBlockNote(chainSources, context);
    return {
        userId: userResult.rest_id,
        screenName: userResult.core?.screen_name || userResult.legacy?.screen_name,
        userNameText: userResult.core?.name || userResult.legacy?.name,
        chainSources: [...chainSources],
        sourceTweetId: context.tweetId || null,
        sourceTweetUrl: context.tweetUrl || '',
        sourceTweetText: truncateBlockContextText(context.tweetText),
        sourceAuthorHandle: context.authorHandle || '',
        blockReason: meta.blockReason,
        blockNote: meta.blockNote
    };
}
function mergeQueueEntries(existingEntry, incomingEntry, context) {
    const chainSources = [...new Set([...(existingEntry.chainSources || []), ...(incomingEntry.chainSources || [])])];
    const meta = buildChainBlockNote(chainSources, context);
    return { ...existingEntry, ...incomingEntry, chainSources, blockReason: meta.blockReason, blockNote: meta.blockNote };
}
function createAuthorLogEntry(authorId, authorHandle, authorUserNameText, trigger, context) {
    const meta = buildAuthorBlockNote(trigger, context);
    return {
        userId: authorId,
        screenName: authorHandle,
        userNameText: authorUserNameText,
        blockTimestamp: Date.now(),
        sourceTweetId: context.tweetId || null,
        sourceTweetUrl: context.tweetUrl || '',
        sourceTweetText: truncateBlockContextText(context.tweetText),
        sourceAuthorHandle: context.authorHandle || authorHandle,
        ...meta
    };
}
function addUsersToChainQueue(queueById, users, chainSource, context) {
    users.forEach((userResult) => {
        if (!userResult?.rest_id) return;
        const incoming = createQueueEntryFromUser(userResult, [chainSource], context);
        const existing = queueById.get(userResult.rest_id);
        queueById.set(userResult.rest_id, existing ? mergeQueueEntries(existing, incoming, context) : incoming);
    });
}
async function renderListsInPanel() {
    const userData = await loadUserData();
    if (!userData) return;
    const logSearchTerm = document.getElementById('nuke-log-search')?.value.toLowerCase() || '';
    const whitelistSearchTerm = document.getElementById('nuke-whitelist-search')?.value.toLowerCase() || '';
    const promoSearchTerm = document.getElementById('nuke-promo-search')?.value.toLowerCase() || '';
    const filterUsers = (user, term) => {
        if (!term) return true;
        const userId = String(user.userId || '');
        const screenName = user.screenName?.toLowerCase() || '';
        const userNameText = user.userNameText?.toLowerCase() || '';
        const blockNote = user.blockNote?.toLowerCase() || '';
        const blockReason = user.blockReason?.toLowerCase() || '';
        const sourceTweetText = user.sourceTweetText?.toLowerCase() || '';
        const sourceNote = user.sourceNote?.toLowerCase() || '';
        return userId.includes(term) || screenName.includes(term) || userNameText.includes(term) || blockNote.includes(term) || blockReason.includes(term) || sourceTweetText.includes(term) || sourceNote.includes(term);
    };
    const renderList = (containerSelector, list, type) => {
        const container = document.querySelector(containerSelector);
        if (!container) return;
        const searchTerm = type === 'log' ? logSearchTerm : (type === 'promo' ? promoSearchTerm : whitelistSearchTerm);
        const filteredList = list.filter(user => filterUsers(user, searchTerm));
        container.innerHTML = '';
        if (filteredList.length === 0) {
            const emptyMessages = { log: '暂无拉黑记录', whitelist: '白名单为空', promo: '暂无引流目标' };
            const message = searchTerm ? '没有找到匹配的用户' : (emptyMessages[type] || '列表为空');
            container.innerHTML = `<p style="color:#8899a6;text-align:center;padding:20px 0;">${message}</p>`;
            return;
        }
        filteredList.slice().reverse().forEach(entry => {
            const el = document.createElement('div');
            el.className = 'nuke-list-entry';
            const userName = entry.userNameText || entry.screenName || String(entry.userId);
            const screenNameHandle = entry.screenName ? `@${entry.screenName}` : '';
            const userLinkHTML = entry.screenName ? `<a href="https://x.com/${entry.screenName}" target="_blank" rel="noopener noreferrer" title="在新标签页中打开"><span class="nuke-list-user-name">${userName}</span></a>` : `<span class="nuke-list-user-name">${userName}</span>`;
            if (type === 'log') {
                const timestamp = entry.blockTimestamp ? new Date(entry.blockTimestamp).toLocaleString() : '未知时间';
                const blockReasonHTML = entry.blockNote ? `<span class="nuke-list-block-reason">${escapeHtml(entry.blockNote)}</span>` : '';
                el.innerHTML = `<div class="nuke-list-user-info">${userLinkHTML}<span class="nuke-list-user-handle" title="移至白名单并取消拉黑">${screenNameHandle}</span>${blockReasonHTML}</div><span class="nuke-list-actions" title="从记录中移除">${timestamp}</span>`;
                if (entry.screenName) {
                    el.querySelector('.nuke-list-user-handle')?.addEventListener('click', () => moveUser(entry, 'logToWhitelist'));
                } else {
                    const userNameEl = el.querySelector('.nuke-list-user-name');
                    if (userNameEl) {
                        userNameEl.style.cursor = 'pointer';
                        userNameEl.title = '移至白名单并取消拉黑';
                        userNameEl.addEventListener('click', () => moveUser(entry, 'logToWhitelist'));
                    }
                }
                el.querySelector('.nuke-list-actions')?.addEventListener('click', () => moveUser(entry, 'removeFromLog'));
            } else if (type === 'promo') {
                const timestamp = entry.addedAt ? new Date(entry.addedAt).toLocaleString() : '未知时间';
                const noteHTML = entry.sourceNote ? `<span class="nuke-list-block-reason">${escapeHtml(entry.sourceNote)}</span>` : '';
                el.innerHTML = `<div class="nuke-list-user-info">${userLinkHTML}<span class="nuke-list-user-handle">${screenNameHandle}</span>${noteHTML}</div><span class="nuke-list-actions" title="从引流目标列表移除">移除</span>`;
                el.querySelector('.nuke-list-actions')?.addEventListener('click', async () => {
                    const data = await loadUserData();
                    if (!data?.promoTargets) return;
                    data.promoTargets = data.promoTargets.filter((e) => normalizePromoHandle(e.screenName) !== normalizePromoHandle(entry.screenName));
                    await saveUserData(data);
                    const textarea = document.getElementById('nuke-promo-targets-textarea');
                    if (textarea) textarea.value = data.promoTargets.map((e) => e.screenName).join('\n');
                    await renderListsInPanel();
                });
            } else {
                el.innerHTML = `<div class="nuke-list-user-info">${userLinkHTML}<span class="nuke-list-user-handle">${screenNameHandle}</span></div><span class="nuke-list-actions" title="从白名单中移除">移除</span>`;
                el.querySelector('.nuke-list-actions')?.addEventListener('click', () => moveUser(entry, 'removeFromWhitelist'));
            }
            container.appendChild(el);
        });
    };
    renderList('#nuke-log-content .nuke-list', userData.blockedLog, 'log');
    renderList('#nuke-whitelist-content .nuke-list', userData.whitelist, 'whitelist');
    renderList('#nuke-promo-content .nuke-list', userData.promoTargets || [], 'promo');
}
async function moveUser(user, action) {
    const userData = await loadUserData();
    if (!userData) return;
    const logIndex = userData.blockedLog.findIndex(u => u.userId === user.userId);
    const whitelistIndex = userData.whitelist.findIndex(u => u.userId === user.userId);
    let success = false;
    try {
        if (action === 'logToWhitelist') {
            if (logIndex > -1) {
                await unblockUserById(user.userId);
                const [movedUser] = userData.blockedLog.splice(logIndex, 1);
                if (whitelistIndex === -1) userData.whitelist.push(movedUser);
                success = true;
            }
        } else if (action === 'removeFromLog') {
            if (logIndex > -1) { userData.blockedLog.splice(logIndex, 1); success = true; }
        } else if (action === 'removeFromWhitelist') {
            if (whitelistIndex > -1) { userData.whitelist.splice(whitelistIndex, 1); success = true; }
        }
        if(success) {
            await saveUserData(userData);
            await renderListsInPanel();
        }
    } catch(err) {
        console.error(`[CB] ${action} failed for ${user.screenName || user.userId}:`, err);
        showToast('nuke-feedback-toast', '❌ 操作失败', `无法为 @${user.screenName || user.userId} 执行操作`, 4000);
    }
}

// --- API & HELPERS ---
const API_ENDPOINTS = {
    UserByScreenName: { hash: 'jUKA--0QkqGIFhmfRZdWrQ', features: {"responsive_web_grok_bio_auto_translation_is_enabled":false,"hidden_profile_subscriptions_enabled":true,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_feature_can_gift_premium":true,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true} },
    UserByRestId: { hash: 'tD4_0f_p354q1Yin156s2Q', features: {"responsive_web_grok_bio_auto_translation_is_enabled":false,"hidden_profile_subscriptions_enabled":true,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_feature_can_gift_premium":true,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true} },
    Retweeters: { hash: 'DmC_H6eV_XMiL0g4ltJvpg', features: {"rweb_video_screen_enabled":false,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":false,"responsive_web_grok_share_attachment_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_enhance_cards_enabled":false} },
    Favoriters: { hash: 'SoWvHOdzCsomAQdY-bFNDA', features: {"rweb_video_screen_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":false,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_enhance_cards_enabled":false} },
    TweetDetail: { hash: '-0WTL1e9Pij-JWAF5ztCCA', features: {"rweb_video_screen_enabled":false,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":false,"responsive_web_grok_share_attachment_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_enhance_cards_enabled":false} }
};
function makeApiRequest(url, method = "GET", data = null) { return new Promise((resolve, reject) => GM_xmlhttpRequest({ method, url, data, headers: { Authorization: `Bearer ${getAuthToken()}`, "Content-Type": "application/x-www-form-urlencoded", "x-csrf-token": getCsrfToken() }, onload: r => r.status >= 200 && r.status < 300 ? resolve(r.responseText ? JSON.parse(r.responseText) : null) : reject({ message: `API请求失败: ${r.status}`, status: r.status }), onerror: e => reject({ message: "Network or script error", error: e }) })); }
function getCsrfToken() { const e = document.cookie.split("; ").find(e => e.startsWith("ct0=")); return e ? e.split("=")[1] : null; }
function getAuthToken() { return "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"; }
async function getUserDataByScreenName(screenName) {
    const endpoint = API_ENDPOINTS.UserByScreenName;
    const url = `https://x.com/i/api/graphql/${endpoint.hash}/UserByScreenName?variables=${encodeURIComponent(JSON.stringify({screen_name:screenName,withSafetyModeUserFields:true}))}&features=${encodeURIComponent(JSON.stringify(endpoint.features))}`;
    const data = await makeApiRequest(url);
    if (data?.data?.user?.result) return data.data.user.result;
    throw new Error(`无法找到用户 @${screenName} 的数据`);
}
async function getUserDataById(userId) {
    const endpoint = API_ENDPOINTS.UserByRestId;
    const url = `https://x.com/i/api/graphql/${endpoint.hash}/UserByRestId?variables=${encodeURIComponent(JSON.stringify({userId,withSafetyModeUserFields:true}))}&features=${encodeURIComponent(JSON.stringify(endpoint.features))}`;
    const data = await makeApiRequest(url);
    if (data?.data?.user?.result) return data.data.user.result;
    throw new Error(`无法找到用户 ID: ${userId} 的数据`);
}
function getFollowersCountFromUserResult(userResult) {
    const legacyCount = userResult?.legacy?.followers_count;
    if (typeof legacyCount === 'number' && !Number.isNaN(legacyCount)) return legacyCount;
    const directCount = userResult?.followers_count;
    if (typeof directCount === 'number' && !Number.isNaN(directCount)) return directCount;
    return null;
}
function matchesStandardKeywords(userNameText, patterns) {
    if (!userNameText || !patterns?.length) return false;
    return patterns.some((pattern) => {
        if (!pattern) return false;
        try {
            return new RegExp(pattern, 'i').test(userNameText);
        } catch (e) {
            return userNameText.toLowerCase().includes(String(pattern).toLowerCase());
        }
    });
}
function matchesLongNameStructure(userNameText) {
    if (!userNameText || userNameText.length <= USERNAME_LENGTH_THRESHOLD) return false;
    const hasChinese = /[\u4e00-\u9fa5]/.test(userNameText);
    const slashCount = (userNameText.match(/\//g) || []).length;
    return hasChinese && slashCount >= 2;
}
function getAutoBlockDecision(userNameText, followerCount) {
    const exemptThreshold = scriptConfig.longNameFollowerExemptThreshold ?? DEFAULT_LONG_NAME_FOLLOWER_EXEMPT_THRESHOLD;
    if (matchesStandardKeywords(userNameText, scriptConfig.blockKeywordsStandard || [])) {
        return { block: true, reason: 'standard_keywords' };
    }
    if (!matchesLongNameStructure(userNameText)) return { block: false, reason: 'no_match' };
    if (followerCount == null || Number.isNaN(followerCount)) return { block: false, reason: 'follower_unknown' };
    if (followerCount <= exemptThreshold) return { block: true, reason: 'long_name_structure' };
    return { block: false, reason: 'follower_exempt' };
}
function getScreenNameFromProfileHref(href) {
    if (!href) return '';
    try {
        const pathname = new URL(href, window.location.origin).pathname;
        return pathname.split('/').filter(Boolean)[0] || '';
    } catch {
        return href.split('/').pop()?.split('?')[0] || '';
    }
}
async function getCachedFollowerCount(screenName) {
    if (!screenName) return null;
    const key = screenName.toLowerCase();
    const cached = followerCountCache.get(key);
    if (cached && Date.now() - cached.at < FOLLOWER_COUNT_CACHE_MS) return cached.count;
    if (followerFetchPending.has(key)) return followerFetchPending.get(key);
    const pending = (async () => {
        try {
            const userResult = await getUserDataByScreenName(screenName);
            const count = getFollowersCountFromUserResult(userResult);
            followerCountCache.set(key, { count, at: Date.now() });
            return count;
        } catch (error) {
            console.warn(`[CB] 无法获取 @${screenName} 的粉丝数`, error);
            return null;
        } finally {
            followerFetchPending.delete(key);
        }
    })();
    followerFetchPending.set(key, pending);
    return pending;
}
async function maybeAutoBlockTarget(targetArticle, userNameText, screenName) {
    if (!userNameText) return;
    if (matchesLongNameStructure(userNameText) && !matchesStandardKeywords(userNameText, scriptConfig.blockKeywordsStandard || []) && !screenName) {
        console.warn('[CB] 长用户名规则命中但无法解析 @handle，已跳过自动拉黑');
        return;
    }
    const decision = await evaluateUsernameAutoBlock(userNameText, screenName);
    if (!decision.block) {
        if (decision.reason === 'follower_exempt') {
            console.log(`[CB] 跳过长用户名自动拉黑 @${screenName} (粉丝数 ${followerCount} > 阈值 ${scriptConfig.longNameFollowerExemptThreshold ?? DEFAULT_LONG_NAME_FOLLOWER_EXEMPT_THRESHOLD})`);
        }
        return;
    }
    if (screenName) {
        showToast(`nuke-auto-trigger-toast-${Date.now()}`, '🤖 自动执行拉黑', `检测到可疑用户名: ${screenName}`, 4000);
    }
    void initiateNukeProcess(targetArticle, { triggerMode: 'auto', autoReason: decision.reason, suspiciousDisplayName: userNameText });
}
async function getRetweetersData(tweetId, onProgress) {
    let users = new Map(), cursor = null, endpoint = API_ENDPOINTS.Retweeters;
    do {
        onProgress(`正在获取转推列表...(已找到: ${users.size})`);
        const url = `https://x.com/i/api/graphql/${endpoint.hash}/Retweeters?variables=${encodeURIComponent(JSON.stringify({tweetId,count:100,cursor,includePromotedContent:true}))}&features=${encodeURIComponent(JSON.stringify(endpoint.features))}`;
        const data = await makeApiRequest(url);
        const entries = data?.data?.retweeters_timeline?.timeline?.instructions?.find(i=>i.type==='TimelineAddEntries')?.entries;
        if (!entries) break;
        let foundNewUsers = false;
        for (const entry of entries) {
            if (entry.entryId.startsWith('user-')) {
                const userResult = entry.content?.itemContent?.user_results?.result;
                if (userResult?.rest_id && !users.has(userResult.rest_id)) { users.set(userResult.rest_id, userResult); foundNewUsers = true; }
            } else if (entry.entryId.startsWith('cursor-bottom-')) { cursor = entry.content.value; }
        }
        if (!foundNewUsers || !cursor) break;
    } while (cursor);
    return Array.from(users.values());
}
async function getFavoritersData(tweetId, onProgress) {
    let users = new Map(), cursor = null, endpoint = API_ENDPOINTS.Favoriters;
    do {
        onProgress(`正在获取点赞列表...(已找到: ${users.size})`);
        const url = `https://x.com/i/api/graphql/${endpoint.hash}/Favoriters?variables=${encodeURIComponent(JSON.stringify({tweetId,count:100,cursor,includePromotedContent:true}))}&features=${encodeURIComponent(JSON.stringify(endpoint.features))}`;
        const data = await makeApiRequest(url);
        const entries = data?.data?.favoriters_timeline?.timeline?.instructions?.find(i=>i.type==='TimelineAddEntries')?.entries;
        if (!entries) break;
        let foundNewUsers = false;
        for (const entry of entries) {
            if (entry.entryId.startsWith('user-')) {
                const userResult = entry.content?.itemContent?.user_results?.result;
                if (userResult?.rest_id && !users.has(userResult.rest_id)) { users.set(userResult.rest_id, userResult); foundNewUsers = true; }
            } else if (entry.entryId.startsWith('cursor-bottom-')) { cursor = entry.content.value; }
        }
        if (!foundNewUsers || !cursor) break;
    } while (cursor);
    return Array.from(users.values());
}
async function getRepliersData(tweetId, onProgress) {
    let users = new Map(), cursor = null, endpoint = API_ENDPOINTS.TweetDetail;
    const baseVariables = {"with_rux_injections":false,"includePromotedContent":true,"withCommunity":true,"withQuickPromoteEligibilityTweetFields":true,"withBirdwatchNotes":true,"withVoice":true,"withV2Timeline":true};
    do {
        onProgress(`正在获取回复列表...(已找到: ${users.size})`);
        const variables = {...baseVariables, focalTweetId: tweetId, cursor, count: 40, rankingMode:"Relevance"};
        const url = `https://x.com/i/api/graphql/${endpoint.hash}/TweetDetail?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(endpoint.features))}`;
        const data = await makeApiRequest(url);
        const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
        const entriesInstruction = instructions.find(i => i.type === 'TimelineAddEntries');
        const entries = entriesInstruction?.entries;
        if (!entries) break;
        let nextCursor = null;
        let foundNewUsersInPage = false;
        for (const entry of entries) {
            if (entry.entryId.startsWith('conversationthread-')) {
                const threadItems = entry.content?.items;
                if(threadItems && Array.isArray(threadItems)){
                    for(const item of threadItems){
                        const userResult = item.item?.itemContent?.tweet_results?.result?.core?.user_results?.result;
                        if (userResult?.rest_id && !users.has(userResult.rest_id)) {
                            users.set(userResult.rest_id, userResult);
                            foundNewUsersInPage = true;
                        }
                    }
                }
            } else if (entry.entryId.startsWith('tweet-')) {
                const userResult = entry.content?.itemContent?.tweet_results?.result?.core?.user_results?.result;
                if (userResult?.rest_id && !users.has(userResult.rest_id)) {
                   users.set(userResult.rest_id, userResult);
                   foundNewUsersInPage = true;
                }
            } else if (entry.entryId.startsWith('cursor-bottom-')) {
                nextCursor = entry.content.value;
            }
        }
        if (cursor === nextCursor || !foundNewUsersInPage) break;
        cursor = nextCursor;
    } while (cursor);
    return Array.from(users.values());
}
async function blockUserById(userId) { return makeApiRequest("https://x.com/i/api/1.1/blocks/create.json", "POST", `user_id=${userId}`); }
async function unblockUserById(userId) { return makeApiRequest("https://x.com/i/api/1.1/blocks/destroy.json", "POST", `user_id=${userId}`); }

// --- DATA & QUEUE MANAGEMENT ---
async function loadUserData() {
    if (!currentUserId) return null;
    const allData = await GM_getValue(STORAGE_KEY, {});
    let userData = allData[currentUserId];
    if (!userData || typeof userData !== 'object') userData = { queue: [], blockedLog: [], whitelist: [] };
    if (!Array.isArray(userData.queue)) userData.queue = [];
    if (!Array.isArray(userData.blockedLog)) userData.blockedLog = [];
    if (!Array.isArray(userData.whitelist)) userData.whitelist = [];
    if (!Array.isArray(userData.promoTargets)) userData.promoTargets = [];
    if (userData.spamIdentifyLog) {
        delete userData.spamIdentifyLog;
        allData[currentUserId] = userData;
        await GM_setValue(STORAGE_KEY, allData);
    }
    return { ...userData, lastBlockTimestamp: 0 };
}
async function saveUserData(data) {
    if (!currentUserId) return;
    const allData = await GM_getValue(STORAGE_KEY, {});
    allData[currentUserId] = data;
    await GM_setValue(STORAGE_KEY, allData);
}

// --- UI & FEEDBACK ---
function showToast(id, title, status, duration = null) {
    let toast = document.getElementById(id);
    if (!toast) {
        toast = document.createElement('div');
        toast.id = id;
        toast.className = 'nuke-toast';
        document.body.appendChild(toast);
    }
    const existingToasts = document.querySelectorAll('.nuke-toast:not([style*="display: none"])');
    toast.style.top = `${20 + (existingToasts.length - 1) * 70}px`;
    toast.classList.remove('fading-out');
    toast.innerHTML = `<div class="nuke-toast-title">${title}</div><div class="nuke-toast-status">${status}</div>`;
    const reorderToasts = () => {
        const remainingToasts = Array.from(document.querySelectorAll('.nuke-toast')).filter(t => t.id !== id);
        remainingToasts.forEach((t, index) => {
            t.style.top = `${20 + index * 70}px`;
        });
    };
    if (duration) {
        setTimeout(() => {
            toast.classList.add('fading-out');
            setTimeout(() => {
                toast.remove();
                reorderToasts();
            }, 500);
        }, duration);
    }
}
async function updateStatusToast() {
    const userData = await loadUserData();
    if (!userData || userData.queue.length === 0) {
        let toast = document.getElementById('nuke-status-toast');
        if (toast) { toast.classList.add('fading-out'); setTimeout(() => toast.remove(), 500); }
        return;
    }
    showToast('nuke-status-toast', `🚀 九族拉黑队列(@${currentUserScreenName||'...'})`, `<b>待处理:</b> ${userData.queue.length}<br><b>已拉黑:</b> ${userData.blockedLog.length || 0}`);
}
function hideElement(element) {
    if (!element) return;
    element.style.cssText += 'transition:all .4s ease-out;max-height:0;opacity:0;padding:0;margin:0;border-width:0;';
    setTimeout(() => element.remove(), 400);
}
function closeMenuFromEvent(event) {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return false;
    const dropdownRoot = target.closest('div[data-testid="Dropdown"]') || target.closest('[data-testid="Dropdown"]');
    const menuNode = target.closest('div[role="menu"]') || target.closest('[role="menu"]');
    const removableContainer = dropdownRoot?.parentElement || menuNode?.parentElement;
    if (menuNode) {
        const escapeEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true
        });
        menuNode.dispatchEvent(escapeEvent);
        document.dispatchEvent(escapeEvent);
        if (removableContainer) {
            window.setTimeout(() => {
                if (menuNode.isConnected && removableContainer.isConnected) {
                    removableContainer.remove();
                }
            }, 120);
        }
        return true;
    }
    if (removableContainer) {
        removableContainer.remove();
        return true;
    }
    return false;
}
function showVerificationModal(userNameText) {
    closeDialogSurface(document.getElementById('nuke-verify-modal'));
    const modal = document.createElement('dialog');
    modal.id = 'nuke-verify-modal';
    modal.className = 'nuke-verify-modal';
    modal.innerHTML = `
        <div class="nuke-panel-header">
            <div class="nuke-header-item left">
                <button class="nuke-close-button" aria-label="关闭"><svg viewBox="0 0 24 24"><g><path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"></path></g></svg></button>
            </div>
            <h2 class="nuke-config-title">验证用户名</h2>
            <div class="nuke-header-item right"></div>
        </div>
        <div class="nuke-panel-content">
            <p class="nuke-verify-note">这是 scraper 抓到的用户名，可直接复制后用于关键词设置。</p>
            <textarea class="nuke-verify-textarea" readonly></textarea>
            <div class="nuke-config-button-container">
                <button class="nuke-config-button copy" type="button">复制用户名</button>
            </div>
        </div>`;
    modal.tabIndex = -1;
    const closeModal = () => closeDialogSurface(modal);
    const textarea = modal.querySelector('.nuke-verify-textarea');
    textarea.value = userNameText;
    modal.querySelector('.nuke-close-button').addEventListener('click', closeModal);
    modal.querySelector('.nuke-config-button.copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(userNameText);
            showToast('nuke-verify-copy-toast', '已复制', '用户名已复制到剪贴板', 2000);
        } catch (error) {
            console.warn('[CB] Failed to copy verified username:', error);
            textarea.focus();
            textarea.select();
            showToast('nuke-verify-copy-toast', '复制失败', '已为你选中文本，可手动复制', 2500);
        }
    });
    modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeModal();
    });
    initializeDialogSurface(modal, { initialFocusSelector: '.nuke-verify-textarea', selectInitialText: true });
}
async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        console.warn('[CB] Clipboard API copy failed:', error);
    }
    try {
        const fallback = document.createElement('textarea');
        fallback.value = text;
        fallback.setAttribute('readonly', 'readonly');
        fallback.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
        document.body.appendChild(fallback);
        fallback.focus();
        fallback.select();
        const copied = document.execCommand('copy');
        fallback.remove();
        return copied;
    } catch (error) {
        console.warn('[CB] execCommand copy failed:', error);
        return false;
    }
}
async function handleVerifiedUserName(userNameText) {
    const copied = await copyTextToClipboard(userNameText);
    if (copied) {
        showToast('nuke-verify-copy-toast', '用户名已复制', `已复制: ${userNameText}`, 2600);
        return;
    }
    showVerificationModal(userNameText);
}

// --- CORE LOGIC ---
async function processQueue() {
    if (isProcessingQueue || !currentUserId) return;
    const userData = await loadUserData();
    if (!userData || userData.queue.length === 0 || (Date.now() - userData.lastBlockTimestamp < BLOCK_INTERVAL_MS)) return;
    isProcessingQueue = true;
    let userToBlock = userData.queue[0];
    try {
        if (!userToBlock.screenName || !userToBlock.userNameText) {
            try {
                const fullUserData = await getUserDataById(userToBlock.userId);
                userToBlock.screenName = fullUserData.core?.screen_name || fullUserData.legacy?.screen_name;
                userToBlock.userNameText = fullUserData.core?.name || fullUserData.legacy?.name;
            } catch (fetchError) {
                console.warn(`[CB] 获取用户 ${userToBlock.userId} 的详细信息失败，将使用现有数据继续。`, fetchError);
            }
        }
        await blockUserById(userToBlock.userId);
        userData.queue.shift();
        userData.blockedLog.push({ ...userToBlock, blockTimestamp: Date.now(), blockNote: userToBlock.blockNote || '', blockReason: userToBlock.blockReason || '' });
        const limit = scriptConfig.blockLogLimit || 500;
        if (limit > 0) { while (userData.blockedLog.length > limit) userData.blockedLog.shift(); }
        userData.lastBlockTimestamp = Date.now();
    } catch (error) {
        console.error(`[Chain Blocker] 拉黑 @${userToBlock.screenName || userToBlock.userId} 失败，移除.`, error);
        userData.queue.shift();
    } finally {
        await saveUserData(userData);
        await updateStatusToast();
        isProcessingQueue = false;
    }
}
function getExemptHandles() {
    const exemptHandles = [];
    const pathParts = window.location.pathname.split('/');
    if (pathParts[2] === 'status') {
        exemptHandles.push(pathParts[1]);
    }
    return exemptHandles;
}
async function initiateNukeProcess(targetArticle, trigger = { triggerMode: 'manual' }) {
    const exemptHandles = getExemptHandles();
    showToast('nuke-fetch-toast', '🚀 九族拉黑已启动', '正在处理...', null);
    hideElement(targetArticle);
    try {
        const userLink = targetArticle.querySelector('div[data-testid="User-Name"] a[role="link"]');
        const authorHandle = getScreenNameFromProfileHref(userLink?.href) || userLink?.href.split('/').pop()?.split('?')[0];
        const authorUserNameText = targetArticle.querySelector('div[data-testid="User-Name"] a[role="link"] span')?.textContent?.trim() || authorHandle;
        if (!authorHandle) throw new Error("无法确定作者 handle");
        const tweetContext = getTweetContextFromTarget(targetArticle, authorHandle);
        const userData = await loadUserData();
        if (!userData) throw new Error("无法加载用户数据");
        const whitelistIds = new Set(userData.whitelist.map(u => u.userId));
        let authorId = null;
        try {
            const authorData = await getUserDataByScreenName(authorHandle);
            authorId = authorData?.rest_id;
            if (!authorId) throw new Error(`无法获取 @${authorHandle} 的用户ID`);
            if (whitelistIds.has(authorId) || exemptHandles.includes(authorHandle)) {
                showToast('nuke-fetch-toast', '🛡️ 用户在白名单或豁免列表', `已跳过拉黑 @${authorHandle}`, 4000);
            } else {
                await blockUserById(authorId);
                userData.blockedLog.push(createAuthorLogEntry(authorId, authorHandle, authorUserNameText, trigger, tweetContext));
                const limit = scriptConfig.blockLogLimit || 500;
                if (limit > 0) { while (userData.blockedLog.length > limit) userData.blockedLog.shift(); }
                await saveUserData(userData);
                showToast('nuke-fetch-toast', '✅ 作者已拉黑并记录', `已立刻拉黑 @${authorHandle}`, 2000);
            }
        } catch (authorError) { console.error(`[CB] 拉黑作者 @${authorHandle} 失败:`, authorError); }
        await processPromoMentionsFromArticle(targetArticle, tweetContext, userData, authorHandle, whitelistIds, exemptHandles);
        const tweetId = tweetContext.tweetId;
        if (!tweetId) return;
        const onCollectProgress = status => showToast('nuke-fetch-toast', '收集中...', status, null);
        const favoritersPromise = getFavoritersData(tweetId, onCollectProgress).catch(error => {
            console.warn('[CB] 获取点赞列表失败，将跳过点赞关联用户', error);
            return [];
        });
        const [retweeters, repliers, favoriters] = await Promise.all([
            getRetweetersData(tweetId, onCollectProgress),
            getRepliersData(tweetId, onCollectProgress),
            favoritersPromise
        ]);
        const queueById = new Map();
        addUsersToChainQueue(queueById, retweeters, 'retweet', tweetContext);
        addUsersToChainQueue(queueById, repliers, 'reply', tweetContext);
        addUsersToChainQueue(queueById, favoriters, 'like', tweetContext);
        if (authorId) queueById.delete(authorId);
        const existingUserIds = new Set([...userData.queue.map(u => u.userId), ...userData.blockedLog.map(u => u.userId), ...whitelistIds]);
        const newUsersToQueue = Array.from(queueById.values()).filter(u => u.userId && u.userId !== currentUserId && !existingUserIds.has(u.userId) && !exemptHandles.includes(u.screenName));
        if (newUsersToQueue.length > 0) {
            userData.queue.push(...newUsersToQueue);
            await saveUserData(userData);
            showToast('nuke-fetch-toast', '✅ 操作成功', `已将 ${newUsersToQueue.length} 个相关用户加入拉黑队列。`, 4000);
        } else {
            showToast('nuke-fetch-toast', 'ℹ️ 操作完成', `没有找到新的可拉黑用户。`, 4000);
        }
        await updateStatusToast();
        setTimeout(processQueue, 1000);
    } catch (error) { console.error("[CB] 收集过程中发生错误:", error); showToast(`nuke-fetch-toast`, '❌ 发生错误', error.message, 5000); }
}

// --- UI SCANNING & AUTOMATION ---
function isUrlMatch(url, patterns) { return patterns.some(p => new RegExp('^' + p.replace(/\*/g, '.*') + '$').test(url)); }
function getUsernameFromElement(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('img[alt]').forEach(img => {
        img.replaceWith(document.createTextNode(img.alt));
    });
    return clone.textContent.trim();
}
function getDisplayNameFromUserLink(userLink) {
    if (!userLink) return '';
    const candidates = [
        userLink.querySelector(':scope > div > div:first-child'),
        userLink.querySelector('div[dir="ltr"]'),
        userLink.querySelector('span')
    ];
    for (const el of candidates) {
        const text = getUsernameFromElement(el);
        if (text) return text;
    }
    const raw = getUsernameFromElement(userLink);
    if (!raw) return '';
    const handle = getScreenNameFromProfileHref(userLink.href);
    if (!handle) return raw;
    return raw.replace(new RegExp(`@?${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim() || raw;
}
async function evaluateUsernameAutoBlock(userNameText, screenName) {
    const needsFollowerCheck = matchesLongNameStructure(userNameText) && !matchesStandardKeywords(userNameText, scriptConfig.blockKeywordsStandard || []);
    let followerCount = null;
    if (needsFollowerCheck && screenName) followerCount = await getCachedFollowerCount(screenName);
    return getAutoBlockDecision(userNameText, followerCount);
}
async function processAutoBlockArticle(article, userData) {
    if (article.dataset.autoblockTriggered === 'true') return;
    const userLink = article.querySelector('div[data-testid="User-Name"] a[role="link"]');
    const userNameText = getDisplayNameFromUserLink(userLink);
    const screenName = getScreenNameFromProfileHref(userLink?.href);
    const tweetText = getTweetTextFromArticle(article);

    if (userNameText) {
        const decision = await evaluateUsernameAutoBlock(userNameText, screenName);
        if (decision.block) {
            article.dataset.autoblockTriggered = 'true';
            article.dataset.autoblockChecked = 'complete';
            if (screenName) {
                showToast(`nuke-auto-trigger-toast-${Date.now()}`, '🤖 自动执行拉黑', `检测到可疑用户名: ${screenName}`, 4000);
            }
            void initiateNukeProcess(article, { triggerMode: 'auto', autoReason: decision.reason, suspiciousDisplayName: userNameText });
            return;
        }
    }

    if (tweetText && userData?.promoTargets?.length) {
        const matched = getMatchedPromoTargetInTweet(tweetText, userData.promoTargets);
        if (matched) {
            article.dataset.autoblockTriggered = 'true';
            article.dataset.autoblockChecked = 'complete';
            void initiateNukeProcess(article, {
                triggerMode: 'auto',
                autoReason: 'promo_target_mention',
                promoTargetHandle: matched
            });
            return;
        }
    }

    const waitingForTweet = Boolean(userData?.promoTargets?.length) && !tweetText;
    const waitingForName = Boolean(userLink) && !userNameText;
    if (!waitingForTweet && !waitingForName) {
        article.dataset.autoblockChecked = 'complete';
    }
}
function scanAndProcessContent() {
    document.querySelectorAll('div[data-testid="cellInnerDiv"]:not([style*="display: none"]) button[data-testid$="-unblock"]').forEach(btn => btn.closest('div[data-testid="cellInnerDiv"]').style.display = 'none');
    if (!currentUserId || !scriptConfig.autoBlockEnabled || !isUrlMatch(window.location.href, scriptConfig.effectiveUrls || [])) return;
    void loadUserData().then((userData) => {
        if (!userData) return;
        document.querySelectorAll('article[data-testid="tweet"]:not([data-autoblock-checked])').forEach((article) => {
            void processAutoBlockArticle(article, userData);
        });
    });
    document.querySelectorAll('div[data-testid="UserCell"]:not([data-autoblock-checked])').forEach(cell => {
        cell.dataset.autoblockChecked = 'true';
        const userLink = cell.querySelector('a[role="link"]');
        const userNameText = getDisplayNameFromUserLink(userLink);
        const screenName = getScreenNameFromProfileHref(userLink?.href) || cell.querySelector('a[role="link"] span')?.textContent.trim() || '';
        void maybeAutoBlockTarget(cell.closest('div[data-testid="cellInnerDiv"]'), userNameText, screenName);
    });
}
function addNukeButton(menuNode) {
    if (menuNode.querySelector('.nuke-button')) return;
    const blockMenuItem = Array.from(menuNode.querySelectorAll('div[role="menuitem"]')).find(el => el.textContent.includes('@'));
    if (!blockMenuItem) return;
    const nukeButton = blockMenuItem.cloneNode(true);
    nukeButton.classList.add('nuke-button');
    const span = nukeButton.querySelector('span');
    if (span) {
        span.textContent = MENU_ITEM_TEXT;
        span.style.color = 'rgb(244, 33, 46)';
    }
    const biohazardIconPath = "M19.5,12c0,2.9-1.6,5.5-4,6.8V21h-7v-2.2c-2.4-1.3-4-3.9-4-6.8c0-4.1,3.4-7.5,7.5-7.5S19.5,7.9,19.5,12z M12,6c-2.2,0-4,1.8-4,4s1.8,4,4,4s4-1.8,4-4S14.2,6,12,6z M12,14c-1.1,0-2-0.9-2-2c0-0.4,0.1-0.7,0.3-1H10v-2h1.3c-0.2-0.3-0.3-0.6-0.3-1c0-1.1,0.9-2,2-2s2,0.9,2,2c0,0.4-0.1,0.7-0.3,1H14v2h-1.3c0.2,0.3,0.3,0.6,0.3,1C14,13.1,13.1,14,12,14z";
    const svgIcon = nukeButton.querySelector('svg');
    if (svgIcon) {
        svgIcon.innerHTML = `<g><path d="${biohazardIconPath}" fill="currentColor"></path></g>`;
        svgIcon.style.color = 'rgb(244, 33, 46)';
    }
    nukeButton.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        closeMenuFromEvent(e);
        if (activeTweetArticle) initiateNukeProcess(activeTweetArticle, { triggerMode: 'manual' });
    });
    const separator = document.createElement('div');
    separator.setAttribute('role', 'separator');
    separator.style.cssText = 'border-bottom:1px solid rgb(56,68,77);margin:4px 0;';
    blockMenuItem.after(separator, nukeButton);
}
function addVerificationButton(menuNode) {
    if (menuNode.querySelector('.nuke-verify-button')) return;
    const nukeButton = menuNode.querySelector('.nuke-button');
    if (!nukeButton) return;
    const verifyButton = nukeButton.cloneNode(true);
    verifyButton.classList.remove('nuke-button');
    verifyButton.classList.add('nuke-verify-button');
    const span = verifyButton.querySelector('span');
    if (span) {
        span.textContent = "🔍 验证用户名";
        span.style.color = 'rgb(29, 155, 240)';
    }
    const svgIcon = verifyButton.querySelector('svg');
    if (svgIcon) {
        const searchIconPath = "M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.62 0 3.1-.59 4.25-1.57l3.44 3.44c.29.29.77.29 1.06 0s.29-.77 0-1.06l-3.44-3.44c.98-1.15 1.57-2.63 1.57-4.25 0-3.59-2.91-6.5-6.5-6.5zm-6.5 1.5c2.69 0 4.9 2.21 4.9 4.9s-2.21 4.9-4.9 4.9-4.9-2.21-4.9-4.9 2.21-4.9 4.9-4.9z";
        svgIcon.innerHTML = `<g><path d="${searchIconPath}" fill="currentColor"></path></g>`;
        svgIcon.style.color = 'rgb(29, 155, 240)';
    }
    verifyButton.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        closeMenuFromEvent(e);
        if (activeTweetArticle) {
            const userLink = activeTweetArticle.querySelector('div[data-testid="User-Name"] a[role="link"]');
            const userNameText = getDisplayNameFromUserLink(userLink);
            if (userNameText) {
                window.setTimeout(() => { handleVerifiedUserName(userNameText); }, 180);
            } else {
                showToast('nuke-verify-missing-toast', '无法获取用户名', '这条推文里没有抓到可用的用户名文本', 2500);
            }
        }
    });
    nukeButton.before(verifyButton);
}
function addSpamInspectButton(menuNode) {
    if (menuNode.querySelector('.nuke-spam-inspect-button')) return;
    const verifyButton = menuNode.querySelector('.nuke-verify-button');
    if (!verifyButton) return;
    const inspectButton = verifyButton.cloneNode(true);
    inspectButton.classList.remove('nuke-verify-button');
    inspectButton.classList.add('nuke-spam-inspect-button');
    const span = inspectButton.querySelector('span');
    if (span) {
        span.textContent = '🔍 检测引流推文';
        span.style.color = 'rgb(255, 173, 31)';
    }
    const svgIcon = inspectButton.querySelector('svg');
    if (svgIcon) svgIcon.style.color = 'rgb(255, 173, 31)';
    inspectButton.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        closeMenuFromEvent(e);
        if (activeTweetArticle) window.setTimeout(() => inspectTweetArticleForSpam(activeTweetArticle), 120);
    });
    verifyButton.after(inspectButton);
}


function onCbSpamProbeRequest(event) {
    const detail = event?.detail || {};
    if (detail.action === 'openConfig') {
        void showConfigPanel();
        return;
    }
    if (detail.action === 'switchEngine' && detail.engine) {
        const engine = normalizeAvatarOcrEngine(detail.engine);
        const selectEl = document.querySelector('#nuke-spam-avatar-ocr-engine');
        if (selectEl) selectEl.value = engine;
        void preloadAvatarOcrEngineForUi(engine);
        return;
    }
    if (detail.action === 'saveEngine' && detail.engine) {
        scriptConfig.spamAvatarOcrEngine = normalizeAvatarOcrEngine(detail.engine);
        void saveConfig(scriptConfig);
    }
}
function exposePageSpamProbe() {
    try {
        document.addEventListener('cb-spam-probe', onCbSpamProbeRequest);
        document.documentElement.dataset.cbSpamProbeReady = '1';
        getPageWindow().__cbSpamProbe = {
            openConfig: () => showConfigPanel(),
            switchEngine: (engine) => {
                document.dispatchEvent(new CustomEvent('cb-spam-probe', { detail: { action: 'switchEngine', engine } }));
            }
        };
    } catch {
        /* ignore */
    }
}

// --- INITIALIZATION & EXECUTION ---
async function initialize() {
    console.log("[Chain Blocker] Initializing...");
    await loadConfig();
    try {
        delete document.documentElement.dataset.cbSpamOcrLastError;
        delete document.documentElement.dataset.cbSpamOcrUiState;
        delete document.documentElement.dataset.cbSpamOcrUiProgress;
    } catch {
        /* ignore */
    }
    exposePageSpamProbe();
    updateMenuCommands();
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (!profileLink) { setTimeout(initialize, 500); return; }
    try {
        const screenName = profileLink.href.split('/').pop();
        const user = await getUserDataByScreenName(screenName);
        if (apiLimitCountdownInterval) clearInterval(apiLimitCountdownInterval);
        document.getElementById('nuke-api-limit-toast')?.remove();
        currentUserId = user.rest_id;
        currentUserScreenName = user.legacy.screen_name;
        console.log(`[Chain Blocker] Initialized for @${currentUserScreenName}(ID: ${currentUserId}).`);
        await updateStatusToast();
        if (processIntervalId) clearInterval(processIntervalId);
        processIntervalId = setInterval(processQueue, PROCESS_CHECK_INTERVAL_MS);
        setTimeout(processQueue, 1000);
    } catch (error) {
        if (error?.status === 429) {
            console.warn(`[CB] API rate limit hit. Retrying in ${API_RETRY_DELAY_MS / 60000} minutes.`);
            showToast('nuke-api-limit-toast', 'API 已达上限', '正在计算时间...', null);
            const retryTimestamp = Date.now() + API_RETRY_DELAY_MS;
            apiLimitCountdownInterval = setInterval(() => {
                const toastStatusEl = document.querySelector('#nuke-api-limit-toast .nuke-toast-status');
                if (!toastStatusEl) { clearInterval(apiLimitCountdownInterval); return; }
                const secondsLeft = Math.round((retryTimestamp - Date.now()) / 1000);
                if (secondsLeft <= 0) { toastStatusEl.innerHTML = '正在重试...'; clearInterval(apiLimitCountdownInterval); return; }
                toastStatusEl.innerHTML = `将在 <b>${String(Math.floor(secondsLeft/60)).padStart(2,'0')}:${String(secondsLeft%60).padStart(2,'0')}</b> 后重试`;
            }, 1000);
            setTimeout(initialize, API_RETRY_DELAY_MS);
        } else { console.error("[CB] Initialization failed.", error); }
    }
}
const observer = new MutationObserver(mutations => {
    let shouldScanSpam = false;
    for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const menu = node.matches('div[role="menu"]') ? node : node.querySelector('div[role="menu"]');
                    if (menu) {
                        addNukeButton(menu);
                        addVerificationButton(menu);
                        addSpamInspectButton(menu);
                    }
                    if (node.matches?.('article[data-testid="tweet"]') || node.querySelector?.('article[data-testid="tweet"]')) {
                        shouldScanSpam = true;
                    }
                }
            });
        }
    }
    if (shouldScanSpam) {
        scheduleSpamRescanDebounced();
        scheduleAutoBlockRescanDebounced();
    }
});
let autoBlockScanDebounceId = null;
function scheduleAutoBlockRescanDebounced() {
    if (autoBlockScanDebounceId) clearTimeout(autoBlockScanDebounceId);
    autoBlockScanDebounceId = window.setTimeout(() => {
        autoBlockScanDebounceId = null;
        scanAndProcessContent();
    }, 120);
}
document.addEventListener('click', e => {
    const optionsButton = e.target.closest('button[data-testid="caret"]');
    if (optionsButton) activeTweetArticle = optionsButton.closest('article[data-testid="tweet"]');
    const expandControl = e.target.closest('[role="button"], button, a, div[tabindex="0"]');
    if (expandControl && isSpamSectionExpandControl(expandControl)) scheduleSpamRescan();
}, true);
observer.observe(document.body, { childList: true, subtree: true });
setInterval(() => {
    scanAndProcessContent();
    scanSpamIdentifyContent();
}, AUTO_SCAN_INTERVAL_MS);
initialize();
})();
