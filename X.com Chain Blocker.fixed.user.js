// ==UserScript==
// @name         X.com Chain Blocker
// @name:zh-CN   X.com 九族拉黑
// @namespace    http://tampermonkey.net/
// @version      2.15.81
// @description  Block author, retweeters, repliers, and auto-block users based on rules (length, content, keywords, follower count). Manage block log, whitelist, and settings in a panel.
// @description:zh-CN 当拉黑作者时，自动拉黑所有转推者和回复者。支持根据用户名关键词、粉丝数豁免、引流识别等规则自动拉黑，并提供黑/白名单管理面板。
// @author       codex
// @license      MIT
// @match        *://x.com/*
// @match        *://twitter.com/*
// @exclude      *://x.com/settings*
// @exclude      *://twitter.com/settings*
// @noframes
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
// @connect      paddle-model-ecology.bj.bcebos.com
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// ==/UserScript==
(function () {
'use strict';
function isTopLevelWindow() {
    try {
        return window.self === window.top;
    } catch {
        return false;
    }
}
if (!isTopLevelWindow()) return;
// --- CONFIG & CONSTANTS ---
const MENU_ITEM_TEXT = "九族拉黑";
const NUKE_ICON_PATH = "M19.5,12c0,2.9-1.6,5.5-4,6.8V21h-7v-2.2c-2.4-1.3-4-3.9-4-6.8c0-4.1,3.4-7.5,7.5-7.5S19.5,7.9,19.5,12z M12,6c-2.2,0-4,1.8-4,4s1.8,4,4,4s4-1.8,4-4S14.2,6,12,6z M12,14c-1.1,0-2-0.9-2-2c0-0.4,0.1-0.7,0.3-1H10v-2h1.3c-0.2-0.3-0.3-0.6-0.3-1c0-1.1,0.9-2,2-2s2,0.9,2,2c0,0.4-0.1,0.7-0.3,1H14v2h-1.3c0.2,0.3,0.3,0.6,0.3,1C14,13.1,13.1,14,12,14z";
const STORAGE_KEY = 'CHAIN_BLOCKER_DATA';
const CONFIG_STORAGE_KEY = 'CHAIN_BLOCKER_CONFIG';
const API_RATE_LIMIT_STATE_KEY = 'CHAIN_BLOCKER_API_RATE_LIMIT_STATE';
const API_LAST_OPERATION_STARTED_KEY = 'CHAIN_BLOCKER_API_LAST_OPERATION_STARTED';
const API_CROSS_TAB_LOCK_NAME = 'chain-blocker-api-operation';
const BACKGROUND_WORKER_LOCK_PREFIX = 'chain-blocker-background-worker';
const BLOCK_INTERVAL_MS = 60 * 1000;
const API_OPERATION_INTERVAL_MS = 5 * 1000;
const API_REQUEST_TIMEOUT_MS = 12000;
const PROCESS_CHECK_INTERVAL_MS = 5 * 1000;
const BLOCK_RETRY_BASE_MS = 30 * 1000;
const BLOCK_RETRY_MAX_MS = 5 * 60 * 1000;
const BLOCK_RETRY_MAX_ATTEMPTS = 4;
const USERNAME_LENGTH_THRESHOLD = 25;
const DEFAULT_USERNAME_RULE_FOLLOWER_EXEMPT_THRESHOLD = 1000;
const BLOCK_CONTEXT_TEXT_MAX = 120;
const DEFAULT_SPAM_IDENTIFY_MIN_SCORE = 3;
const AVATAR_OCR_CACHE_MS = 30 * 60 * 1000;
const AVATAR_OCR_CACHE_LIMIT = 400;
const AVATAR_OCR_MAX_FAILS = 4;
const AVATAR_OCR_STALE_PENDING_MS = 5 * 60 * 1000;
const AVATAR_IMAGE_FETCH_TIMEOUT_MS = 20000;
const AVATAR_OCR_JOB_TIMEOUT_MS = 45000;
const PADDLE_OCR_VARIANT_TIMEOUT_MS = 6000;
const AVATAR_OCR_PUMP_STALL_GRACE_MS = 10000;
const AVATAR_OCR_VISIBLE_REQUEUE_MS = 8000;
const AVATAR_OCR_VIEWPORT_MARGIN = 500;
const AVATAR_OCR_USER_IDLE_MS = 800;
const PROFILE_BIO_STALE_PENDING_MS = 30000;
const PENDING_HIDDEN_USERS_LIMIT = 2000;
const HIDDEN_RELEASE_QUEUE_LIMIT = 2000;
const NUKE_CAPTURE_LOG_LIMIT = 300;
const MANUAL_DETECTED_NUKE_TASK_LIMIT = 20;
const MANUAL_DETECTED_NUKE_STALE_RUNNING_MS = 2 * 60 * 1000;
const avatarOcrCache = new Map();
const avatarOcrPendingByKey = new Map();
const avatarOcrQueue = [];
const deferredAvatarOcrArticles = new Set();
const deferredAvatarOcrUrls = new WeakMap();
const profileBioCache = new Map();
const profileBioFetchPending = new Map();
const profileBioQueue = [];
const deferredProfileBioArticles = new Set();
const deferredProfileBioScreenNames = new WeakMap();
let avatarOcrPumpRunning = false;
let avatarOcrPumpRunId = 0;
let avatarOcrActiveStartedAt = 0;
let avatarOcrActiveArticle = null;
let avatarOcrVisibilityObserver = null;
let avatarOcrResumeTimeoutId = null;
let avatarOcrLastUserActivityAt = 0;
let profileBioPumpRunning = false;
let profileBioActiveArticle = null;
let profileBioVisibilityObserver = null;
let avatarOcrTesseractFailed = false;
let avatarOcrPaddleFailed = false;
let avatarOcrWorkerPromise = null;
let paddleUserscriptInitPromise = null;
let paddleUserscriptHandle = null;
let avatarOcrInitSerial = Promise.resolve();
const SPAM_SCANNER_BUILD = '2.15.81';
const AUTO_BLOCK_NUKE_MODE_VERSION = 1;
const TESSERACT_CHI_SIM_LANG_GZ = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz';
const TESSERACT_LANG_CACHE_KEY = './chi_sim.traineddata';
let tesseractLangCachePromise = null;
const AVATAR_OCR_RING_C = 2 * Math.PI * 8;
let avatarOcrTesseractReady = false;
let avatarOcrPaddleReady = false;
let avatarOcrEngineUiToken = 0;
const AVATAR_OCR_ENGINE_TESSERACT = 'tesseract';
const AVATAR_OCR_ENGINE_PADDLE = 'paddle';
const AVATAR_OCR_ENGINE_OFF = 'off';
const DEFAULT_AVATAR_OCR_ENGINE = AVATAR_OCR_ENGINE_TESSERACT;
const BUILT_IN_AVATAR_OCR_KEYWORDS = ['全国安排'];
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist';
const TESSERACT_CORE_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
const PADDLE_OCR_JS_URL = 'https://cdn.jsdelivr.net/npm/paddleocr@1.0.6/dist/index.js';
const PADDLE_DET_TAR_URL = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx.tar';
const PADDLE_REC_TAR_URL = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx.tar';
const ORT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.wasm.min.js';
const ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
const OPENCV_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js';
let userscriptCvLoadPromise = null;
let ortWasmBlobPaths = null;
function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
}
function normalizeAvatarOcrEngine(value) {
    const engine = String(value || '').trim().toLowerCase();
    if (engine === AVATAR_OCR_ENGINE_OFF) return AVATAR_OCR_ENGINE_OFF;
    if (engine === AVATAR_OCR_ENGINE_PADDLE) return AVATAR_OCR_ENGINE_PADDLE;
    return AVATAR_OCR_ENGINE_TESSERACT;
}
function getAvatarOcrEngine() {
    return normalizeAvatarOcrEngine(scriptConfig.spamAvatarOcrEngine);
}
function isAvatarOcrEnabled() {
    return scriptConfig.spamAvatarOcrEnabled !== false && getAvatarOcrEngine() !== AVATAR_OCR_ENGINE_OFF;
}
function isAvatarOcrEngineFailed() {
    const engine = getAvatarOcrEngine();
    if (engine === AVATAR_OCR_ENGINE_OFF) return false;
    return engine === AVATAR_OCR_ENGINE_PADDLE ? avatarOcrPaddleFailed : avatarOcrTesseractFailed;
}
function withAvatarOcrJobTimeout(promise) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            const error = new Error('avatar OCR job timeout');
            error.name = 'AvatarOcrJobTimeoutError';
            reject(error);
        }, AVATAR_OCR_JOB_TIMEOUT_MS);
        Promise.resolve(promise)
            .then((value) => {
                window.clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                window.clearTimeout(timer);
                reject(error);
            });
    });
}
function withAvatarOcrStepTimeout(promise, timeoutMs, message = 'avatar OCR step timeout') {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            const error = new Error(message);
            error.name = message === 'paddle OCR variant timeout' ? 'PaddleOcrVariantTimeoutError' : 'AvatarOcrStepTimeoutError';
            reject(error);
        }, timeoutMs);
        Promise.resolve(promise)
            .then((value) => {
                window.clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                window.clearTimeout(timer);
                reject(error);
            });
    });
}
function isAvatarOcrJobTimeout(error) {
    return error?.name === 'AvatarOcrJobTimeoutError';
}
function isPaddleOcrVariantTimeout(error) {
    return error?.name === 'PaddleOcrVariantTimeoutError';
}
function shouldDeferBackgroundAvatarOcr() {
    if (!isAvatarOcrEnabled() || scriptConfig.spamIdentifyEnabled === false) return false;
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
    const workerPromise = avatarOcrWorkerPromise;
    avatarOcrWorkerPromise = null;
    if (workerPromise) {
        void Promise.resolve(workerPromise)
            .then((worker) => worker?.terminate?.())
            .catch(() => { /* ignore */ });
    }
    resetTesseractCoreBlobs();
}
function resetPaddleUserscriptState() {
    paddleUserscriptInitPromise = null;
    paddleUserscriptHandle = null;
    userscriptCvLoadPromise = null;
    const pageWin = getPageWindow();
    delete pageWin.__cbPaddleBrowser;
    delete pageWin.__cbPaddleOcrMod;
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
    avatarOcrPumpRunId += 1;
    avatarOcrPumpRunning = false;
    avatarOcrActiveStartedAt = 0;
    avatarOcrActiveArticle = null;
    avatarOcrQueue.splice(0, avatarOcrQueue.length);
    avatarOcrPendingByKey.clear();
    if (avatarOcrResumeTimeoutId) window.clearTimeout(avatarOcrResumeTimeoutId);
    avatarOcrResumeTimeoutId = null;
    clearDeferredAvatarOcrArticles();
    avatarOcrTesseractFailed = false;
    avatarOcrPaddleFailed = false;
    avatarOcrTesseractReady = false;
    avatarOcrPaddleReady = false;
    avatarOcrEngineUiToken += 1;
    resetAvatarOcrWorker();
    resetPaddleUserscriptState();
}
function resetAvatarOcrArticleMarkers() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        clearDeferredAvatarOcrArticle(article);
        removeAvatarOcrJobsForArticle(article);
        delete article.dataset.spamScanned;
        delete article.dataset.avatarOcrQueued;
        delete article.dataset.avatarOcrPending;
        delete article.dataset.avatarOcrQueuedAt;
        delete article.dataset.avatarOcrFailCount;
        delete article.dataset.avatarOcrDeferred;
    });
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
        let pendingPromiseObserved = false;
        const finish = (cv) => {
            if (cv?.Mat) resolve(cv);
            else if (!pendingPromiseObserved && typeof pageWin.cv?.then === 'function') {
                pendingPromiseObserved = true;
                pageWin.cv.then((resolvedCv) => {
                    if (resolvedCv?.Mat) resolve(resolvedCv);
                    else finish(pageWin.cv);
                }).catch(reject);
            }
            else if (Date.now() - started > timeoutMs) reject(new Error('timeout waiting for cv'));
            else window.setTimeout(() => finish(pageWin.cv), 250);
        };
        if (pageWin.cv?.Mat) {
            resolve(pageWin.cv);
            return;
        }
        if (typeof pageWin.cv?.then === 'function') {
            pendingPromiseObserved = true;
            pageWin.cv.then((resolvedCv) => {
                if (resolvedCv?.Mat) resolve(resolvedCv);
                else finish(pageWin.cv);
            }).catch(reject);
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
    if (pageWin.__cbPaddleOcrMod) return pageWin.__cbPaddleOcrMod;
    if (!pageWin.__cbPaddleModInjected) {
        await new Promise(async (resolve, reject) => {
            const timer = window.setTimeout(() => {
                pageWin.removeEventListener('cb-paddle-mod-ready', onReady);
                reject(new Error('paddle module load timeout'));
            }, 120000);
            const onReady = () => {
                window.clearTimeout(timer);
                resolve();
            };
            pageWin.addEventListener('cb-paddle-mod-ready', onReady, { once: true });
            try {
                const paddleScriptText = await gmFetchText(PADDLE_OCR_JS_URL, 120000);
                addPageScriptElement({ textContent: paddleScriptText });
                const poll = () => {
                    if (pageWin.paddleocr?.PaddleOcrService) {
                        pageWin.__cbPaddleOcrMod = pageWin.paddleocr;
                        pageWin.dispatchEvent(new CustomEvent('cb-paddle-mod-ready'));
                    } else {
                        window.setTimeout(poll, 50);
                    }
                };
                poll();
                pageWin.__cbPaddleModInjected = true;
            } catch (error) {
                window.clearTimeout(timer);
                pageWin.removeEventListener('cb-paddle-mod-ready', onReady);
                reject(error);
            }
        });
    }
    if (!pageWin.__cbPaddleOcrMod?.PaddleOcrService) throw new Error('paddleocr 未加载');
    return pageWin.__cbPaddleOcrMod;
}
function addPageScriptElement(attributes) {
    if (typeof GM_addElement === 'function') {
        return GM_addElement(document.head || document.documentElement, 'script', attributes);
    }
    const script = document.createElement('script');
    Object.entries(attributes || {}).forEach(([key, value]) => {
        if (key === 'textContent') script.textContent = value;
        else script.setAttribute(key, value);
    });
    (document.head || document.documentElement).appendChild(script);
    return script;
}
function readTarString(bytes, start, length) {
    let output = '';
    for (let index = start; index < start + length; index += 1) {
        const value = bytes[index];
        if (value === 0) break;
        output += String.fromCharCode(value);
    }
    return output.replace(/\0.*$/, '').trim();
}
function readTarOctal(bytes, start, length) {
    const raw = readTarString(bytes, start, length).replace(/\0/g, '').trim();
    return raw ? parseInt(raw, 8) : 0;
}
function extractTarEntryBytes(buffer, targetName) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let offset = 0;
    while (offset + 512 <= bytes.length) {
        let empty = true;
        for (let i = offset; i < offset + 512; i += 1) {
            if (bytes[i] !== 0) {
                empty = false;
                break;
            }
        }
        if (empty) break;
        const name = readTarString(bytes, offset, 100).replace(/^\.?\//, '');
        const size = readTarOctal(bytes, offset + 124, 12);
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        if (name === targetName || name.endsWith(`/${targetName}`)) return bytes.slice(dataStart, dataEnd);
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    throw new Error(`tar entry not found: ${targetName}`);
}
function bytesToArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function parsePaddleCharacterDictionary(ymlText) {
    const chars = [''];
    let inDict = false;
    String(ymlText || '').split(/\r\n|\r|\n/).forEach((line) => {
        if (/^\s*character_dict:\s*$/.test(line)) {
            inDict = true;
            return;
        }
        if (!inDict) return;
        const match = line.match(/^\s*-\s?(.*)$/);
        if (match) chars.push(match[1]);
        else if (/^\S/.test(line)) inDict = false;
    });
    return chars;
}
function detectAvatarImageMimeType(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array
        ? arrayBuffer
        : new Uint8Array(arrayBuffer || new ArrayBuffer(0));
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
}
async function decodeImageBitmapFromBlob(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(blob);
        } catch {
            /* fall back to Image decoding below */
        }
    }
    if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') {
        throw new Error('avatar image decode unavailable');
    }
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        const cleanup = () => {
            try {
                URL.revokeObjectURL(url);
            } catch {
                /* ignore */
            }
        };
        img.onload = () => {
            cleanup();
            resolve(img);
        };
        img.onerror = () => {
            cleanup();
            reject(new Error('avatar image decode failed'));
        };
        img.src = url;
    });
}
function loadAvatarImageElementForOcr(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let settled = false;
        const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('avatar image direct decode timeout'));
        }, 30000);
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve(img);
        };
        img.onerror = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            reject(new Error('avatar image direct decode failed'));
        };
        img.src = url;
    });
}
async function blobToImageData(blob) {
    const bitmap = await decodeImageBitmapFromBlob(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === 'function') bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
async function loadOrtModule() {
    const pageWin = getPageWindow();
    if (pageWin.ort?.InferenceSession) return;
    if (!pageWin.__cbOrtScriptInjected) {
        await new Promise(async (resolve, reject) => {
            const timer = window.setTimeout(() => {
                pageWin.removeEventListener('cb-ort-ready', onReady);
                reject(new Error('onnxruntime-web load timeout'));
            }, 120000);
            const onReady = () => {
                window.clearTimeout(timer);
                resolve();
            };
            pageWin.addEventListener('cb-ort-ready', onReady, { once: true });
            try {
                const ortScriptText = await gmFetchText(ORT_SCRIPT_URL, 120000);
                addPageScriptElement({ textContent: ortScriptText });
                const poll = () => {
                    if (pageWin.ort?.InferenceSession) {
                        pageWin.dispatchEvent(new CustomEvent('cb-ort-ready'));
                    } else {
                        window.setTimeout(poll, 50);
                    }
                };
                poll();
                pageWin.__cbOrtScriptInjected = true;
            } catch (error) {
                window.clearTimeout(timer);
                pageWin.removeEventListener('cb-ort-ready', onReady);
                reject(error);
            }
        });
    }
}
async function ensureOrtWasmBlobPaths() {
    if (ortWasmBlobPaths) return ortWasmBlobPaths;
    const files = [
        'ort-wasm-simd.wasm',
        'ort-wasm.wasm',
        'ort-wasm-simd-threaded.wasm'
    ];
    const entries = await Promise.all(files.map(async (file) => {
        const buffer = await gmFetchArrayBuffer(`${ORT_WASM_BASE}${file}`, 120000);
        const blobUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/wasm' }));
        return [file, blobUrl];
    }));
    ortWasmBlobPaths = Object.fromEntries(entries);
    return ortWasmBlobPaths;
}
async function ensureSandboxCv() {
    const pageWin = getPageWindow();
    if (pageWin.cv?.Mat) return pageWin.cv;
    if (!userscriptCvLoadPromise) {
        userscriptCvLoadPromise = (async () => {
            if (!pageWin.__cbOpencvInjected) {
                await new Promise((resolve, reject) => {
                    const timer = window.setTimeout(() => reject(new Error('opencv script load timeout')), 120000);
                    const script = addPageScriptElement({ src: OPENCV_SCRIPT_URL });
                    script.addEventListener('load', () => {
                        window.clearTimeout(timer);
                        pageWin.__cbOpencvInjected = true;
                        resolve();
                    }, { once: true });
                    script.addEventListener('error', () => {
                        window.clearTimeout(timer);
                        reject(new Error('opencv script load failed'));
                    }, { once: true });
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
async function ensureUserscriptOrt() {
    await loadOrtModule();
    const pageWin = getPageWindow();
    const ortRef = pageWin.ort;
    if (!ortRef?.InferenceSession) {
        throw new Error('onnxruntime-web 未加载（请在暴力猴中更新并启用本脚本）');
    }
    try {
        if (ortRef.env?.wasm) {
            ortRef.env.wasm.wasmPaths = await ensureOrtWasmBlobPaths();
            ortRef.env.wasm.numThreads = 1;
            ortRef.env.wasm.proxy = false;
        }
    } catch {
        /* ignore */
    }
    try {
        getPageWindow().ort = ortRef;
    } catch {
        /* ignore */
    }
    return ortRef;
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
    if (engine === AVATAR_OCR_ENGINE_OFF) {
        setAvatarOcrEngineUiStatus('idle');
        return;
    }
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
    if (normalized === AVATAR_OCR_ENGINE_OFF) {
        setAvatarOcrEngineUiStatus('idle');
        return true;
    }
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
    clearDeferredProfileBioArticles();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        delete article.dataset.spamScanned;
        delete article.dataset.avatarOcrQueued;
        delete article.dataset.avatarOcrPending;
        delete article.dataset.avatarOcrQueuedAt;
        delete article.dataset.avatarOcrFailCount;
        delete article.dataset.profileBioPending;
        delete article.dataset.profileBioQueued;
        delete article.dataset.profileBioQueuedAt;
        delete article.dataset.profileBioFailCount;
        delete article.dataset.profileBioScannedBuild;
        delete article.dataset.spamTextScannedBuild;
        article.classList.remove('nuke-spam-identified');
        article.querySelector('.nuke-spam-badge')?.remove();
    });
}
function getStatusTweetIdFromHref(href) {
    const source = String(href || '');
    if (!source) return '';
    try {
        const pathname = new URL(source, window.location.origin).pathname;
        return pathname.match(/\/status\/(\d+)/i)?.[1] || '';
    } catch {
        return source.match(/\/status\/(\d+)/i)?.[1] || '';
    }
}
function isStatusTweetPage() {
    return /\/status\/\d+/i.test(window.location.pathname);
}
function shouldRunArticleDetectionScans() {
    return isStatusTweetPage();
}
function getCurrentStatusPageInfo() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const statusIndex = parts.findIndex((part) => part.toLowerCase() === 'status');
    const tweetId = statusIndex >= 0 ? (parts[statusIndex + 1]?.match(/^\d+/)?.[0] || '') : '';
    const rawHandle = statusIndex > 0 ? decodeURIComponent(parts[statusIndex - 1] || '') : '';
    const handle = normalizePromoHandle(rawHandle);
    const authorHandle = handle && !['i', 'web'].includes(handle) ? handle : '';
    return { tweetId, authorHandle };
}
function getArticleOwnStatusId(article) {
    const timeLink = article?.querySelector?.('a[href*="/status/"] time')?.closest('a');
    const timeStatusId = getStatusTweetIdFromHref(timeLink?.href);
    if (timeStatusId) return timeStatusId;
    const ids = [...new Set(Array.from(article?.querySelectorAll?.('a[href*="/status/"]') || [])
        .map((link) => getStatusTweetIdFromHref(link.href))
        .filter(Boolean))];
    return ids.length === 1 ? ids[0] : '';
}
function markStatusRootTweetArticles() {
    const info = getCurrentStatusPageInfo();
    const articles = document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"]');
    articles.forEach((article) => {
        delete article.dataset.cbSpamRootTweet;
    });
    if (!info.tweetId) {
        statusRootTweetCache = { pageTweetId: '', rootTweetId: '', authorHandle: '' };
        return;
    }
    const entries = Array.from(articles).map((article) => ({ article, tweetId: getArticleOwnStatusId(article) }));
    const currentIndex = entries.findIndex((entry) => entry.tweetId === info.tweetId);
    const cachedRootTweetId = statusRootTweetCache.pageTweetId === info.tweetId ? statusRootTweetCache.rootTweetId : '';
    let rootEntry = currentIndex > 0
        ? entries.slice(0, currentIndex).find((entry) => entry.tweetId)
        : entries[currentIndex];
    if (!rootEntry && cachedRootTweetId) rootEntry = entries.find((entry) => entry.tweetId === cachedRootTweetId) || null;
    if (!rootEntry) {
        const cachedAuthorHandle = statusRootTweetCache.pageTweetId === info.tweetId ? statusRootTweetCache.authorHandle : '';
        statusRootTweetCache = { pageTweetId: info.tweetId, rootTweetId: cachedRootTweetId, authorHandle: cachedAuthorHandle };
        return;
    }
    rootEntry.article.dataset.cbSpamRootTweet = 'true';
    const previousAuthorHandle = statusRootTweetCache.pageTweetId === info.tweetId ? statusRootTweetCache.authorHandle : '';
    const authorHandle = getArticleAuthorHandle(rootEntry.article) || (rootEntry.tweetId === info.tweetId ? info.authorHandle : '') || previousAuthorHandle;
    statusRootTweetCache = { pageTweetId: info.tweetId, rootTweetId: rootEntry.tweetId || cachedRootTweetId, authorHandle };
}
function isStatusRootTweetArticle(article) {
    return article?.dataset?.cbSpamRootTweet === 'true';
}
function shouldSkipAvatarOcrForArticle(article) {
    return isStatusRootTweetArticle(article);
}
function isRootTweetAllowedSpamDetection(detection) {
    return !!(detection?.match && detection.signals?.some((s) => s.id === 'emoji_only_bait'));
}
function shouldSkipSpamIdentifyForArticle(article, detection = null) {
    if (!isStatusRootTweetArticle(article)) return false;
    return !isRootTweetAllowedSpamDetection(detection);
}
const FOLLOWER_COUNT_CACHE_MS = 10 * 60 * 1000;
const DETECTION_SAFETY_INTERVAL_MS = 15000;
const DETECTION_SCAN_DELAY_MS = 160;
const API_RETRY_DELAY_MS = 5 * 60 * 1000;
let currentUserId = null, currentUserScreenName = null, activeTweetArticle = null;
let isProcessingQueue = false, processIntervalId = null, queueStatusCountdownInterval = null, apiLimitCountdownInterval = null, apiLimitRetryTimeoutId = null, apiLimitRetryAt = 0;
let apiOperationTail = Promise.resolve(), apiLastOperationStartedAt = 0;
let manualDetectedNukeRunning = false, manualDetectedNukeTaskRunning = false, manualDetectedNukeResumeTimeoutId = null;
let backgroundWorkerLeader = false, backgroundWorkerLeadershipPending = false, backgroundWorkerRelease = null, backgroundWorkerRetryTimeoutId = null, backgroundWorkerTickRunning = false;
let scriptConfig = {}, isConfigPanelBusy = false, internalConfigTriggerInstalled = false, unifiedToastPanelPlacementBound = false, unifiedToastPanelCollapsed = false;
let menuCommandRegistered = false, userscriptBootstrapPromise = null, initializeRunning = false, initializeRetryTimeoutId = null;
let statusRootTweetCache = { pageTweetId: '', rootTweetId: '', authorHandle: '' };
const pendingDetectionArticles = new Set();
let detectionScanTimeoutId = null, detectionScanIdleId = null, detectionScanRunning = false, detectionFullScanPending = false;
let detectionScanRerunRequested = false, detectionScanRunCount = 0, detectionScanArticleCount = 0, detectionScanPath = '';
const aggregatedToastState = new Map();
const followerCountCache = new Map();

// --- STYLES ---
GM_addStyle(`.nuke-toast{position:fixed;top:20px;right:20px;z-index:100000;background-color:#15202b;color:white;padding:10px 15px;border-radius:12px;border:1px solid #38444d;box-shadow:0 4px 12px rgba(0,0,0,0.4);width:auto;max-width:350px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;transition:all .5s ease-out;opacity:1;transform:translateX(0)}.nuke-toast.fading-out{opacity:0;transform:translateX(20px)}.nuke-toast-title{font-weight:bold;margin-bottom:8px;font-size:16px}.nuke-toast-status{font-size:14px;margin-bottom:0;line-height:1.5}#nuke-status-toast{background-color:#253341}#nuke-api-limit-toast{background-color:#d9a100;color:#15202b;border-color:#ffc107}.nuke-config-panel,.nuke-verify-modal{position:fixed;z-index:100001;background-color:#15202b;color:white;border-radius:16px;border:1px solid #38444d;box-shadow:0 8px 24px rgba(0,0,0,0.5);width:550px;max-width:90vw;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:0;margin:0}.nuke-verify-modal{top:50%;left:50%;transform:translate(-50%,-50%)}.nuke-config-panel{max-height:calc(100vh - 16px);overflow-y:auto;transform:none;top:0;left:0}.nuke-config-panel.nuke-dialog-dragging{user-select:none;will-change:left,top}.nuke-panel-header.nuke-dialog-drag-handle{cursor:grab;touch-action:none}.nuke-panel-header.nuke-dialog-drag-handle:active{cursor:grabbing}.nuke-config-panel::backdrop,.nuke-verify-modal::backdrop{background:rgba(91,112,131,0.45)}.nuke-panel-header{display:flex;align-items:center;justify-content:space-between;height:53px;padding:0 16px;border-bottom:1px solid #38444d}.nuke-header-item{flex-basis:56px;display:flex;align-items:center}.nuke-header-item.left{justify-content:flex-start}.nuke-header-item.right{justify-content:flex-end}.nuke-config-title{font-weight:bold;font-size:20px;flex-grow:1;text-align:center}.nuke-close-button{background:0 0;border:0;padding:0;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:9999px;transition:background-color .2s ease-in-out}.nuke-close-button:hover{background-color:rgba(239,243,244,0.1)}.nuke-close-button svg{fill:white;width:20px;height:20px}.nuke-panel-content{padding:16px}.nuke-config-textarea,.nuke-verify-textarea,.nuke-list-search,.nuke-setting-item input[type=number]{user-select:text;-webkit-user-select:text;pointer-events:auto}.nuke-config-textarea,.nuke-verify-textarea{width:100%;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:10px;font-size:14px;resize:vertical;box-sizing:border-box;margin-bottom:15px}.nuke-url-textarea{height:80px}.nuke-keywords-textarea{height:60px}.nuke-verify-textarea{height:110px;line-height:1.5}.nuke-config-button-container{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.nuke-config-button.save,.nuke-config-button.copy{background-color:#eff3f4;color:#0f1419;padding:8px 16px;border-radius:20px;border:none;font-weight:bold;cursor:pointer;transition:background-color .2s}.nuke-config-button.save:hover,.nuke-config-button.copy:hover{background-color:#d7dbdc}.nuke-config-tabs{display:flex;border-bottom:1px solid #38444d;margin-bottom:15px}.nuke-config-tab{background:0 0;border:none;color:#8899a6;padding:10px 15px;cursor:pointer;font-size:15px;font-weight:700;flex-grow:1;transition:background-color .2s}.nuke-config-tab:hover{background-color:rgba(239,243,244,0.1)}.nuke-config-tab.active{color:#1d9bf0;border-bottom:2px solid #1d9bf0;margin-bottom:-1px}.nuke-config-tab-content{animation:fadeIn .3s ease-in-out;padding-top:10px}.nuke-config-tab-content.hidden{display:none}@keyframes fadeIn{from{opacity:0}to{opacity:1}}.nuke-list{max-height:280px;overflow-y:auto;padding-right:10px}.nuke-list-search{width:100%;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:8px 12px;font-size:14px;box-sizing:border-box;margin-bottom:10px}.nuke-list-entry{display:flex;justify-content:space-between;align-items:center;padding:8px 5px;border-bottom:1px solid #253341}.nuke-list-user-info{display:flex;flex-direction:column;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:10px}.nuke-list-user-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nuke-list-user-handle{color:#8899a6;font-size:14px;cursor:pointer}.nuke-list-user-handle:hover{text-decoration:underline}.nuke-list-block-reason{display:block;font-size:12px;color:#8899a6;margin-top:4px;line-height:1.4;word-break:break-word;white-space:normal}.nuke-list-actions{font-size:12px;color:#8899a6;white-space:nowrap;cursor:pointer;flex-shrink:0;margin-left:8px}.nuke-list-actions:hover{color:#1d9bf0}.nuke-list-user-info a{color:inherit;text-decoration:none}.nuke-list-user-info a:hover .nuke-list-user-name{text-decoration:underline}.nuke-setting-item{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px}.nuke-setting-item label{font-size:14px;margin-right:10px}.nuke-setting-item input[type=number]{width:80px;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:5px 8px;font-size:14px}.nuke-setting-item select{max-width:240px;background-color:#253341;border:1px solid #38444d;border-radius:8px;color:white;padding:5px 8px;font-size:14px}.nuke-ocr-engine-item{align-items:center}.nuke-ocr-engine-controls{display:flex;align-items:center;gap:8px;flex-shrink:0}.nuke-ocr-engine-status{width:20px;height:20px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}.nuke-ocr-engine-status--idle{visibility:hidden;pointer-events:none}.nuke-ocr-engine-status svg{width:20px;height:20px;display:block}.nuke-ocr-engine-status--loading .nuke-ocr-engine-ring-track{stroke:#38444d}.nuke-ocr-engine-status--loading .nuke-ocr-engine-ring-progress{stroke:#1d9bf0;transition:stroke-dashoffset .25s ease}.nuke-ocr-engine-status--done .nuke-ocr-engine-done-fill{fill:#00ba7c}.nuke-ocr-engine-status--done .nuke-ocr-engine-done-check{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.nuke-ocr-engine-status--error .nuke-ocr-engine-error-fill{fill:#f4212e}.nuke-ocr-engine-status--error .nuke-ocr-engine-error-mark{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round}.nuke-ocr-engine-status--error{cursor:help}.nuke-setting-item input[type=checkbox]{height:20px;width:20px;accent-color:#1d9bf0}.nuke-settings-label{display:block;font-size:14px;color:#8899a6;margin-top:10px;margin-bottom:10px}.nuke-verify-note{font-size:14px;color:#8899a6;line-height:1.5;margin-bottom:10px}article[data-testid="tweet"].nuke-spam-identified{box-shadow:inset 0 0 0 1px rgba(255,173,31,.55);border-radius:12px}.nuke-spam-badge{display:inline-flex;align-items:center;margin:4px 12px 0;padding:2px 8px;font-size:12px;font-weight:700;color:#ffad1f;background:rgba(255,173,31,.12);border:1px solid rgba(255,173,31,.35);border-radius:9999px;cursor:help}`);
GM_addStyle(`.nuke-ocr-engine-status--ready .nuke-ocr-engine-done-fill{fill:#00ba7c}.nuke-ocr-engine-status--ready .nuke-ocr-engine-done-check{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`);
GM_addStyle(`.nuke-settings-module{border-top:1px solid #253341;padding-top:14px;margin-top:14px}.nuke-settings-module:first-child{border-top:0;padding-top:0;margin-top:0}.nuke-settings-module-title{font-size:13px;font-weight:700;color:#eff3f4;margin:0 0 10px}`);
GM_addStyle(`.nuke-aggregated-toast-summary{font-weight:700;margin-bottom:4px}.nuke-aggregated-toast-line{color:#d7dbdc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}`);
GM_addStyle(`#nuke-toast-panel{position:fixed;right:var(--nuke-toast-panel-right,20px);bottom:var(--nuke-toast-panel-bottom,20px);z-index:10;width:var(--nuke-toast-panel-width,min(360px,calc(100vw - 40px)));max-height:min(420px,calc(100vh - var(--nuke-toast-panel-bottom,20px) - 12px));box-sizing:border-box;background:rgb(22,24,28);color:#e7e9ea;border:1px solid rgb(47,51,54);border-radius:16px;box-shadow:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow:hidden}#nuke-toast-panel.nuke-toast-panel-empty{display:none}.nuke-toast-panel-list{display:flex;flex-direction:column;gap:0;max-height:inherit;overflow-y:auto}#nuke-toast-panel .nuke-toast{position:relative;top:auto!important;right:auto;z-index:auto;background:transparent;color:inherit;padding:10px 15px;border:0;border-radius:0;box-shadow:none;width:auto;max-width:none;transform:none;border-bottom:1px solid rgb(47,51,54)}#nuke-toast-panel .nuke-toast:last-child{border-bottom:0}#nuke-toast-panel .nuke-toast.fading-out{opacity:0;transform:translateX(12px)}#nuke-toast-panel #nuke-api-limit-toast{background:rgba(217,161,0,.18);color:#fff;border-color:rgb(47,51,54)}`);
GM_addStyle(`#nuke-manual-detected-nuke-button,#nuke-toast-panel-toggle-button{position:fixed;right:20px;bottom:146px;z-index:10;width:55px;height:55px;border-radius:16px;border:1px solid rgb(75,78,82);background:rgba(0,0,0,.65);color:#fff;display:flex;align-items:center;justify-content:center;padding:0;box-sizing:border-box;box-shadow:rgba(255,255,255,.2) 0 0 15px 0,rgba(255,255,255,.15) 0 0 3px 1px;cursor:pointer;transition:background-color .2s,border-color .2s,opacity .2s}#nuke-manual-detected-nuke-button{bottom:213px}#nuke-toast-panel-toggle-button.nuke-toast-panel-toggle-with-manual{bottom:146px}#nuke-manual-detected-nuke-button:hover:not(:disabled),#nuke-toast-panel-toggle-button:hover{background:rgba(29,155,240,.82);border-color:rgb(29,155,240);color:#fff}#nuke-manual-detected-nuke-button:disabled{opacity:.45;cursor:default}#nuke-manual-detected-nuke-button svg,#nuke-toast-panel-toggle-button svg{width:32px;height:32px;display:block}#nuke-toast-panel.nuke-toast-panel-collapsed{display:none!important}body:has([role="dialog"][aria-modal="true"]) #nuke-manual-detected-nuke-button,body:has([role="dialog"][aria-modal="true"]) #nuke-toast-panel-toggle-button,body:has([role="dialog"][aria-modal="true"]) #nuke-toast-panel{visibility:hidden!important;pointer-events:none!important}.nuke-manual-detected-count{position:absolute;right:-5px;top:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:9999px;background:#f4212e;color:#fff;border:2px solid #000;font:700 11px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:center}`);

// --- CONFIGURATION MANAGEMENT ---
async function loadConfig() {
    const defaultConfig = {
        autoBlockEnabled: false,
        autoBlockNukeModeVersion: AUTO_BLOCK_NUKE_MODE_VERSION,
        blockLogLimit: 500,
        usernameRuleFollowerExemptThreshold: DEFAULT_USERNAME_RULE_FOLLOWER_EXEMPT_THRESHOLD,
        blueVerifiedExemptEnabled: true,
        blockKeywordsStandard: [], // For any name
        spamIdentifyEnabled: true,
        spamIdentifyMinScore: DEFAULT_SPAM_IDENTIFY_MIN_SCORE,
        spamAvatarOcrEngine: DEFAULT_AVATAR_OCR_ENGINE,
        spamAvatarKeywords: ['全国安排', '点击主页'],
        spamAutoExpandHidden: true
    };
    const savedConfig = await GM_getValue(CONFIG_STORAGE_KEY, {});
    const migrated = { ...savedConfig };
    if (migrated.promoTargetAutoNukeEnabled === true && migrated.autoBlockEnabled === false) {
        migrated.autoBlockEnabled = true;
    }
    if (migrated.autoBlockNukeModeVersion !== AUTO_BLOCK_NUKE_MODE_VERSION) {
        migrated.autoBlockEnabled = false;
        migrated.autoBlockNukeModeVersion = AUTO_BLOCK_NUKE_MODE_VERSION;
    }
    if (migrated.usernameRuleFollowerExemptThreshold == null && migrated.longNameFollowerExemptThreshold != null) {
        migrated.usernameRuleFollowerExemptThreshold = migrated.longNameFollowerExemptThreshold;
    }
    if (migrated.spamAvatarOcrEnabled === false) {
        migrated.spamAvatarOcrEngine = AVATAR_OCR_ENGINE_OFF;
    }
    delete migrated.effectiveUrls;
    delete migrated.autoBlockUrls;
    delete migrated.spamIdentifyUrls;
    delete migrated.longNameFollowerExemptThreshold;
    delete migrated.spamAvatarOcrEnabled;
    delete migrated.promoTargetAutoNukeEnabled;
    delete migrated.promoTargetLearnOnNuke;
    delete migrated.promoTargetAutoNukeUrls;
    scriptConfig = { ...defaultConfig, ...migrated };
    return scriptConfig;
}
async function saveConfig(config) { await GM_setValue(CONFIG_STORAGE_KEY, config); scriptConfig = config; }
function updateMenuCommands() {
    if (menuCommandRegistered) return;
    GM_registerMenuCommand('配置与记录', showConfigPanel);
    menuCommandRegistered = true;
}
function ensureUserscriptBootstrap() {
    if (userscriptBootstrapPromise) return userscriptBootstrapPromise;
    userscriptBootstrapPromise = (async () => {
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
    })().catch((error) => {
        userscriptBootstrapPromise = null;
        throw error;
    });
    return userscriptBootstrapPromise;
}
function scheduleInitializeRetry(delay = 500) {
    if (initializeRetryTimeoutId) return;
    initializeRetryTimeoutId = window.setTimeout(() => {
        initializeRetryTimeoutId = null;
        void initialize();
    }, Math.max(0, delay));
}
function shouldShowDebugConfigTrigger() {
    const href = String(window.location.href || '');
    const hash = String(window.location.hash || '');
    return /(?:[?&#])cb_spam_debug=1(?:[&#]|$)/.test(href) || /(?:^|[#&])cb-spam-debug(?:=1)?(?:[&#]|$)/.test(hash);
}
function onInternalConfigShortcut(event) {
    if (!shouldShowDebugConfigTrigger()) return;
    if (event.code !== 'F8') return;
    if (!event.altKey || !event.shiftKey) return;
    if (event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    void showConfigPanel();
}
function installInternalConfigTrigger() {
    if (internalConfigTriggerInstalled) return;
    internalConfigTriggerInstalled = true;
    document.addEventListener('cb-spam-probe', onCbSpamProbeRequest);
    window.addEventListener('keydown', onInternalConfigShortcut, true);
}
function handleUserscriptBuildRerun() {
    try {
        const pageWin = getPageWindow();
        const previousBuild = pageWin.__cbSpamScannerBuild;
        document.documentElement.dataset.cbSpamScannerBuild = SPAM_SCANNER_BUILD;
        if (previousBuild && previousBuild !== SPAM_SCANNER_BUILD && pageWin.__cbSpamReloadingForBuild !== SPAM_SCANNER_BUILD) {
            pageWin.__cbSpamReloadingForBuild = SPAM_SCANNER_BUILD;
            window.setTimeout(() => {
                window.location.reload();
            }, 50);
            return false;
        }
        pageWin.__cbSpamScannerBuild = SPAM_SCANNER_BUILD;
    } catch {
        /* ignore */
    }
    return true;
}
function closeDialogSurface(surface) {
    if (!surface) return;
    if (typeof surface._nukeDialogCleanup === 'function') {
        const cleanup = surface._nukeDialogCleanup;
        delete surface._nukeDialogCleanup;
        cleanup();
    }
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
    panel._nukeDialogCleanup = () => {
        cleanupDragListeners();
        resizeObserver?.disconnect();
        window.removeEventListener('resize', onResize);
    };
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
                    <section class="nuke-settings-module">
                        <h3 class="nuke-settings-module-title">执行模式</h3>
                        <div class="nuke-setting-item">
                            <label for="nuke-auto-block-toggle">自动九族拉黑（关闭时仅标记）</label>
                            <input type="checkbox" id="nuke-auto-block-toggle">
                        </div>
                        <div class="nuke-setting-item">
                            <label for="nuke-log-limit-input">拉黑记录最大条数 (0为不限制)</label>
                            <input type="number" id="nuke-log-limit-input" min="0" step="100">
                        </div>
                        <div class="nuke-setting-item">
                            <label for="nuke-spam-auto-expand-toggle">推文页自动展开「可能的垃圾回复」</label>
                            <input type="checkbox" id="nuke-spam-auto-expand-toggle">
                        </div>
                        <div class="nuke-setting-item">
                            <label for="nuke-username-rule-follower-input">粉丝数豁免</label>
                            <input type="number" id="nuke-username-rule-follower-input" min="0" step="1">
                        </div>
                        <div class="nuke-setting-item">
                            <label for="nuke-blue-verified-exempt-toggle">蓝 V 用户自动豁免</label>
                            <input type="checkbox" id="nuke-blue-verified-exempt-toggle">
                        </div>
                    </section>
                    <section class="nuke-settings-module">
                        <h3 class="nuke-settings-module-title">用户名规则</h3>
                        <label class="nuke-settings-label" for="nuke-keywords-standard-textarea">常规用户名关键词 (每行一条; 支持纯文本或正则)</label>
                        <textarea id="nuke-keywords-standard-textarea" class="nuke-config-textarea nuke-keywords-textarea" placeholder="例如: 点击主页&#10;💚(少妇|姐姐|妈妈)💚"></textarea>
                    </section>
                    <section class="nuke-settings-module">
                        <h3 class="nuke-settings-module-title">引流识别</h3>
                        <div class="nuke-setting-item">
                            <label for="nuke-spam-identify-toggle">引流识别（命中后标记；自动九族开启时拉黑）</label>
                            <input type="checkbox" id="nuke-spam-identify-toggle">
                        </div>
                        <div class="nuke-setting-item">
                            <label for="nuke-spam-identify-score-input">推文引流识别最低得分</label>
                            <input type="number" id="nuke-spam-identify-score-input" min="1" max="10" step="1">
                        </div>
                    </section>
                    <section class="nuke-settings-module">
                        <h3 class="nuke-settings-module-title">头像 OCR</h3>
                        <div class="nuke-setting-item nuke-ocr-engine-item">
                            <label for="nuke-spam-avatar-ocr-engine">头像 OCR 引擎</label>
                            <div class="nuke-ocr-engine-controls">
                                <span id="nuke-spam-avatar-ocr-engine-status" class="nuke-ocr-engine-status nuke-ocr-engine-status--idle" role="status" aria-live="polite" title=""></span>
                                <select id="nuke-spam-avatar-ocr-engine">
                                    <option value="off">关闭头像 OCR</option>
                                    <option value="tesseract">Tesseract.js（默认，较轻）</option>
                                    <option value="paddle">PaddleOCR（paddleocr，较准）</option>
                                </select>
                            </div>
                        </div>
                        <label class="nuke-settings-label" for="nuke-spam-avatar-keywords-textarea">头像 OCR 关键词 (每行一条; 留空则用用户名关键词; 另自动识别头像内「全国安排」)</label>
                        <textarea id="nuke-spam-avatar-keywords-textarea" class="nuke-config-textarea nuke-keywords-textarea" placeholder="全国安排&#10;点击主页"></textarea>
                    </section>
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
                    <p class="nuke-verify-note">开启「自动九族拉黑」后，推文 @ 列表中账号会触发九族拉黑；关闭时只标记命中项。手动九族拉黑时，推文里的 @ 会始终收录进此列表并立刻拉黑。</p>
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
        panel.querySelector('#nuke-username-rule-follower-input').value = config.usernameRuleFollowerExemptThreshold ?? DEFAULT_USERNAME_RULE_FOLLOWER_EXEMPT_THRESHOLD;
        panel.querySelector('#nuke-blue-verified-exempt-toggle').checked = config.blueVerifiedExemptEnabled !== false;
        panel.querySelector('#nuke-keywords-standard-textarea').value = (config.blockKeywordsStandard || []).join('\n');
        panel.querySelector('#nuke-spam-identify-toggle').checked = config.spamIdentifyEnabled !== false;
        const engineSelect = panel.querySelector('#nuke-spam-avatar-ocr-engine');
        engineSelect.value = normalizeAvatarOcrEngine(config.spamAvatarOcrEngine);
        engineSelect.addEventListener('change', () => {
            const selectedEngine = normalizeAvatarOcrEngine(engineSelect.value);
            if (selectedEngine === AVATAR_OCR_ENGINE_OFF) setAvatarOcrEngineUiStatus('idle');
            else void preloadAvatarOcrEngineForUi(selectedEngine);
        });
        if (isAvatarOcrEnabled()) {
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
            config.usernameRuleFollowerExemptThreshold = Math.max(0, parseInt(panel.querySelector('#nuke-username-rule-follower-input').value, 10) || DEFAULT_USERNAME_RULE_FOLLOWER_EXEMPT_THRESHOLD);
            config.blueVerifiedExemptEnabled = panel.querySelector('#nuke-blue-verified-exempt-toggle').checked;
            config.blockKeywordsStandard = panel.querySelector('#nuke-keywords-standard-textarea').value.split('\n').map(kw => kw.trim()).filter(Boolean);
            config.spamIdentifyEnabled = panel.querySelector('#nuke-spam-identify-toggle').checked;
            const nextEngine = normalizeAvatarOcrEngine(panel.querySelector('#nuke-spam-avatar-ocr-engine').value);
            const engineChanged = normalizeAvatarOcrEngine(config.spamAvatarOcrEngine) !== nextEngine;
            const nextAvatarKeywords = panel.querySelector('#nuke-spam-avatar-keywords-textarea').value.split('\n').map((kw) => kw.trim()).filter(Boolean);
            const avatarKeywordsChanged = JSON.stringify(config.spamAvatarKeywords || []) !== JSON.stringify(nextAvatarKeywords);
            if (engineChanged || avatarKeywordsChanged) {
                avatarOcrCache.clear();
                resetAvatarOcrRuntime();
                resetAvatarOcrArticleMarkers();
            }
            config.spamAvatarOcrEngine = nextEngine;
            delete config.spamAvatarOcrEnabled;
            delete config.longNameFollowerExemptThreshold;
            config.spamAutoExpandHidden = panel.querySelector('#nuke-spam-auto-expand-toggle').checked;
            config.spamAvatarKeywords = nextAvatarKeywords;
            config.spamIdentifyMinScore = Math.max(1, parseInt(panel.querySelector('#nuke-spam-identify-score-input').value, 10) || DEFAULT_SPAM_IDENTIFY_MIN_SCORE);
            await saveConfig(config);
            if (engineChanged || avatarKeywordsChanged) scheduleDetectionScan(true, 0);
            ensureManualDetectedNukeButton();
            if (nextEngine !== AVATAR_OCR_ENGINE_OFF) {
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
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const SPAM_ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const SPAM_CJK_PUNCT_RE = /[·•・|，,。.!！?？:：;；\-—_~～*＊/\\[\]【】()（）「」『』《》〈〉"'‘’“”\s]/g;
const SPAM_ASCII_NOISE_BETWEEN_CJK_RE = /([\u4e00-\u9fff])[a-z0-9]{1,8}(?=[\u4e00-\u9fff])/gi;
function isShortDatingInviteCompact(compact) {
    const text = String(compact || '').replace(/[^\u4e00-\u9fffa-z0-9@]/gi, '');
    return text.length <= 14 && (/^(?:来)?聊聊在线等$/.test(text) || (/见见吗/.test(text) && /睡不着/.test(text)) || (/想找/.test(text) && /会疼人|疼人的|哥哥|姐姐|妹妹/.test(text)) || /^(?:嘻嘻|嘿嘿|哈哈)?(?:求求了|求求)?(?:好|我)?寂寞(?:在线|在吗|求聊|想聊|聊聊|等你|等聊)?[a-z0-9]{0,2}$/.test(text) || /^嘿嘿有点(?:难受|寂寞)(?:在线|求聊|想聊)?$/.test(text) || /^想要[呀啊嘛吗]?有点(?:难受|寂寞)(?:在线|求聊|想聊)?$/.test(text) || /^有点(?:难受|寂寞)(?:在线|求聊|想聊)$/.test(text) || /^想被(?:抱紧|抱抱|疼|宠|陪|哄|摸摸)(?:在线|在吗|求聊|想聊|聊聊)?[a-z0-9]{0,2}$/.test(text) || /^(?:在线等)?想找人(?:疼|宠|陪|抱抱|哄)[a-z0-9]{0,2}$/.test(text) || /^[a-z0-9]{1,2}夜深了(?:嘿嘿|嘻嘻)[a-z0-9]{0,2}$/.test(text));
}
function hasStandaloneDd(compact) {
    return /(^|[^a-z0-9])dd([^a-z0-9]|$)/i.test(String(compact || ''));
}
function extractSpamEmojiChars(text) {
    return Array.from(String(text || '').matchAll(/\p{Extended_Pictographic}/gu), (match) => match[0]);
}
function spamEmojiBucket(emoji) {
    const codePoint = Array.from(String(emoji || '')).find((char) => {
        const cp = char.codePointAt(0) || 0;
        return cp > 0xff && cp !== 0xfe0f && cp !== 0x200d;
    })?.codePointAt(0) || 0;
    return codePoint ? Math.floor(codePoint / 0x40) : 0;
}
function isEmojiOnlyBaitText(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    const hasLeadingMention = /^\s*(?:@[a-z0-9_]{1,20}\s*)+/i.test(raw);
    const source = raw
        .trim()
        .replace(/^(?:@[a-z0-9_]{1,20}\s*)+/i, '')
        .trim();
    if (!source) return false;
    const emojis = extractSpamEmojiChars(source);
    if (emojis.length < 4 || new Set(emojis).size < 3) return false;
    const groups = source.split(/\n+/).map((part) => part.trim()).filter(Boolean);
    const nonEmoji = source.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\u200b-\u200d\u2060\ufeff\u00ad\ufe0f\s]/g, '');
    if (nonEmoji) return false;
    const clusters = source.split(/[\s\u200b-\u200d\u2060\ufeff\u00ad]+/).map((part) => part.trim()).filter(Boolean);
    const bucketCount = new Set(emojis.map(spamEmojiBucket).filter(Boolean)).size;
    const newlineLayout = groups.length >= 3 && bucketCount >= 2;
    const mentionRandomLayout = hasLeadingMention && emojis.length >= 5 && new Set(emojis).size >= 4 && clusters.length >= 4 && bucketCount >= 3;
    return newlineLayout || mentionRandomLayout;
}
function isShortLocationInviteCompact(compact) {
    const text = String(compact || '').replace(/[^\u4e00-\u9fffa-z0-9]/gi, '');
    if (text.length > 18) return false;
    return /^(?:有|有没有)[\u4e00-\u9fff]{0,8}(?:线下|同城|附近的?)(?:吗|嘛|不)[a-z0-9]{0,3}$/i.test(text);
}
function isPetRoleInviteCompact(compact) {
    const text = String(compact || '').replace(/[^\u4e00-\u9fffa-z0-9]/gi, '');
    if (text.length > 18) return false;
    return /^(?:小狗|狗狗|修狗|小猫|猫猫)(?:求|找|想要).{0,4}(?:主人|主|哥哥|姐姐).{0,4}(?:抱抱|摸摸|收留|带走|领养)[a-z0-9]{0,3}$/i.test(text);
}
function isAdultEndorsementContextCompact(compact) {
    const text = String(compact || '');
    const subject = '(?:她|他|女大|女高|老师|御姐|人妻|少妇|熟女|妹|姐)';
    const endorsement = '(?:极品|够劲|带劲|炸裂)';
    return new RegExp(`${subject}.{0,20}${endorsement}|${endorsement}.{0,20}${subject}`).test(text);
}
function isIncidentClipFunnelCompact(compact) {
    const text = String(compact || '').toLowerCase();
    const platform = '(?:快手|抖音|小红书|视频号|微博|b站|bilibili)';
    const accountDiscovery = new RegExp(`${platform}(?:号|账号|帐号).{0,20}?(?:被扒|扒出来|被曝光|曝光了?|曝光出来|找到了?|搜到了?|搜出来)|(?:被扒|扒出来|被曝光|曝光了?|曝光出来|找到了?|搜到了?|搜出来).{0,20}?${platform}(?:号|账号|帐号)`).test(text);
    const hotspotContext = /凶手|嫌疑人|犯人|肇事|施暴|行凶|涉事|当事|受害|遇害|被害|死亡|死者|老师|校长|学生|司机|女生|男生|网红|塌房|突发|出事|大事|热点|新闻|事件|事故|爆炸|跳楼|坠楼|车祸|杀|砍|打人|瓜/.test(text);
    const clipLure = /(?:第一视角|本人录|本人拍|作案|行凶|现场|完整(?:版)?|原(?:版|视频)?|监控|录像|录屏|偷拍视频|后续|全过程|全程|未删减|高清|瓜).{0,10}?视频|视频.{0,10}?(?:第一视角|本人录|本人拍|作案|行凶|现场|完整(?:版)?|原(?:版|视频)?|监控|录像|录屏|偷拍视频|后续|全过程|全程|未删减|高清|还在|没删|没封|能看)/.test(text);
    const stillVisible = /(?:现在|视频|里面|原视频|完整视频|录屏|监控|现场).{0,10}?(?:还在|没删|没封|还能看|能看|可以看)|(?:去|可以|你们|大家|自己|快去|好奇去|我去搜了?一下).{0,12}?(?:看看|搜|搜索|围观|去看)|搜.{0,8}?(?:一下|看看|就有|还真有)/.test(text);
    const platformNeglect = new RegExp(`${platform}.{0,8}?(?:居然|竟然)?(?:不封号|不删|没封|没删)`).test(text);
    return accountDiscovery && hotspotContext && clipLure && (stillVisible || platformNeglect);
}
function isAdultPlatformClipFunnelCompact(compact) {
    const text = String(compact || '').toLowerCase();
    const platform = '(?:快手|抖音|小红书|视频号|微博|b站|bilibili)';
    const accountDiscovery = new RegExp(`${platform}(?:号|账号|帐号|博主).{0,24}?(?:被扒|扒出来|被曝光|曝光了?|曝光出来|找到了?|搜到了?|搜出来)|(?:被扒|扒出来|被曝光|曝光了?|曝光出来|找到了?|搜到了?|搜出来).{0,24}?${platform}(?:号|账号|帐号|博主)|(?:评论区|有人说).{0,24}?${platform}博主|(?:男主|女主|主角|当事人)?.{0,8}?是${platform}博主|瓜视频.{0,12}?(?:可以看|看).{0,20}?${platform}博主|(?:跑去|好奇去|我去|去|特意去|专门上|摸去)?${platform}(?:翻|搜|搜索|看|查证|核对|查找|检索)|搜.{0,8}${platform}.{0,12}?(?:真是|本人|还真)`).test(text);
    const adultContext = /小姐|操破|草破|顶裂|干穿|搞破|捅破|刺穿|捣碎|操烂|黄体|扣.{0,4}?(?:b|逼|比)|馒头比|馒头逼|溢出|液体|客人|没拿她当人|破处|喷出|汁|私密|黏液|淌出|热液|反绑/.test(text);
    const clipLure = /(?:作品|作品里|作品里面|动态|动态里|主页|账号|那儿|挂着|摆着|存着|里面|视频|录像|片段|原片|片子|现场记录|记录|私密原视频).{0,28}?(?:视频|录像|片段|原片|片子|现场记录|记录|黄体|液体|汁|扣.{0,4}?(?:b|逼|比)|顶裂|干穿|捅破|刺穿|捣碎|操烂|操破|草破|反绑)|(?:视频|录像|片段|原片|片子|现场记录|私密原视频).{0,24}?(?:作品|动态|主页|账号|里面|还在|有|抖落)/.test(text);
    const spreadHook = new RegExp(`(?:跑去|好奇去|我去|去|特意去|专门上|摸去|八卦去)${platform}?(?:翻|搜|搜索|看|查证|核对|查找|检索).{0,20}?(?:还真是|还真有|有|看过|真是|本人|一模一样|同一个人|确实是|发现|惊叹)|搜.{0,8}${platform}.{0,16}?(?:真是|本人|还真|有)|${platform}.{0,12}?(?:居然|竟然|这样|都|也|竟能)?(?:不封|没封|不管|不删|没删|不处理|没处理|不封禁|封禁|能容下|能忍)|这都不管`).test(text);
    return accountDiscovery && adultContext && clipLure && spreadHook;
}
const PROFILE_BIO_SIGNAL_DEFS = [
    { id: 'bio_adult_service', label: '成人服务简介', weight: 2, test: (compact, raw) => /(?:曰|日|约).{0,3}炮|同城.{0,8}(?:约|空降|上门)|附近.{0,8}(?:可加|加v|加微|加薇|约)|外围|楼凤|援交|约妹|约啪|约拍私房/i.test(compact) || /(?:曰|日|约)\s*炮|附近的?可加\s*v/i.test(raw) },
    { id: 'bio_trust_pitch', label: '平台认证话术', weight: 1, test: (compact, raw) => /(?:已入驻|入驻).{0,10}平台|真人认证|隐私.{0,8}(?:保护|安全|保障)|平台.{0,10}(?:隐私|认证|保障|安全)/.test(compact) || /真人认证|隐私保护|隐私安全|上平台隐私安全有保障/.test(raw) },
    { id: 'bio_contact_route', label: '简介联系方式', weight: 1, test: (compact, raw) => /https?:\/\/\s*[a-z0-9][a-z0-9.-]{2,}\.(?:top|xyz|cc|vip|lol|icu|com|net|org)|[a-z0-9][a-z0-9.-]{2,}\.(?:top|xyz|cc|vip|lol|icu|com|net|org)\b|加\s*[v微薇]|小号.{0,8}(?:禁言|被封|封了)|大号.{0,8}(?:在这|看这)|@[a-z0-9_]{3,15}|电报|telegram|(?:^|[^a-z])tg(?:[^a-z]|$)/i.test(raw) || /加v|加微|加薇|小号.{0,8}(?:禁言|被封|封了)|大号.{0,8}(?:在这|看这)/i.test(compact) }
];
function detectProfileBioSpam(text) {
    const rawInput = String(text || '');
    const raw = normalizeSpamText(rawInput);
    const compact = compactSpamText(raw);
    if (!raw || raw.length < 8) return { match: false, score: 0, signals: [], summary: '' };
    const signals = [];
    let score = 0;
    for (const def of PROFILE_BIO_SIGNAL_DEFS) {
        if (def.test(compact, raw, rawInput)) {
            signals.push({ id: def.id, label: def.label, weight: def.weight });
            score += def.weight;
        }
    }
    const adultService = signals.some((s) => s.id === 'bio_adult_service');
    const trustPitch = signals.some((s) => s.id === 'bio_trust_pitch');
    const contactRoute = signals.some((s) => s.id === 'bio_contact_route');
    const match = adultService && (trustPitch || contactRoute) && score >= 3;
    const summary = signals.map((s) => s.label).join('、') || '';
    return { match, score, signals, summary, compactPreview: compact.slice(0, 80) };
}
const SPAM_SIGNAL_DEFS = [
    { id: 'scroll_time', label: '刷帖/逛推时长', weight: 1, test: (compact) => /(?:刷|逛|翻|看|扫).{0,12}?(?:半天|一晚|一天|一晚上|好久|很久|许久|好一会|一会儿|一会|小时)/.test(compact) || /刚.{0,4}?(?:刷|逛|翻)完/.test(compact) },
    { id: 'platform_ref', label: '提及X/推特', weight: 1, test: (compact) => /(?:^|[^a-z0-9])x(?:[^a-z0-9]|$)/i.test(compact) || /推特|小蓝鸟|twitter/.test(compact) },
    { id: 'profile_cta', label: '主页/空间导流', weight: 1, test: (compact) => /主页|个人页|主頁|置顶|简介|资料|链接在|点主页|戳主页|看她主页|看他主页|她主页|他主页/.test(compact) || (/空间/.test(compact) && !/收益空间/.test(compact)) },
    { id: 'adult_euphemism', label: '色情暗语/飞机', weight: 1, test: (compact, raw) => /打.{0,3}?飞|能飞|起飞|开飞|✈|🛫|🛩|飞机|打飞机|打飞機/.test(compact + raw) || /舅舅|涩涩|福利|懂的都懂|(?:擦边|私房|色色|涩涩|成人).{0,4}?资源/.test(compact) },
    { id: 'adult_persona', label: '成人人设暗语', weight: 1, test: (compact) => /福利[鸡姬]/.test(compact) },
    { id: 'age_tag', label: '年龄标签(30+等)', weight: 1, test: (compact, raw) => /(?:^|[^\d])(?:1[89]|[2-5]\d|60)\+/.test(compact + raw) || /(?:20|30|40|五十|四十|三十|二十)多/.test(compact) || /三十加|四十加|二十加/.test(compact) },
    { id: 'persona_role', label: '职业/人设套词', weight: 1, test: (compact) => /体制内|女老师|老师|护士|御姐|人妻|空姐|校花|女大|熟女|少妇|萝莉|模特|舞蹈生|考研生|女高|单亲|宝妈/.test(compact) },
    { id: 'explore_tease', label: '探路/花样暗示', weight: 1, test: (compact) => /已探路|探过路|探路|花样多|花样不少|玩法多|会玩|懂玩|玩(?:得|的)?开|放得开|经验丰富|去过都说|真会玩/.test(compact) },
    { id: 'contrast_tease', label: '反差/返差暗示', weight: 1, test: (compact) => /反差|返差/.test(compact) },
    { id: 'offline_lewd_claim', label: '线下色情经历', weight: 1, test: (compact) => /线下/.test(compact) && /日过|曰过|睡过|约过/.test(compact) },
    { id: 'lewd_reaction', label: '色情反应话术', weight: 1, test: (compact) => /太涩|好涩|真涩|很涩|涩的很|涩了|色了|太色|好色|很色|色的很|顶不住|受不了|扛不住|绷不住|把持不住|定力不够|真顶|顶不住/.test(compact) },
    { id: 'lewd_slang', label: '骚/谐音sao', weight: 1, test: (compact) => /骚货|骚的很|很骚|太骚|真骚|骚死|骚批|比.*?骚/.test(compact) || /[这那][4么麼]?么?骚/.test(compact) || /sao货|sao的很|sao死|sao批|很sao|真sao|太sao|巨sao|sao女|sao姐|sao哥/.test(compact) || /比她sao|比他还sao|没人比.{0,8}?sao|比.*sao/.test(compact) || /第一(?:骚|sao)|第1(?:骚|sao)|最(?:骚|sao)|巨(?:骚|sao)/.test(compact) },
    { id: 'mention_promo', label: '@导流', weight: 1, test: (compact, raw) => /@[a-z0-9_]{2,}/i.test(raw) || /就.{0,8}?@|去@|看@|戳@|关注@/.test(compact) },
    { id: 'external_link', label: '外部链接', weight: 1, test: (compact, raw) => /https?:\/\/[^\s]+|(?:^|[^a-z0-9])www\.[a-z0-9]/i.test(raw) },
    { id: 'dating_hook', label: '交友/同城套词', weight: 1, test: (compact) => /同城|附近|搭子|固炮|真人|线下|见面|私聊|约会|少妇|姐姐|妹妹/.test(compact) || hasStandaloneDd(compact) },
    { id: 'adult_experience_claim', label: '线下体验暗示', weight: 1, test: (compact) => /线下|真人|真实/.test(compact) && /宝宝|妹妹|姐姐|身材|福利/.test(compact) && /我(?:试|試)过|(?:试|試)过了|真的?很不错|身材(?:特棒|很好|不错)|特棒/.test(compact) },
    { id: 'short_dating_invite', label: '短句交友导流', weight: 3, test: (compact) => isShortDatingInviteCompact(compact) },
    { id: 'course_funnel', label: '课程/教程导流', weight: 3, test: (compact) => /英语|外语|日语|韩语|西班牙语|语言学习|任何语言|流利学会/.test(compact) && /公开课|这堂课|课程|教程|底层方法论|唯一正确|秘诀|快速学会|强烈建议刷|早知道.{0,12}?方法|别再.{0,12}?(?:不科学|浪费时间)|学会任何语言|流利学会任何语言/.test(compact) },
    { id: 'gray_money_funnel', label: '灰产/赚钱导流', weight: 3, test: (compact) => /交易所|okx|返佣|长期套利|收益空间|网赚|副业|偏门|跑分|灰产|日结|快钱|搞钱|洗钱|外汇/.test(compact) && /联系我|私聊|有兴趣了解|兴趣了解|可以联系|可以玩|稳定长期|每天都有收益|稳定执行|流程清晰|带你|稳赚/.test(compact) },
    { id: 'incident_clip_funnel', label: '事件视频导流', weight: 3, test: (compact) => isIncidentClipFunnelCompact(compact) },
    { id: 'adult_platform_clip_funnel', label: '成人偷拍视频导流', weight: 3, test: (compact) => isAdultPlatformClipFunnelCompact(compact) },
    { id: 'emoji_only_bait', label: '纯 emoji 诱导', weight: 3, test: (compact, raw, source) => isEmojiOnlyBaitText(source) },
    { id: 'short_location_invite', label: '短句位置邀约', weight: 3, test: (compact) => isShortLocationInviteCompact(compact) },
    { id: 'pet_role_invite', label: '宠物角色邀约', weight: 3, test: (compact) => isPetRoleInviteCompact(compact) },
    { id: 'drive_link', label: '网盘链接', weight: 2, test: (compact, raw) => /pan\.quark\.cn|drive\.uc\.cn|aliyundrive\.com|115\.com|lanzou|mega\.nz/i.test(raw) },
    { id: 'core_template', label: '核心话术模板', weight: 2, test: (compact) => /刷.{0,18}?(?:半天|一晚|一天|一晚上|好久|很久).{0,24}?(?:x|推特|小蓝鸟).{0,18}?(?:她|他|这)?.{0,18}?主.?页.{0,24}?(?:打.{0,4}?飞|✈|起飞|能飞)/.test(compact) || /刷.{0,12}?(?:x|推特).{0,18}?主.?页.{0,18}?(?:打.{0,4}?飞|✈)/.test(compact) }
];
function normalizeSpamText(text) {
    let s = String(text || '');
    try { s = s.normalize('NFKC'); } catch { /* ignore */ }
    s = s.replace(SPAM_ZERO_WIDTH_RE, '').replace(/[Ⅹⅹ❌✖]/g, 'x').replace(/[＠﹫]/g, '@').replace(/[ｘＸ]/g, 'x').replace(/\uFE0F/g, '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+\d+\s*(?:[iyh]|s)\s*$/i, '').trim();
    return s;
}
function compactSpamText(text) {
    return normalizeSpamText(text).replace(SPAM_CJK_PUNCT_RE, '').toLowerCase();
}
function compactSpamTextVariants(text) {
    const compact = compactSpamText(text);
    const folded = compact.replace(SPAM_ASCII_NOISE_BETWEEN_CJK_RE, '$1');
    return folded && folded !== compact ? [compact, folded] : [compact];
}
function detectSpamReply(text, options = {}) {
    const minScore = options.minScore ?? scriptConfig.spamIdentifyMinScore ?? DEFAULT_SPAM_IDENTIFY_MIN_SCORE;
    const rawInput = String(text || '');
    const raw = normalizeSpamText(rawInput);
    const compact = compactSpamText(raw);
    const compactVariants = compactSpamTextVariants(raw);
    const shortDatingInvite = isShortDatingInviteCompact(compact);
    const emojiOnlyBait = isEmojiOnlyBaitText(rawInput);
    if (!raw || (raw.length < 8 && !shortDatingInvite && !emojiOnlyBait)) return { match: false, score: 0, signals: [], summary: '' };
    if (!/[\u4e00-\u9fff]/.test(raw) && !/pan\.quark|drive\.uc/i.test(raw) && !emojiOnlyBait) return { match: false, score: 0, signals: [], summary: '' };
    const signals = [];
    let score = 0;
    for (const def of SPAM_SIGNAL_DEFS) {
        if (compactVariants.some((candidate) => def.test(candidate, raw, rawInput))) {
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
    const adultEndorsementHit = isAdultEndorsementContextCompact(compact);
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
    if (!match && mentionHit && exploreHit && adultEndorsementHit) match = true;
    return { match, score, signals, summary: signals.map((s) => s.label).join('、') };
}
function getTweetTextFromArticle(article) {
    const textNodes = article?.querySelectorAll('[data-testid="tweetText"]');
    if (!textNodes?.length) return '';
    return Array.from(textNodes).map(textContentWithImageAlt).filter(Boolean).join('\n').trim();
}
function textContentWithImageAlt(root) {
    if (!root) return '';
    const parts = [];
    const visit = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.textContent || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node;
        if (element.tagName === 'IMG') {
            const alt = element.getAttribute('alt') || '';
            if (alt) parts.push(alt);
            return;
        }
        element.childNodes.forEach(visit);
    };
    visit(root);
    return parts.join('')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n+ */g, '\n')
        .trim();
}
function normalizePromoHandle(handle) {
    return String(handle || '').trim().replace(/^@+/, '').toLowerCase();
}
function normalizeNukeTaskIds(taskIds) {
    const values = Array.isArray(taskIds) ? taskIds : (taskIds ? [taskIds] : []);
    return [...new Set(values.map(String).filter(Boolean))];
}
function mergeNukeTaskIds(...sources) {
    return normalizeNukeTaskIds(sources.flatMap((source) => normalizeNukeTaskIds(source)));
}
function getEntryNukeTaskIds(entry) {
    return mergeNukeTaskIds(entry?.nukeTaskIds, entry?.nukeTaskId);
}
function attachNukeTaskIdsToEntry(entry, taskIds) {
    if (!entry) return entry;
    const merged = mergeNukeTaskIds(getEntryNukeTaskIds(entry), taskIds);
    if (merged.length) entry.nukeTaskIds = merged;
    return entry;
}
function getHiddenUserStorageKey(entry) {
    const userId = entry?.userId ? String(entry.userId) : '';
    if (userId) return `id:${userId}`;
    const screenName = normalizePromoHandle(entry?.screenName);
    return screenName ? `handle:${screenName}` : '';
}
function getHiddenUserStorageKeys(entry) {
    const keys = [];
    const userId = entry?.userId ? String(entry.userId) : '';
    const screenName = normalizePromoHandle(entry?.screenName);
    if (userId) keys.push(`id:${userId}`);
    if (screenName) keys.push(`handle:${screenName}`);
    return keys;
}
function mergePendingHiddenUserEntries(existing = [], incoming = [], now = Date.now()) {
    const byKey = new Map();
    (existing || []).forEach((entry) => {
        const key = getHiddenUserStorageKey(entry);
        if (!key) return;
        byKey.set(key, {
            ...entry,
            screenName: normalizePromoHandle(entry.screenName),
            addedAt: entry.addedAt || now,
            lastSeenAt: entry.lastSeenAt || entry.addedAt || now
        });
    });
    (incoming || []).forEach((entry) => {
        const key = getHiddenUserStorageKey(entry);
        if (!key) return;
        const prev = byKey.get(key);
        byKey.set(key, {
            ...prev,
            ...entry,
            userId: entry.userId || prev?.userId || null,
            screenName: normalizePromoHandle(entry.screenName || prev?.screenName),
            userNameText: entry.userNameText || prev?.userNameText || normalizePromoHandle(entry.screenName || prev?.screenName),
            nukeTaskIds: mergeNukeTaskIds(prev?.nukeTaskIds, entry.nukeTaskIds),
            addedAt: prev?.addedAt || entry.addedAt || now,
            lastSeenAt: now
        });
    });
    const limit = typeof PENDING_HIDDEN_USERS_LIMIT === 'number' ? PENDING_HIDDEN_USERS_LIMIT : 2000;
    return Array.from(byKey.values())
        .sort((a, b) => (b.lastSeenAt || b.addedAt || 0) - (a.lastSeenAt || a.addedAt || 0))
        .slice(0, limit);
}
function queueHiddenUserRelease(userData, entry, now = Date.now()) {
    if (!userData) return false;
    const key = getHiddenUserStorageKey(entry);
    if (!key) return false;
    const releases = Array.isArray(userData.hiddenReleaseQueue) ? userData.hiddenReleaseQueue : [];
    const next = { userId: entry.userId || null, screenName: normalizePromoHandle(entry.screenName), releasedAt: now };
    const limit = typeof HIDDEN_RELEASE_QUEUE_LIMIT === 'number' ? HIDDEN_RELEASE_QUEUE_LIMIT : 2000;
    userData.hiddenReleaseQueue = mergePendingHiddenUserEntries(releases, [next], now).slice(0, limit);
    return true;
}
function applyHiddenUserReleaseQueue(userData) {
    if (!userData || !Array.isArray(userData.hiddenReleaseQueue) || userData.hiddenReleaseQueue.length === 0) return 0;
    const releaseKeys = new Set(userData.hiddenReleaseQueue.flatMap(getHiddenUserStorageKeys).filter(Boolean));
    const before = userData.pendingHiddenUsers?.length || 0;
    userData.pendingHiddenUsers = (userData.pendingHiddenUsers || []).filter((entry) => !getHiddenUserStorageKeys(entry).some((key) => releaseKeys.has(key)));
    userData.hiddenReleaseQueue = [];
    return before - userData.pendingHiddenUsers.length;
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
async function queuePromoTargetHandle(handle, userData, tweetContext, whitelistIds, exemptHandles) {
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
    const entry = {
        userId,
        screenName: normalized,
        userNameText: userResult.core?.name || userResult.legacy?.name || normalized,
        blockReason: 'promo_target',
        blockNote: `引流目标·@${normalized}${formatTweetContextSuffix(tweetContext)}`.trim(),
        sourceTweetId: tweetContext.tweetId || null,
        sourceTweetUrl: tweetContext.tweetUrl || '',
        sourceTweetText: tweetContext.tweetText || ''
    };
    userData.queue.push(entry);
    addPendingHiddenUsers(userData, [createPendingHiddenUserEntry(entry, tweetContext)]);
    applyPendingHiddenUsersToPage(userData);
    return true;
}
async function processPromoMentionsFromArticle(targetArticle, tweetContext, userData, authorHandle, whitelistIds, exemptHandles) {
    const mentions = extractMentionHandlesFromArticle(targetArticle, authorHandle);
    if (!mentions.length) return { added: [], blocked: 0 };
    userData.promoTargets = mergePromoTargetEntries(userData.promoTargets, mentions, {
        sourceNote: `九族收录·@${authorHandle || '未知'}`
    });
    let queued = 0;
    for (const handle of mentions) {
        if (await queuePromoTargetHandle(handle, userData, tweetContext, whitelistIds, exemptHandles)) queued += 1;
    }
    await saveUserData(userData);
    if (queued > 0) {
        showToast('nuke-promo-target-toast', '引流目标已入队', `已隐藏并加入 ${queued} 个推文 @ 用户`, 3500);
    }
    return { added: mentions, queued };
}
function normalizeOcrText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
}
function isCommonAvatarPriorityTextChar(char) {
    if (/[\p{Script=Han}\p{Script=Latin}\p{N}\s]/u.test(char)) return true;
    return /[.,!?'"@#:/\\\-+，。！？、…·（）()【】[\]_]/u.test(char);
}
function isDecorativeUnicodeAvatarOcrPriorityText(text) {
    const raw = String(text || '');
    const compact = raw.replace(/\s+/g, '');
    if (compact.length < 24 || compact.length > 180) return false;
    const chars = Array.from(raw);
    const latinCount = chars.filter((char) => /\p{Script=Latin}/u.test(char)).length;
    if (latinCount < 18) return false;
    const decorativeCount = chars.filter((char) => {
        if (isCommonAvatarPriorityTextChar(char)) return false;
        return (char.codePointAt(0) || 0) > 0x7f;
    }).length;
    return decorativeCount >= 8 && decorativeCount / Math.max(1, compact.length) >= 0.1;
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
    const configured = Array.isArray(dedicated) && dedicated.length
        ? dedicated.filter(Boolean)
        : (scriptConfig.blockKeywordsStandard || []).filter(Boolean);
    const patterns = [...configured];
    BUILT_IN_AVATAR_OCR_KEYWORDS.forEach((keyword) => {
        if (keyword && !patterns.includes(keyword)) patterns.push(keyword);
    });
    return patterns;
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
    const source = normalizeOcrText(compact).replace(/[^\p{L}\p{N}]/gu, '');
    const target = normalizeOcrText(keyword);
    if (target.length < 4 || hasRegexMeta(target)) return false;
    if (source.includes(target)) return true;
    const maxDistance = target.length <= 4 ? 1 : Math.max(2, Math.floor(target.length * 0.34));
    const minCommon = target.length - maxDistance;
    const minLen = Math.max(1, target.length - maxDistance);
    const maxLen = target.length + maxDistance;
    for (let start = 0; start < source.length; start += 1) {
        for (let len = minLen; len <= maxLen && start + len <= source.length; len += 1) {
            const candidate = source.slice(start, start + len);
            if (commonSubsequenceLength(candidate, target) < minCommon) continue;
            if (levenshteinDistance(candidate, target, maxDistance) <= maxDistance) return true;
        }
    }
    return false;
}
function matchesSplitOcrKeywordParts(compact, keyword) {
    const target = normalizeOcrText(keyword);
    if (target.length < 4 || hasRegexMeta(target)) return false;
    const firstPart = target.slice(0, 2);
    const lastPart = target.slice(-2);
    const firstIndex = compact.indexOf(firstPart);
    if (firstIndex < 0) return false;
    const lastIndex = compact.indexOf(lastPart, firstIndex + firstPart.length);
    return lastIndex >= 0 && lastIndex - firstIndex <= 120;
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
        if (matchesSplitOcrKeywordParts(compact, pattern)) return { match: true, hit: pattern };
    }
    return { match: false, hit: '' };
}
function detectPromoAvatarSignature(ocrText, patterns) {
    const keywordHit = matchesAvatarOcrKeywords(ocrText, patterns);
    if (keywordHit.match) {
        return { match: true, hit: keywordHit.hit, source: 'ocr' };
    }
    return { match: false, hit: '', source: 'none' };
}
function fetchImageArrayBuffer(url) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'arraybuffer',
            timeout: AVATAR_IMAGE_FETCH_TIMEOUT_MS,
            onload: (response) => {
                if (response.status >= 200 && response.status < 300 && response.response?.byteLength > 64) {
                    resolve(response.response);
                } else {
                    reject(new Error(`avatar fetch ${response.status}`));
                }
            },
            onerror: () => reject(new Error('avatar fetch network error')),
            ontimeout: () => reject(new Error('avatar fetch timeout'))
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
    return normalizeOcrText(collectPaddleOcrTexts(result).join(''));
}
function collectPaddleOcrTexts(value, texts = [], seen = new WeakSet()) {
    if (!value) return texts;
    if (typeof value === 'string') {
        texts.push(value);
        return texts;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectPaddleOcrTexts(item, texts, seen));
        return texts;
    }
    if (typeof value !== 'object') return texts;
    if (seen.has(value)) return texts;
    seen.add(value);
    if (typeof value.text === 'string') texts.push(value.text);
    [
        'parse',
        'parragraphs',
        'paragraphs',
        'columns',
        'src',
        'lines',
        'words',
        'result',
        'data'
    ].forEach((key) => {
        if (value[key] != null) collectPaddleOcrTexts(value[key], texts, seen);
    });
    return texts;
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
            report(8, '加载 PaddleOCR…');
            const Paddle = await loadPaddleModule();
            report(18, '加载 ONNX Runtime…');
            const ortRef = await ensureUserscriptOrt();
            report(32, '下载识别模型…');
            startPaddleUiProgressPulse(onProgress, 36);
            const [detTar, recTar] = await Promise.all([
                gmFetchArrayBuffer(PADDLE_DET_TAR_URL, 180000),
                gmFetchArrayBuffer(PADDLE_REC_TAR_URL, 180000)
            ]);
            report(58, '解包识别模型…');
            const detModel = extractTarEntryBytes(detTar, 'inference.onnx');
            const recModel = extractTarEntryBytes(recTar, 'inference.onnx');
            const recYml = new TextDecoder().decode(extractTarEntryBytes(recTar, 'inference.yml'));
            const charactersDictionary = parsePaddleCharacterDictionary(recYml);
            report(68, '初始化 PaddleOCR…');
            const service = await Paddle.PaddleOcrService.createInstance({
                ort: ortRef,
                detection: { modelBuffer: bytesToArrayBuffer(detModel) },
                recognition: {
                    modelBuffer: bytesToArrayBuffer(recModel),
                    charactersDictionary
                }
            });
            stopPaddleUiProgressPulse();
            return {
                ready: true,
                runOcr: async (imageData) => service.processRecognition(await service.recognize(imageData))
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
                    await worker.setParameters({ tessedit_pageseg_mode: '6' });
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
    if (scriptConfig.spamIdentifyEnabled === false || !isAvatarOcrEnabled()) return;
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
const AVATAR_OCR_IMAGE_SCALE = 1.5;
const AVATAR_OCR_IMAGE_MIN_SIZE = 384;
const AVATAR_OCR_IMAGE_MAX_SIZE = 576;
const PADDLE_OCR_IMAGE_MAX_SIZE = 400;
const PADDLE_OCR_IMAGE_MIN_SIZE = 192;
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
function processedAvatarCanvas(source, width, height, {
    channel = 'gray',
    invert = false,
    threshold = false,
    thresholdValue = null,
    normalize = true,
    blackText = false
} = {}) {
    const values = new Uint8ClampedArray(width * height);
    let min = 255;
    let max = 0;
    for (let i = 0; i < values.length; i += 1) {
        const j = i * 4;
        const r = source.data[j];
        const g = source.data[j + 1];
        const b = source.data[j + 2];
        let value;
        if (channel === 'min') value = Math.min(r, g, b);
        else if (channel === 'redGreen') value = Math.min(r, g);
        else value = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        if (invert) value = 255 - value;
        values[i] = value;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (normalize && max > min) {
        for (let i = 0; i < values.length; i += 1) {
            values[i] = Math.max(0, Math.min(255, Math.round((values[i] - min) * 255 / (max - min))));
        }
    }
    const resolvedThreshold = Number.isFinite(thresholdValue) ? thresholdValue : (threshold ? otsuThreshold(values) : null);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    const output = ctx.createImageData(width, height);
    for (let i = 0; i < values.length; i += 1) {
        let value = values[i];
        if (resolvedThreshold != null) {
            const high = value >= resolvedThreshold;
            value = blackText ? (high ? 0 : 255) : (high ? 255 : 0);
        }
        const j = i * 4;
        output.data[j] = value;
        output.data[j + 1] = value;
        output.data[j + 2] = value;
        output.data[j + 3] = 255;
    }
    ctx.putImageData(output, 0, 0);
    return canvas;
}
async function createAvatarOcrImageBlobsFromImageSource(imageSource) {
    const sourceWidth = imageSource.naturalWidth || imageSource.videoWidth || imageSource.width || 0;
    const sourceHeight = imageSource.naturalHeight || imageSource.videoHeight || imageSource.height || 0;
    const sourceSize = Math.max(sourceWidth, sourceHeight);
    const size = Math.min(AVATAR_OCR_IMAGE_MAX_SIZE, Math.max(AVATAR_OCR_IMAGE_MIN_SIZE, Math.round(sourceSize * AVATAR_OCR_IMAGE_SCALE)));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        if (typeof imageSource.close === 'function') imageSource.close();
        throw new Error('canvas unavailable');
    }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(imageSource, 0, 0, size, size);
    if (typeof imageSource.close === 'function') imageSource.close();
    const source = ctx.getImageData(0, 0, size, size);
    return [
        await canvasToBlob(canvas, 'image/jpeg', 0.95),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'gray' })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'gray', invert: true, threshold: true })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'min' })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'min', normalize: false, thresholdValue: 200, blackText: true })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'redGreen', thresholdValue: 200, blackText: true }))
    ];
}
async function createAvatarPaddleOcrImageBlobsFromImageSource(imageSource) {
    const sourceWidth = imageSource.naturalWidth || imageSource.videoWidth || imageSource.width || 0;
    const sourceHeight = imageSource.naturalHeight || imageSource.videoHeight || imageSource.height || 0;
    const sourceSize = Math.max(sourceWidth, sourceHeight);
    const size = Math.min(PADDLE_OCR_IMAGE_MAX_SIZE, Math.max(PADDLE_OCR_IMAGE_MIN_SIZE, sourceSize || PADDLE_OCR_IMAGE_MIN_SIZE));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        if (typeof imageSource.close === 'function') imageSource.close();
        throw new Error('canvas unavailable');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(imageSource, 0, 0, size, size);
    if (typeof imageSource.close === 'function') imageSource.close();
    const source = ctx.getImageData(0, 0, size, size);
    return [
        await canvasToBlob(canvas, 'image/jpeg', 0.92),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'gray' })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'min', normalize: false, thresholdValue: 200, blackText: true })),
        await canvasToBlob(processedAvatarCanvas(source, size, size, { channel: 'redGreen', thresholdValue: 200, blackText: true }))
    ];
}
async function createAvatarOcrImageBlobsFromUrl(imageUrl) {
    let lastError = null;
    for (const url of avatarImageFetchCandidates(imageUrl)) {
        try {
            const img = await loadAvatarImageElementForOcr(url);
            return createAvatarOcrImageBlobsFromImageSource(img);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('avatar image direct decode failed');
}
async function createAvatarPaddleOcrImageBlobsFromUrl(imageUrl) {
    let lastError = null;
    for (const url of avatarImageFetchCandidates(imageUrl)) {
        try {
            const img = await loadAvatarImageElementForOcr(url);
            return createAvatarPaddleOcrImageBlobsFromImageSource(img);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('avatar image direct decode failed');
}
async function createAvatarOcrImageBlobs(arrayBuffer, imageUrl = '') {
    const blob = new Blob([arrayBuffer], { type: detectAvatarImageMimeType(arrayBuffer) });
    try {
        const bitmap = await decodeImageBitmapFromBlob(blob);
        return await createAvatarOcrImageBlobsFromImageSource(bitmap);
    } catch {
        if (imageUrl) return createAvatarOcrImageBlobsFromUrl(imageUrl);
        return [blob];
    }
}
async function createAvatarPaddleOcrImageBlobs(arrayBuffer, imageUrl = '') {
    const blob = new Blob([arrayBuffer], { type: detectAvatarImageMimeType(arrayBuffer) });
    try {
        const bitmap = await decodeImageBitmapFromBlob(blob);
        return await createAvatarPaddleOcrImageBlobsFromImageSource(bitmap);
    } catch {
        if (imageUrl) return createAvatarPaddleOcrImageBlobsFromUrl(imageUrl);
        return [blob];
    }
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
async function recognizeAvatarWithTesseract(arrayBuffer, patterns = [], imageUrl = '') {
    const blobs = await createAvatarOcrImageBlobs(arrayBuffer, imageUrl);
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
async function recognizeAvatarWithPaddleBrowser(arrayBuffer, patterns = [], imageUrl = '') {
    const texts = [];
    let lastError = null;
    const blobs = await createAvatarPaddleOcrImageBlobs(arrayBuffer, imageUrl);
    const paddle = await ensurePaddleUserscriptReady();
    for (const blob of blobs) {
        try {
            const imageData = await blobToImageData(blob);
            const result = await withAvatarOcrStepTimeout(paddle.runOcr(imageData), PADDLE_OCR_VARIANT_TIMEOUT_MS, 'paddle OCR variant timeout');
            const text = textFromPaddleBrowserResult(result);
            if (text && !texts.includes(text)) texts.push(text);
            const combined = texts.join('\n');
            if (matchesAvatarOcrKeywords(combined, patterns).match) return combined;
        } catch (error) {
            lastError = error;
            if (isPaddleOcrVariantTimeout(error)) break;
        }
    }
    const paddleText = texts.join('\n');
    if (!paddleText && lastError) throw lastError;
    return paddleText;
}
async function recognizeAvatarTextWithOcr(arrayBuffer, patterns = [], imageUrl = '') {
    if (getAvatarOcrEngine() === AVATAR_OCR_ENGINE_PADDLE) return recognizeAvatarWithPaddleBrowser(arrayBuffer, patterns, imageUrl);
    return recognizeAvatarWithTesseract(arrayBuffer, patterns, imageUrl);
}
async function analyzeAvatarImageBuffer(arrayBuffer, patterns, imageUrl = '') {
    if (isAvatarOcrEngineFailed()) {
        return { match: false, hit: '', source: 'none', ocrOk: false, ocrText: '' };
    }
    try {
        const ocrText = await recognizeAvatarTextWithOcr(arrayBuffer, patterns, imageUrl);
        const signature = detectPromoAvatarSignature(ocrText, patterns);
        return { ...signature, ocrOk: true, ocrText };
    } catch (error) {
        noteAvatarOcrError(error);
        return { match: false, hit: '', source: 'none', ocrOk: false, ocrText: '' };
    }
}
function getAvatarOcrCacheKey(imageUrl, patterns = [], engine = getAvatarOcrEngine()) {
    const patternKey = [...new Set((patterns || []).map(String).filter(Boolean))].sort().join('\u001f');
    return `${normalizeAvatarOcrEngine(engine)}\u001e${patternKey}\u001e${String(imageUrl || '')}`;
}
function isReusableAvatarOcrCacheEntry(entry, now = Date.now(), cacheMs = AVATAR_OCR_CACHE_MS) {
    return !!(entry?.result?.ocrOk && Number(entry.at) > 0 && now - Number(entry.at) < cacheMs);
}
function rememberAvatarOcrResult(cacheKey, result, now = Date.now()) {
    if (!cacheKey || !result?.ocrOk) return;
    avatarOcrCache.set(cacheKey, { result, at: now });
    while (avatarOcrCache.size > AVATAR_OCR_CACHE_LIMIT) {
        avatarOcrCache.delete(avatarOcrCache.keys().next().value);
    }
}
async function analyzeAvatarImageUrl(imageUrl, patterns) {
    const cacheKey = getAvatarOcrCacheKey(imageUrl, patterns);
    const cached = avatarOcrCache.get(cacheKey);
    if (isReusableAvatarOcrCacheEntry(cached)) return cached.result;
    if (avatarOcrPendingByKey.has(cacheKey)) return avatarOcrPendingByKey.get(cacheKey);
    const pending = (async () => {
        const buffer = await fetchAvatarImageArrayBuffer(imageUrl);
        const result = await analyzeAvatarImageBuffer(buffer, patterns, imageUrl);
        rememberAvatarOcrResult(cacheKey, result);
        return result;
    })().finally(() => avatarOcrPendingByKey.delete(cacheKey));
    avatarOcrPendingByKey.set(cacheKey, pending);
    return pending;
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
    if (kind === 'auto') {
        const summary = detection.summary || '自动规则命中';
        const badgeText = detection.badgeText || `自动标记 · ${summary}`;
        const title = detection.title || summary;
        if (badge.textContent) {
            const existingTitle = badge.title || '';
            if (title && !existingTitle.includes(title)) badge.title = `${existingTitle}\n${title}`.trim();
            if (!badge.textContent.includes(badgeText)) badge.textContent = `${badge.textContent}；${badgeText}`;
        } else {
            badge.title = title;
            badge.textContent = badgeText;
        }
    } else if (kind === 'avatar') {
        const avatarPart = `头像·${detection.summary}`;
        if (badge.textContent && badge.textContent.includes('疑似引流')) {
            badge.title = `${badge.title || ''}\n头像 OCR: ${detection.summary}`;
            badge.textContent = `${badge.textContent}；${avatarPart}`;
        } else {
            badge.title = `头像 OCR 命中: ${detection.summary}`;
            badge.textContent = `头像疑似引流 · ${detection.summary}`;
        }
    } else if (kind === 'bio') {
        const bioPart = `简介·${detection.summary}`;
        if (badge.textContent && badge.textContent.includes('疑似引流')) {
            badge.title = `${badge.title || ''}\n个人简介: ${detection.summary}`;
            badge.textContent = `${badge.textContent}；${bioPart}`;
        } else {
            badge.title = `个人简介命中: ${detection.summary}`;
            badge.textContent = `简介疑似引流 · ${detection.summary}`;
        }
    } else {
        badge.title = `${detection.summary}\n得分: ${detection.score}`;
        badge.textContent = `疑似引流 · ${detection.score}分`;
    }
    window.setTimeout(updateManualDetectedNukeButton, 0);
}
function isAutoNukeEnabled() {
    return scriptConfig.autoBlockEnabled === true;
}
function markArticleForAutoRule(article, summary, title = summary) {
    if (!article) return;
    ensureSpamBadge(article, {
        summary,
        title,
        badgeText: `自动标记 · ${summary}`
    }, 'auto');
}
function triggerAutoNukeForMarkedArticle(article, trigger) {
    if (!article || !isAutoNukeEnabled() || article.dataset.autoblockTriggered === 'true') return false;
    article.dataset.autoblockTriggered = 'true';
    article.dataset.autoblockChecked = 'complete';
    void initiateNukeProcess(article, trigger);
    return true;
}
function isDetectedNukeTargetArticle(article) {
    return !!(
        article?.isConnected &&
        !isStatusRootTweetArticle(article) &&
        article.querySelector('.nuke-spam-badge') &&
        article.dataset.autoblockTriggered !== 'true' &&
        article.style.display !== 'none'
    );
}
function getDetectedNukeTargetArticles() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"]')).filter(isDetectedNukeTargetArticle);
}
function parseCompactEngagementCount(text) {
    const normalized = String(text || '').replace(/,/g, '').trim();
    if (!normalized) return 0;
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*([万千kKmM]?)/);
    if (!match) return 0;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return 0;
    const unit = match[2] || '';
    if (unit === '万') return Math.round(value * 10000);
    if (unit === '千') return Math.round(value * 1000);
    if (unit.toLowerCase() === 'k') return Math.round(value * 1000);
    if (unit.toLowerCase() === 'm') return Math.round(value * 1000000);
    return Math.round(value);
}
function getEngagementCountFromAction(article, testIds) {
    if (!article) return null;
    const selector = testIds.map(testId => `[data-testid="${testId}"]`).join(',');
    const action = article.querySelector(selector);
    if (!action) return null;
    const label = action.getAttribute('aria-label') || action.querySelector('[aria-label]')?.getAttribute('aria-label') || '';
    const text = action.textContent || '';
    return parseCompactEngagementCount(`${label} ${text}`);
}
function getArticleEngagementCounts(article) {
    return {
        replies: getEngagementCountFromAction(article, ['reply']),
        retweets: getEngagementCountFromAction(article, ['retweet', 'unretweet']),
        likes: getEngagementCountFromAction(article, ['like', 'unlike'])
    };
}
function shouldCollectChainSourceFromCounts(counts, chainSource) {
    const keyBySource = { reply: 'replies', retweet: 'retweets', like: 'likes' };
    const key = keyBySource[chainSource];
    if (!key) return true;
    return counts?.[key] !== 0;
}
function isZeroEngagementNukeTarget(resolvedTarget) {
    const counts = resolvedTarget?.engagementCounts;
    return !!counts && counts.replies === 0 && counts.retweets === 0 && counts.likes === 0;
}
function sortManualDetectedCapturesForAuthorResolution(captures) {
    return (captures || [])
        .filter((capture) => capture?.status !== 'chain_only')
        .map((capture, index) => ({ capture, index }))
        .sort((left, right) => {
            const zeroPriority = Number(isZeroEngagementNukeTarget(right.capture)) - Number(isZeroEngagementNukeTarget(left.capture));
            return zeroPriority || left.index - right.index;
        })
        .map((item) => item.capture);
}
function buildManualDetectedNukeTrigger(article) {
    const badge = article?.querySelector?.('.nuke-spam-badge');
    const badgeText = badge?.textContent?.trim() || '';
    const badgeTitle = badge?.title?.trim() || '';
    const combined = `${badgeText}\n${badgeTitle}`.trim();
    if (/头像|OCR|全国安排/.test(combined)) {
        const hit = (badgeTitle.match(/头像 OCR[:：]\s*([^\n]+)/)?.[1] || badgeText.replace(/^头像疑似引流\s*·\s*/, '') || '头像 OCR').trim();
        return { triggerMode: 'auto', autoReason: 'avatar_ocr', avatarOcrHit: hit };
    }
    if (/疑似引流/.test(combined)) {
        const score = Number(badgeText.match(/(\d+)\s*分/)?.[1]);
        const summary = badgeTitle.split('\n')[0] || badgeText;
        return { triggerMode: 'auto', autoReason: 'spam_identify', spamSummary: summary, spamScore: Number.isFinite(score) ? score : undefined };
    }
    return { triggerMode: 'auto', autoReason: 'manual_detected_target', spamSummary: combined || '已检测目标' };
}
function updateManualDetectedNukeButton() {
    const button = document.getElementById('nuke-manual-detected-nuke-button');
    if (!button) return;
    const count = getDetectedNukeTargetArticles().length;
    const countEl = button.querySelector('.nuke-manual-detected-count');
    button.disabled = shouldDisableManualDetectedNukeButton(manualDetectedNukeRunning, count);
    button.title = count ? `九族拉黑 ${count} 个已检测目标` : '暂无已检测目标';
    button.setAttribute('aria-label', button.title);
    if (countEl) {
        countEl.textContent = count > 99 ? '99+' : String(count);
        countEl.hidden = count === 0;
    }
}
function getUnifiedToastPanelToggleLabel(collapsed) {
    return collapsed ? '展开队列面板' : '收起队列面板';
}
function updateUnifiedToastPanelToggleButton() {
    const button = document.getElementById('nuke-toast-panel-toggle-button');
    if (!button) return;
    const label = getUnifiedToastPanelToggleLabel(unifiedToastPanelCollapsed);
    const path = unifiedToastPanelCollapsed
        ? 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z'
        : 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!unifiedToastPanelCollapsed));
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="currentColor"></path></svg>`;
}
function setUnifiedToastPanelCollapsed(collapsed) {
    unifiedToastPanelCollapsed = Boolean(collapsed);
    document.getElementById('nuke-toast-panel')?.classList.toggle('nuke-toast-panel-collapsed', unifiedToastPanelCollapsed);
    updateUnifiedToastPanelToggleButton();
}
function ensureUnifiedToastPanelToggleButton() {
    const manualButton = document.getElementById('nuke-manual-detected-nuke-button');
    const panel = document.getElementById('nuke-toast-panel');
    let button = document.getElementById('nuke-toast-panel-toggle-button');
    if (!document.body || (!manualButton && !panel)) {
        button?.remove();
        return;
    }
    if (!button) {
        button = document.createElement('button');
        button.id = 'nuke-toast-panel-toggle-button';
        button.type = 'button';
        button.setAttribute('aria-controls', 'nuke-toast-panel');
        button.addEventListener('click', () => setUnifiedToastPanelCollapsed(!unifiedToastPanelCollapsed));
        document.body.appendChild(button);
    }
    button.classList.toggle('nuke-toast-panel-toggle-with-manual', Boolean(manualButton));
    updateUnifiedToastPanelToggleButton();
    if (panel) syncUnifiedToastPanelPlacement(panel);
}
function ensureManualDetectedNukeButton() {
    const existing = document.getElementById('nuke-manual-detected-nuke-button');
    if (isAutoNukeEnabled() || !shouldRunArticleDetectionScans()) {
        existing?.remove();
        ensureUnifiedToastPanelToggleButton();
        return;
    }
    if (!document.body || existing) {
        updateManualDetectedNukeButton();
        ensureUnifiedToastPanelToggleButton();
        return;
    }
    const button = document.createElement('button');
    button.id = 'nuke-manual-detected-nuke-button';
    button.type = 'button';
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><g><path d="${NUKE_ICON_PATH}" fill="currentColor"></path></g></svg><span class="nuke-manual-detected-count" hidden>0</span>`;
    button.addEventListener('click', () => {
        void executeManualNukeForDetectedTargets();
    });
    document.body.appendChild(button);
    updateManualDetectedNukeButton();
    ensureUnifiedToastPanelToggleButton();
}
function captureManualDetectedNukeTargets(articles, userData, options = {}) {
    const capturedTargets = [];
    for (const article of articles) {
        if (!isDetectedNukeTargetArticle(article)) continue;
        article.dataset.autoblockTriggered = 'true';
        article.dataset.autoblockChecked = 'complete';
        const trigger = buildManualDetectedNukeTrigger(article);
        const capture = captureNukeTargetForImmediateHide(article, trigger, userData, options);
        capturedTargets.push({
            article,
            trigger,
            capture: {
                ...capture,
                trigger,
                engagementCounts: getArticleEngagementCounts(article),
                chainExemptHandles: getChainExemptHandlesForTarget(article)
            }
        });
    }
    return capturedTargets;
}
function getManualDetectedViewportAnchorDistance(rect, viewportHeight) {
    if (rect.bottom <= 0) return viewportHeight + Math.abs(rect.bottom);
    if (rect.top >= viewportHeight) return rect.top;
    return Math.abs(rect.top);
}
function selectManualDetectedViewportAnchor(articles, hiddenHandles, viewportHeight, getHandle = getArticleAuthorHandle) {
    return Array.from(articles || [])
        .filter((article) => article?.isConnected !== false && !hiddenHandles.has(normalizePromoHandle(getHandle(article))))
        .map((article) => ({ article, rect: article.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0)
        .sort((left, right) => getManualDetectedViewportAnchorDistance(left.rect, viewportHeight) - getManualDetectedViewportAnchorDistance(right.rect, viewportHeight))[0]?.article || null;
}
function captureManualDetectedViewportState(hiddenHandles) {
    const anchor = selectManualDetectedViewportAnchor(document.querySelectorAll('article[data-testid="tweet"]'), hiddenHandles, window.innerHeight);
    const scrollElement = document.scrollingElement || document.documentElement;
    return { anchor, anchorTop: anchor?.getBoundingClientRect().top ?? null, scrollTop: scrollElement.scrollTop };
}
function restoreManualDetectedViewportState(state) {
    if (!state) return;
    const restore = () => {
        const scrollElement = document.scrollingElement || document.documentElement;
        if (state.anchor?.isConnected && Number.isFinite(state.anchorTop)) {
            const delta = state.anchor.getBoundingClientRect().top - state.anchorTop;
            if (Number.isFinite(delta)) scrollElement.scrollTop += delta;
        } else {
            scrollElement.scrollTop = state.scrollTop;
        }
    };
    restore();
    window.requestAnimationFrame(restore);
}
function shouldDisableManualDetectedNukeButton(isCaptureRunning, count) {
    return !!isCaptureRunning || count === 0;
}
function getManualDetectedNukeTaskTweetIds(task) {
    const ids = Array.isArray(task?.targetTweetIds) ? task.targetTweetIds : [];
    const captureIds = (task?.captures || []).map((capture) => capture?.tweetContext?.tweetId).filter(Boolean);
    return [...new Set([...ids, ...captureIds].map(String).filter(Boolean))];
}
function sumManualDetectedExpectedBlockCount(captures) {
    return (captures || []).reduce((sum, capture) => {
        const counts = capture?.engagementCounts || capture?.capture?.engagementCounts || {};
        const replies = Number(counts.replies);
        const retweets = Number(counts.retweets);
        return sum + (Number.isFinite(replies) ? replies : 0) + (Number.isFinite(retweets) ? retweets : 0);
    }, 0);
}
function isManualDetectedCaptureAuthorPending(capture) {
    return !['resolved', 'chain_only'].includes(String(capture?.status || 'pending'));
}
function getManualDetectedPendingAuthorCaptures(task) {
    return (task?.captures || []).filter(isManualDetectedCaptureAuthorPending);
}
function getManualDetectedNukeTaskPipelineStats(task) {
    const tasks = Array.isArray(task?.tasks) ? task.tasks : [task];
    let pendingTargetCount = 0;
    let pendingExpectedBlockCount = 0;
    for (const item of tasks) {
        if (!item) continue;
        const captures = item.captures || [];
        if (!captures.length) {
            if (!['queued', 'complete'].includes(item.status)) {
                pendingTargetCount += Number(item.hiddenTargets) || 0;
                pendingExpectedBlockCount += Number(item.expectedBlockCount) || 0;
            }
            continue;
        }
        pendingTargetCount += getManualDetectedPendingAuthorCaptures(item).length;
        const collectedTweetIds = new Set((item.collectedTweetIds || []).map(String));
        pendingExpectedBlockCount += sumManualDetectedExpectedBlockCount(captures.filter((capture) => {
            const tweetId = capture?.tweetContext?.tweetId;
            return tweetId && !collectedTweetIds.has(String(tweetId));
        }));
    }
    return { pendingTargetCount, pendingExpectedBlockCount };
}
function createManualDetectedNukeTask(capturedTargets, now = Date.now()) {
    const captures = (capturedTargets || []).map((job, index) => {
        const source = job.capture || {};
        const savedCapture = source.capture || {};
        const tweetContext = { ...(source.tweetContext || savedCapture.tweetContext || {}) };
        const authorHandle = normalizePromoHandle(source.authorHandle || savedCapture.authorHandle || tweetContext.authorHandle);
        return {
            captureId: savedCapture.captureId || source.captureId || `${tweetContext.tweetId || authorHandle || 'target'}:${now}:${index}`,
            authorHandle,
            authorUserNameText: source.authorUserNameText || savedCapture.authorUserNameText || authorHandle,
            authorId: source.authorId || null,
            rootAuthorId: source.rootAuthorId || tweetContext.rootAuthorId || null,
            trigger: source.trigger || savedCapture.trigger || job.trigger || {},
            tweetContext,
            pageUrl: savedCapture.pageUrl || source.pageUrl || (typeof location !== 'undefined' ? location.href : ''),
            engagementCounts: source.engagementCounts || {},
            chainExemptHandles: (source.chainExemptHandles || []).map(normalizePromoHandle).filter(Boolean),
            isProtectedRoot: !!source.isProtectedRoot,
            status: 'pending'
        };
    }).filter((capture) => capture.authorHandle || capture.tweetContext?.tweetId);
    const targetTweetIds = getManualDetectedNukeTaskTweetIds({ captures });
    const taskId = `manual-detected:${now}:${targetTweetIds.join(',') || captures.length}`;
    captures.forEach((capture) => {
        capture.nukeTaskIds = [taskId];
        capture.tweetContext = { ...(capture.tweetContext || {}), nukeTaskIds: [taskId] };
    });
    return {
        taskId,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        pageUrl: captures[0]?.pageUrl || (typeof location !== 'undefined' ? location.href : ''),
        hiddenTargets: captures.length,
        expectedBlockCount: sumManualDetectedExpectedBlockCount(captures),
        apiCollectedCount: 0,
        queuedAuthorCount: 0,
        queuedChainUserCount: 0,
        queuedUserIds: [],
        blockedUserIds: [],
        failedUserIds: [],
        skippedUserIds: [],
        discardedUserIds: [],
        targetTweetIds,
        captures
    };
}
function upsertManualDetectedNukeTask(userData, task) {
    if (!userData || !task?.taskId) return null;
    const existing = Array.isArray(userData.manualDetectedNukeTasks) ? userData.manualDetectedNukeTasks : [];
    const limit = typeof MANUAL_DETECTED_NUKE_TASK_LIMIT === 'number' ? MANUAL_DETECTED_NUKE_TASK_LIMIT : 20;
    userData.manualDetectedNukeTasks = [task, ...existing.filter((item) => item?.taskId !== task.taskId)].slice(0, limit);
    return task;
}
function recordManualDetectedNukeQueueOutcome(userData, entry, outcome) {
    const userId = entry?.userId ? String(entry.userId) : '';
    const taskIds = new Set(getEntryNukeTaskIds(entry));
    if (!userId || !taskIds.size) return 0;
    let updated = 0;
    for (const task of userData?.manualDetectedNukeTasks || []) {
        if (!taskIds.has(String(task?.taskId || ''))) continue;
        const removeOutcome = (field) => {
            task[field] = normalizeNukeTaskIds(task[field]).filter((id) => id !== userId);
        };
        if (outcome !== 'discarded') task.queuedUserIds = mergeNukeTaskIds(task.queuedUserIds, userId);
        if (outcome === 'queued') {
            removeOutcome('failedUserIds');
            removeOutcome('skippedUserIds');
        }
        if (outcome === 'blocked') task.blockedUserIds = mergeNukeTaskIds(task.blockedUserIds, userId);
        if (outcome === 'blocked') {
            removeOutcome('failedUserIds');
            removeOutcome('skippedUserIds');
        }
        if (outcome === 'failed') {
            removeOutcome('skippedUserIds');
            task.failedUserIds = mergeNukeTaskIds(task.failedUserIds, userId);
        }
        if (outcome === 'skipped') {
            removeOutcome('failedUserIds');
            task.skippedUserIds = mergeNukeTaskIds(task.skippedUserIds, userId);
        }
        if (outcome === 'discarded') {
            removeOutcome('queuedUserIds');
            removeOutcome('failedUserIds');
            removeOutcome('skippedUserIds');
            task.discardedUserIds = mergeNukeTaskIds(task.discardedUserIds, userId);
        }
        task.updatedAt = Date.now();
        updated += 1;
    }
    return updated;
}
function discardTerminalManualDetectedNukeFailures(userData) {
    if (!userData || !Array.isArray(userData.manualDetectedNukeTasks)) return 0;
    const queuedIds = new Set((userData.queue || []).map((entry) => String(entry?.userId || '')).filter(Boolean));
    const blockedIds = new Set((userData.blockedLog || []).map((entry) => String(entry?.userId || '')).filter(Boolean));
    let discarded = 0;
    for (const task of userData.manualDetectedNukeTasks) {
        const terminalIds = new Set(normalizeNukeTaskIds(task?.failedUserIds).filter((userId) => !queuedIds.has(userId) && !blockedIds.has(userId)));
        if (!terminalIds.size) continue;
        task.failedUserIds = normalizeNukeTaskIds(task.failedUserIds).filter((userId) => !terminalIds.has(userId));
        task.queuedUserIds = normalizeNukeTaskIds(task.queuedUserIds).filter((userId) => !terminalIds.has(userId));
        task.discardedUserIds = mergeNukeTaskIds(task.discardedUserIds, Array.from(terminalIds));
        task.updatedAt = Date.now();
        discarded += terminalIds.size;
    }
    return discarded;
}
function getActiveManualDetectedNukeTasks(userData) {
    return (userData?.manualDetectedNukeTasks || [])
        .filter((task) => task && !['complete', 'failed'].includes(task.status));
}
function shouldRetryQueuedManualDetectedNukeTask(task, now = Date.now()) {
    if (!task || task.status !== 'running') return false;
    if (task.status === 'running' && typeof manualDetectedNukeTaskRunning !== 'undefined' && manualDetectedNukeTaskRunning) return false;
    const updatedAt = Number(task.updatedAt || task.createdAt) || 0;
    return !updatedAt || now - updatedAt >= MANUAL_DETECTED_NUKE_STALE_RUNNING_MS;
}
function normalizeManualDetectedNukeTasks(userData) {
    if (!userData || !Array.isArray(userData.manualDetectedNukeTasks)) return 0;
    const retainedTasks = userData.manualDetectedNukeTasks.filter((task) => task?.status !== 'complete');
    let changed = userData.manualDetectedNukeTasks.length - retainedTasks.length;
    userData.manualDetectedNukeTasks = retainedTasks;
    for (const task of userData.manualDetectedNukeTasks) {
        if (task?.status === 'paused' && !task.pauseReason) {
            task.status = 'pending';
            task.retryAfter = 0;
            task.updatedAt = Date.now();
            changed += 1;
            continue;
        }
        if (!shouldRetryQueuedManualDetectedNukeTask(task)) continue;
        task.status = 'pending';
        task.retryAfter = 0;
        task.updatedAt = Date.now();
        changed += 1;
    }
    return changed;
}
function getNextRunnableManualDetectedNukeTask(userData, preferredTaskId = '') {
    const now = Date.now();
    const runnable = getActiveManualDetectedNukeTasks(userData)
        .filter((task) => {
            if (!['pending', 'running', 'paused'].includes(task.status)) return false;
            const retryAfter = Number(task.retryAfter) || 0;
            return !retryAfter || retryAfter <= now;
        });
    const preferred = preferredTaskId ? runnable.find((task) => task.taskId === preferredTaskId) : null;
    if (preferred) return preferred;
    return runnable
        .sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0))[0] || null;
}
function getManualDetectedNukeRetryDelay(userData) {
    const retryTimes = getActiveManualDetectedNukeTasks(userData)
        .map((task) => Number(task.retryAfter) || 0)
        .filter((retryAfter) => retryAfter > Date.now());
    if (!retryTimes.length) return null;
    return Math.max(500, Math.min(...retryTimes) - Date.now());
}
function pauseManualDetectedNukeTaskForApiLimit(task, apiRateLimitState, now = Date.now()) {
    const retryAt = Number(apiRateLimitState?.retryAt || 0);
    if (!task || !Number.isFinite(retryAt) || retryAt <= now) return false;
    task.status = 'paused';
    task.retryAfter = retryAt;
    task.pauseReason = 'api';
    task.updatedAt = now;
    return true;
}
function getManualDetectedNukeTaskStats(task, userData) {
    userData = userData || {};
    const tweetIds = new Set(getManualDetectedNukeTaskTweetIds(task));
    const taskIds = new Set((task?.tasks || [task]).map((item) => String(item?.taskId || '')).filter(Boolean));
    const matchesTask = (entry) => {
        const entryTaskIds = getEntryNukeTaskIds(entry);
        if (entryTaskIds.length && taskIds.size) return entryTaskIds.some((taskId) => taskIds.has(taskId));
        return tweetIds.size > 0 && tweetIds.has(String(entry?.sourceTweetId || ''));
    };
    const getEntryUserIds = (entries) => new Set((entries || []).filter(matchesTask).map((entry) => String(entry?.userId || '')).filter(Boolean));
    const queuedIds = getEntryUserIds(userData.queue);
    const blockedIds = new Set(mergeNukeTaskIds(task?.blockedUserIds));
    getEntryUserIds(userData.blockedLog).forEach((userId) => blockedIds.add(userId));
    const skippedIds = new Set(mergeNukeTaskIds(task?.skippedUserIds));
    const failedIds = new Set(mergeNukeTaskIds(task?.failedUserIds));
    const workflowIds = new Set(mergeNukeTaskIds(task?.queuedUserIds, Array.from(queuedIds), Array.from(blockedIds), Array.from(failedIds), Array.from(skippedIds)));
    blockedIds.forEach((userId) => queuedIds.delete(userId));
    blockedIds.forEach((userId) => skippedIds.delete(userId));
    queuedIds.forEach((userId) => skippedIds.delete(userId));
    blockedIds.forEach((userId) => failedIds.delete(userId));
    queuedIds.forEach((userId) => failedIds.delete(userId));
    skippedIds.forEach((userId) => failedIds.delete(userId));
    const hiddenTargets = Number(task?.hiddenTargets);
    const expectedBlockCount = Number(task?.expectedBlockCount);
    const apiCollectedCount = Number(task?.apiCollectedCount);
    const pipelineStats = getManualDetectedNukeTaskPipelineStats(task);
    return {
        hiddenTargets: Number.isFinite(hiddenTargets) ? hiddenTargets : (task?.captures || []).length,
        expectedBlockCount: Number.isFinite(expectedBlockCount) ? expectedBlockCount : sumManualDetectedExpectedBlockCount(task?.captures || []),
        apiCollectedCount: Number.isFinite(apiCollectedCount) ? apiCollectedCount : normalizeNukeTaskIds(task?.apiUserIds).length,
        workflowCount: workflowIds.size,
        blockedCount: blockedIds.size,
        queuedCount: queuedIds.size,
        failedCount: failedIds.size,
        skippedCount: skippedIds.size,
        ...pipelineStats
    };
}
function getManualDetectedNukeTaskSummary(userData) {
    const tasks = getActiveManualDetectedNukeTasks(userData);
    if (!tasks.length) return null;
    const apiUserIds = new Set();
    let apiCountFallback = 0;
    const targetTweetIds = new Set();
    const queuedUserIds = new Set();
    const blockedUserIds = new Set();
    const failedUserIds = new Set();
    const skippedUserIds = new Set();
    const captures = [];
    let hiddenTargets = 0;
    let expectedBlockCount = 0;
    for (const task of tasks) {
        hiddenTargets += Number(task.hiddenTargets) || 0;
        expectedBlockCount += Number(task.expectedBlockCount) || 0;
        if (Array.isArray(task.apiUserIds) && task.apiUserIds.length) {
            task.apiUserIds.forEach((id) => apiUserIds.add(String(id)));
        } else {
            apiCountFallback += Number(task.apiCollectedCount) || 0;
        }
        getManualDetectedNukeTaskTweetIds(task).forEach((tweetId) => targetTweetIds.add(tweetId));
        normalizeNukeTaskIds(task.queuedUserIds).forEach((userId) => queuedUserIds.add(userId));
        normalizeNukeTaskIds(task.blockedUserIds).forEach((userId) => blockedUserIds.add(userId));
        normalizeNukeTaskIds(task.failedUserIds).forEach((userId) => failedUserIds.add(userId));
        normalizeNukeTaskIds(task.skippedUserIds).forEach((userId) => skippedUserIds.add(userId));
        captures.push(...(task.captures || []));
    }
    const statuses = new Set(tasks.map((task) => task.status));
    const status = statuses.has('running') ? 'running'
        : statuses.has('paused') ? 'paused'
            : statuses.has('pending') ? 'pending'
                : 'queued';
    return {
        taskId: 'manual-detected-summary',
        status,
        hiddenTargets,
        expectedBlockCount,
        apiCollectedCount: apiUserIds.size + apiCountFallback,
        queuedUserIds: Array.from(queuedUserIds),
        blockedUserIds: Array.from(blockedUserIds),
        failedUserIds: Array.from(failedUserIds),
        skippedUserIds: Array.from(skippedUserIds),
        targetTweetIds: Array.from(targetTweetIds),
        captures,
        tasks
    };
}
function formatManualDetectedNukeTaskStatus(task, userData) {
    userData = userData || {};
    const stats = getManualDetectedNukeTaskStats(task, userData);
    const terminal = [
        stats.failedCount ? `失败 ${stats.failedCount}` : '',
        stats.skippedCount ? `跳过 ${stats.skippedCount}` : ''
    ].filter(Boolean).join('，');
    const lines = [
        `待移交目标: ${stats.pendingTargetCount}`,
        `待收集回复/转推: 约 ${stats.pendingExpectedBlockCount}`
    ];
    if (terminal) lines.push(`异常结果: ${terminal}`);
    return lines.map((line) => `<div>${line}</div>`).join('');
}
function getManualDetectedNukeTaskTitle(status) {
    const titleByStatus = {
        pending: '标记用户已隐藏',
        running: '后台建立九族列表',
        paused: '后台列表等待重试',
        queued: '后台拉黑已入队',
        complete: '后台拉黑已完成',
        failed: '后台任务失败'
    };
    return titleByStatus[status] || '后台九族进度';
}
function shouldShowManualDetectedNukeTaskToast(task, userData) {
    if (!task) return false;
    const stats = getManualDetectedNukeTaskStats(task, userData || {});
    return stats.pendingTargetCount > 0 || stats.pendingExpectedBlockCount > 0;
}
function showManualDetectedNukeTaskToast(task, userData, duration = null) {
    if (!shouldShowManualDetectedNukeTaskToast(task, userData)) {
        dismissToast('nuke-manual-detected-toast');
        return;
    }
    showToast('nuke-manual-detected-toast', getManualDetectedNukeTaskTitle(task.status), trustedToastHtml(formatManualDetectedNukeTaskStatus(task, userData)), duration);
}
function showManualDetectedNukeProgressToast(userData, duration = null) {
    const summary = getManualDetectedNukeTaskSummary(userData);
    if (summary) showManualDetectedNukeTaskToast(summary, userData, duration);
    else dismissToast('nuke-manual-detected-toast');
}
function completeFinishedManualDetectedNukeTasks(userData) {
    let completedTask = null;
    const retainedTasks = [];
    for (const task of userData?.manualDetectedNukeTasks || []) {
        if (task?.status === 'complete') continue;
        if (task?.status === 'queued') {
            const stats = getManualDetectedNukeTaskStats(task, userData);
            if (stats.pendingTargetCount === 0 && stats.pendingExpectedBlockCount === 0 && stats.queuedCount === 0) {
                task.status = 'complete';
                task.updatedAt = Date.now();
                completedTask = task;
                continue;
            }
        }
        retainedTasks.push(task);
    }
    if (userData) userData.manualDetectedNukeTasks = retainedTasks;
    return completedTask;
}
async function updateManualDetectedNukeTaskToast(userData = null) {
    const data = userData || await loadUserData();
    if (!data) return;
    showManualDetectedNukeProgressToast(data);
}
function scheduleManualDetectedNukeResume(delay = 1500) {
    if (!backgroundWorkerLeader || manualDetectedNukeResumeTimeoutId) return;
    manualDetectedNukeResumeTimeoutId = window.setTimeout(() => {
        manualDetectedNukeResumeTimeoutId = null;
        void resumeManualDetectedNukeTasks();
    }, Math.max(0, delay));
}
async function resolveManualDetectedNukeCapture(capture) {
    const authorHandle = normalizePromoHandle(capture.authorHandle || capture.tweetContext?.authorHandle);
    if (!authorHandle) throw new Error("无法确定作者 handle");
    let authorId = capture.authorId || null;
    let authorUserNameText = capture.authorUserNameText || authorHandle;
    if (!authorId) {
        const authorData = await getUserDataByScreenName(authorHandle);
        authorId = authorData?.rest_id || null;
        authorUserNameText = authorData?.core?.name || authorData?.legacy?.name || authorUserNameText;
    }
    const tweetContext = { ...(capture.tweetContext || {}) };
    tweetContext.authorHandle = normalizePromoHandle(tweetContext.authorHandle || authorHandle);
    let rootAuthorHandle = normalizePromoHandle(tweetContext.rootAuthorHandle);
    let rootAuthorId = capture.rootAuthorId || tweetContext.rootAuthorId || null;
    if (!rootAuthorId && rootAuthorHandle) {
        if (rootAuthorHandle === authorHandle) {
            rootAuthorId = authorId;
        } else {
            const rootAuthorData = await getUserDataByScreenName(rootAuthorHandle);
            rootAuthorId = rootAuthorData?.rest_id || null;
        }
    }
    tweetContext.rootAuthorHandle = rootAuthorHandle || '';
    tweetContext.rootAuthorId = rootAuthorId || null;
    capture.authorId = authorId || null;
    capture.authorUserNameText = authorUserNameText;
    capture.rootAuthorId = rootAuthorId || null;
    capture.status = 'resolved';
    return {
        targetArticle: null,
        trigger: capture.trigger || {},
        authorHandle,
        authorUserNameText,
        tweetContext,
        authorId,
        rootAuthorHandle,
        rootAuthorId,
        engagementCounts: capture.engagementCounts || {},
        nukeTaskIds: getEntryNukeTaskIds(capture)
    };
}
function createManualDetectedCollectTarget(capture) {
    const nukeTaskIds = getEntryNukeTaskIds(capture);
    const tweetContext = { ...(capture?.tweetContext || {}), nukeTaskIds };
    const authorHandle = normalizePromoHandle(capture?.authorHandle || tweetContext.authorHandle);
    tweetContext.authorHandle = normalizePromoHandle(tweetContext.authorHandle || authorHandle);
    tweetContext.rootAuthorHandle = normalizePromoHandle(tweetContext.rootAuthorHandle);
    return {
        targetArticle: null,
        trigger: capture?.trigger || {},
        authorHandle,
        authorUserNameText: capture?.authorUserNameText || authorHandle,
        tweetContext,
        authorId: capture?.authorId || null,
        rootAuthorHandle: tweetContext.rootAuthorHandle || '',
        rootAuthorId: capture?.rootAuthorId || tweetContext.rootAuthorId || null,
        engagementCounts: capture?.engagementCounts || {},
        nukeTaskIds
    };
}
function getManualDetectedChainCollectTargets(task) {
    const collectedTweetIds = new Set((task?.collectedTweetIds || []).map(String));
    return (task?.captures || [])
        .map((capture, index) => ({
            ...createManualDetectedCollectTarget({ ...capture, nukeTaskIds: mergeNukeTaskIds(capture?.nukeTaskIds, task?.taskId) }),
            manualOrder: index
        }))
        .filter((target) => {
            const tweetId = target.tweetContext?.tweetId;
            return tweetId && !collectedTweetIds.has(String(tweetId));
        });
}
function shouldMarkManualDetectedTweetCollected(target) {
    return !!target?.tweetContext?.tweetId;
}
function shouldContinueManualDetectedAuthorQueue(stoppedByApiFailure) {
    return !stoppedByApiFailure;
}
function getManualDetectedPostCollectStatus(stoppedByApiFailure) {
    return stoppedByApiFailure ? 'paused' : 'queued';
}
async function processManualDetectedNukeBackground(taskId) {
    if (!backgroundWorkerLeader || manualDetectedNukeTaskRunning) return;
    manualDetectedNukeTaskRunning = true;
    try {
        const userData = await loadUserData();
        if (!userData) throw new Error("无法加载用户数据");
        const task = getNextRunnableManualDetectedNukeTask(userData, taskId);
        if (!task) return;
        const whitelistIds = new Set(userData.whitelist.map(u => u.userId));
        const captures = task.captures || [];
        const chainExemptHandles = [...new Set(captures.flatMap((capture) => capture.chainExemptHandles || []).map(normalizePromoHandle).filter(Boolean))];
        let stoppedByApiFailure = false;
        task.status = 'running';
        task.retryAfter = 0;
        delete task.pauseReason;
        task.updatedAt = Date.now();
        showManualDetectedNukeProgressToast(userData);
        await saveUserData(userData);
        const onCollectProgress = () => showManualDetectedNukeProgressToast(userData);
        let queuedChainUsers = 0;
        const apiUserIds = new Set(task.apiUserIds || []);
        const onApiUsersPage = (users) => {
            (users || []).forEach((user) => {
                if (user?.rest_id) apiUserIds.add(String(user.rest_id));
            });
            task.apiUserIds = Array.from(apiUserIds);
            task.apiCollectedCount = task.apiUserIds.length;
            task.updatedAt = Date.now();
            showManualDetectedNukeProgressToast(userData);
        };
        let queuedAuthors = 0;
        const handledAuthorIds = new Set();
        if (shouldContinueManualDetectedAuthorQueue(stoppedByApiFailure)) {
            for (const capture of sortManualDetectedCapturesForAuthorResolution(getManualDetectedPendingAuthorCaptures(task))) {
                try {
                    const resolvedTarget = await resolveManualDetectedNukeCapture(capture);
                    const queuedTarget = { ...resolvedTarget, nukeTaskIds: mergeNukeTaskIds(resolvedTarget.nukeTaskIds, task.taskId) };
                    if (queuedTarget.authorId && !handledAuthorIds.has(queuedTarget.authorId)) {
                        handledAuthorIds.add(queuedTarget.authorId);
                        if (queueResolvedNukeAuthor(queuedTarget, userData, whitelistIds, [])) queuedAuthors += 1;
                    }
                    task.updatedAt = Date.now();
                    showManualDetectedNukeProgressToast(userData);
                    await saveUserData(userData);
                } catch (error) {
                    console.error('[CB] 手动九族建立列表失败:', error);
                    if (isApiRateLimitError(error) || isApiTimeoutError(error)) {
                        showManualDetectedApiStopToast(error);
                        task.status = 'paused';
                        task.retryAfter = error.retryAt || Date.now() + API_RETRY_DELAY_MS;
                        task.pauseReason = 'api';
                        task.updatedAt = Date.now();
                        stoppedByApiFailure = true;
                        break;
                    }
                    capture.status = 'chain_only';
                    task.updatedAt = Date.now();
                    await saveUserData(userData);
                    showManualDetectedNukeProgressToast(userData);
                }
                updateManualDetectedNukeButton();
                await waitForMs(250);
            }
        }
        task.queuedAuthorCount = (Number(task.queuedAuthorCount) || 0) + queuedAuthors;
        task.updatedAt = Date.now();
        await saveUserData(userData);
        await updateStatusToast();
        showManualDetectedNukeProgressToast(userData);
        if (shouldContinueManualDetectedAuthorQueue(stoppedByApiFailure)) {
            for (const collectTarget of getManualDetectedChainCollectTargets(task)) {
                const tweetId = collectTarget.tweetContext?.tweetId;
                try {
                    const queuedUsersForTweet = await collectChainUsersForResolvedTarget(collectTarget, userData, whitelistIds, chainExemptHandles, onCollectProgress, showManualDetectedChainCollectPausedToast, onApiUsersPage);
                    queuedChainUsers += queuedUsersForTweet;
                    if (shouldMarkManualDetectedTweetCollected(collectTarget)) {
                        task.collectedTweetIds = [...new Set([...(task.collectedTweetIds || []), tweetId])];
                    }
                    task.updatedAt = Date.now();
                    await saveUserData(userData);
                    showManualDetectedNukeProgressToast(userData);
                } catch (error) {
                    if (isApiRateLimitError(error) || isApiTimeoutError(error)) {
                        showManualDetectedApiStopToast(error);
                        task.status = 'paused';
                        task.retryAfter = error.retryAt || Date.now() + API_RETRY_DELAY_MS;
                        task.pauseReason = 'api';
                        task.updatedAt = Date.now();
                        stoppedByApiFailure = true;
                        break;
                    }
                    throw error;
                }
                updateManualDetectedNukeButton();
                await waitForMs(250);
            }
        }
        task.queuedChainUserCount = (Number(task.queuedChainUserCount) || 0) + queuedChainUsers;
        task.updatedAt = Date.now();
        await saveUserData(userData);
        showManualDetectedNukeProgressToast(userData);
        if (getManualDetectedPostCollectStatus(stoppedByApiFailure) === 'queued') {
            task.status = 'queued';
            task.retryAfter = 0;
            delete task.pauseReason;
        } else {
            task.status = 'paused';
        }
        task.updatedAt = Date.now();
        await saveUserData(userData);
        await updateStatusToast();
        showManualDetectedNukeProgressToast(userData, stoppedByApiFailure ? 5000 : null);
        setTimeout(processQueue, 1000);
    } catch (error) {
        console.error('[CB] 手动执行九族拉黑失败:', error);
        showToast('nuke-manual-detected-toast', '手动执行失败', error.message, 5000);
    } finally {
        manualDetectedNukeTaskRunning = false;
        updateManualDetectedNukeButton();
        scheduleManualDetectedNukeResume(1500);
        void (async () => {
            const retryData = await loadUserData();
            const retryDelay = getManualDetectedNukeRetryDelay(retryData);
            if (retryDelay) {
                scheduleManualDetectedNukeResume(retryDelay);
            }
        })();
    }
}
async function resumeManualDetectedNukeTasks() {
    if (!backgroundWorkerLeader) return;
    const userData = await loadUserData();
    if (!userData) return;
    const completedTask = completeFinishedManualDetectedNukeTasks(userData);
    if (completedTask) await saveUserData(userData);
    const runnableTask = getNextRunnableManualDetectedNukeTask(userData);
    const activeSummary = getManualDetectedNukeTaskSummary(userData);
    if (!activeSummary) {
        if (completedTask) showManualDetectedNukeTaskToast(completedTask, userData, 4500);
        else dismissToast('nuke-manual-detected-toast');
        return;
    }
    showManualDetectedNukeTaskToast(activeSummary, userData);
    const apiRateLimitState = await getActiveApiRateLimitState();
    if (runnableTask && !apiRateLimitState) {
        void processManualDetectedNukeBackground(runnableTask.taskId);
    } else {
        if (runnableTask && pauseManualDetectedNukeTaskForApiLimit(runnableTask, apiRateLimitState)) {
            await saveUserData(userData);
            showApiLimitRetryToast(buildApiRateLimitError(apiRateLimitState));
            showManualDetectedNukeProgressToast(userData);
        }
        const retryDelay = getManualDetectedNukeRetryDelay(userData);
        if (retryDelay) scheduleManualDetectedNukeResume(retryDelay);
    }
}
async function executeManualNukeForDetectedTargets() {
    if (manualDetectedNukeRunning || isAutoNukeEnabled()) return;
    detectionFullScanPending = true;
    await runDetectionScanBatch();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const articles = getDetectedNukeTargetArticles();
    if (!articles.length) {
        showToast('nuke-manual-detected-toast', '暂无已检测目标', '没有可执行九族拉黑的标记推文', 3000);
        updateManualDetectedNukeButton();
        return;
    }
    manualDetectedNukeRunning = true;
    updateManualDetectedNukeButton();
    showToast('nuke-manual-detected-toast', '建立九族列表', `正在记录并隐藏 ${articles.length} 个已检测目标`, null);
    try {
        const userData = await loadUserData();
        if (!userData) throw new Error("无法加载用户数据");
        const capturedTargets = captureManualDetectedNukeTargets(articles, userData, { deferPageHide: true });
        const hiddenHandles = new Set(capturedTargets
            .filter((item) => !item.capture?.isProtectedRoot)
            .map((item) => normalizePromoHandle(item.capture?.authorHandle))
            .filter(Boolean));
        const viewportState = captureManualDetectedViewportState(hiddenHandles);
        hideArticlesByHandles(hiddenHandles);
        restoreManualDetectedViewportState(viewportState);
        await saveUserData(userData);
        await updateStatusToast();
        updateManualDetectedNukeButton();
        if (!capturedTargets.length) {
            showToast('nuke-manual-detected-toast', '暂无已检测目标', '没有可执行九族拉黑的标记推文', 3000);
            return;
        }
        const task = upsertManualDetectedNukeTask(userData, createManualDetectedNukeTask(capturedTargets));
        await saveUserData(userData);
        showManualDetectedNukeProgressToast(userData);
        void processManualDetectedNukeBackground(task.taskId);
    } catch (error) {
        console.error('[CB] 手动执行九族拉黑失败:', error);
        showToast('nuke-manual-detected-toast', '手动执行失败', error.message, 5000);
    } finally {
        manualDetectedNukeRunning = false;
        updateManualDetectedNukeButton();
    }
}
function finalizeSpamArticleScan(article) {
    if (!article) return;
    clearDeferredProfileBioArticle(article);
    delete article.dataset.profileBioPending;
    delete article.dataset.profileBioQueued;
    delete article.dataset.profileBioQueuedAt;
    delete article.dataset.avatarOcrPending;
    delete article.dataset.avatarOcrQueued;
    delete article.dataset.avatarOcrQueuedAt;
    article.dataset.spamScanned = 'complete';
}
function releaseProfileBioForRetry(article) {
    if (!article) return;
    clearDeferredProfileBioArticle(article);
    removeProfileBioJobsForArticle(article);
    delete article.dataset.profileBioPending;
    delete article.dataset.profileBioQueued;
    delete article.dataset.profileBioQueuedAt;
    delete article.dataset.spamScanned;
}
function removeProfileBioJobsForArticle(article) {
    if (!article) return;
    for (let i = profileBioQueue.length - 1; i >= 0; i -= 1) {
        if (profileBioQueue[i]?.article === article) profileBioQueue.splice(i, 1);
    }
}
function isProfileBioJobActiveForArticle(article) {
    return !!article && profileBioActiveArticle === article;
}
function enqueueProfileBioScan(article, screenName) {
    if (!article || !screenName) return;
    clearDeferredProfileBioArticle(article);
    const visible = isArticleInViewport(article);
    if ((article.dataset.profileBioPending === 'true' || article.dataset.profileBioQueued === 'true') && !visible) return;
    if (isProfileBioJobActiveForArticle(article)) return;
    removeProfileBioJobsForArticle(article);
    article.dataset.profileBioQueued = 'true';
    article.dataset.profileBioPending = 'true';
    article.dataset.profileBioQueuedAt = String(Date.now());
    const job = { article, screenName, priority: visible ? 1000 : 0 };
    if (visible) profileBioQueue.unshift(job);
    else profileBioQueue.push(job);
    void pumpProfileBioQueue();
}
function hasStaleProfileBioPending(article) {
    if (article?.dataset?.profileBioPending !== 'true') return false;
    const queuedAt = parseInt(article.dataset.profileBioQueuedAt, 10) || 0;
    return !queuedAt || Date.now() - queuedAt > PROFILE_BIO_STALE_PENDING_MS;
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
function isArticleNearOcrViewport(article, viewportHeight = (typeof window !== 'undefined' ? window.innerHeight : 0), margin = AVATAR_OCR_VIEWPORT_MARGIN) {
    if (!article?.isConnected || typeof article.getBoundingClientRect !== 'function') return false;
    const rect = article.getBoundingClientRect();
    return rect.bottom > -margin && rect.top < viewportHeight + margin;
}
function clearDeferredProfileBioArticle(article) {
    if (!article) return;
    deferredProfileBioArticles.delete(article);
    deferredProfileBioScreenNames.delete(article);
    delete article.dataset.profileBioDeferred;
    profileBioVisibilityObserver?.unobserve(article);
}
function activateDeferredProfileBioArticle(article) {
    if (!article?.isConnected || document.hidden || !isArticleNearOcrViewport(article)) return false;
    const screenName = getArticleAuthorScreenName(article) || deferredProfileBioScreenNames.get(article);
    clearDeferredProfileBioArticle(article);
    if (!screenName || scriptConfig.spamIdentifyEnabled === false) return false;
    delete article.dataset.spamScanned;
    enqueueProfileBioScan(article, screenName);
    return true;
}
function ensureProfileBioVisibilityObserver() {
    if (profileBioVisibilityObserver || typeof IntersectionObserver !== 'function') return profileBioVisibilityObserver;
    profileBioVisibilityObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) activateDeferredProfileBioArticle(entry.target);
        });
    }, { root: null, rootMargin: `${AVATAR_OCR_VIEWPORT_MARGIN}px 0px` });
    return profileBioVisibilityObserver;
}
function deferProfileBioUntilNearViewport(article, screenName) {
    if (!article?.isConnected || !screenName) return false;
    finalizeSpamArticleScan(article);
    article.dataset.profileBioDeferred = 'true';
    deferredProfileBioArticles.add(article);
    deferredProfileBioScreenNames.set(article, screenName);
    ensureProfileBioVisibilityObserver()?.observe(article);
    return true;
}
function scheduleProfileBioScanForArticle(article, screenName) {
    if (!article?.isConnected || !screenName) return false;
    if (document.hidden || !isArticleNearOcrViewport(article)) {
        return deferProfileBioUntilNearViewport(article, screenName);
    }
    clearDeferredProfileBioArticle(article);
    enqueueProfileBioScan(article, screenName);
    return true;
}
function resumeDeferredProfileBioArticles() {
    for (const article of Array.from(deferredProfileBioArticles)) {
        if (!article?.isConnected) {
            clearDeferredProfileBioArticle(article);
            continue;
        }
        activateDeferredProfileBioArticle(article);
    }
}
function clearDeferredProfileBioArticles() {
    profileBioVisibilityObserver?.disconnect();
    profileBioVisibilityObserver = null;
    deferredProfileBioArticles.forEach((article) => {
        deferredProfileBioScreenNames.delete(article);
        if (article?.dataset) delete article.dataset.profileBioDeferred;
    });
    deferredProfileBioArticles.clear();
}
function clearDeferredAvatarOcrArticle(article) {
    if (!article) return;
    deferredAvatarOcrArticles.delete(article);
    deferredAvatarOcrUrls.delete(article);
    delete article.dataset.avatarOcrDeferred;
    avatarOcrVisibilityObserver?.unobserve(article);
}
function activateDeferredAvatarOcrArticle(article) {
    if (!article?.isConnected || document.hidden || !isArticleNearOcrViewport(article)) return false;
    const imageUrl = getAvatarImageUrlFromArticle(article) || deferredAvatarOcrUrls.get(article);
    clearDeferredAvatarOcrArticle(article);
    if (!imageUrl || !isAvatarOcrEnabled()) return false;
    delete article.dataset.spamScanned;
    enqueueAvatarOcr(article, imageUrl);
    return true;
}
function ensureAvatarOcrVisibilityObserver() {
    if (avatarOcrVisibilityObserver || typeof IntersectionObserver !== 'function') return avatarOcrVisibilityObserver;
    avatarOcrVisibilityObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) activateDeferredAvatarOcrArticle(entry.target);
        });
    }, { root: null, rootMargin: `${AVATAR_OCR_VIEWPORT_MARGIN}px 0px` });
    return avatarOcrVisibilityObserver;
}
function deferAvatarOcrUntilNearViewport(article, imageUrl) {
    if (!article?.isConnected || !imageUrl) return false;
    finalizeSpamArticleScan(article);
    article.dataset.avatarOcrDeferred = 'true';
    deferredAvatarOcrArticles.add(article);
    deferredAvatarOcrUrls.set(article, imageUrl);
    ensureAvatarOcrVisibilityObserver()?.observe(article);
    updateAvatarOcrPumpProbe('deferred-offscreen');
    return true;
}
function scheduleAvatarOcrForArticle(article, imageUrl) {
    if (!article?.isConnected || !imageUrl) return false;
    if (document.hidden || !isArticleNearOcrViewport(article)) {
        return deferAvatarOcrUntilNearViewport(article, imageUrl);
    }
    clearDeferredAvatarOcrArticle(article);
    enqueueAvatarOcr(article, imageUrl);
    return true;
}
function resumeDeferredAvatarOcrArticles() {
    for (const article of Array.from(deferredAvatarOcrArticles)) {
        if (!article?.isConnected) {
            clearDeferredAvatarOcrArticle(article);
            continue;
        }
        activateDeferredAvatarOcrArticle(article);
    }
}
function clearDeferredAvatarOcrArticles() {
    avatarOcrVisibilityObserver?.disconnect();
    avatarOcrVisibilityObserver = null;
    deferredAvatarOcrArticles.forEach((article) => {
        deferredAvatarOcrUrls.delete(article);
        if (article?.dataset) delete article.dataset.avatarOcrDeferred;
    });
    deferredAvatarOcrArticles.clear();
}
function isAvatarOcrJobQueuedForArticle(article) {
    return !!article && avatarOcrQueue.some((job) => job?.article === article);
}
function isAvatarOcrJobActiveForArticle(article) {
    return !!article && avatarOcrActiveArticle === article;
}
function getAvatarOcrJobPriority(article) {
    const tweetText = getTweetTextFromArticle(article);
    let priority = 0;
    if (isDecorativeUnicodeAvatarOcrPriorityText(tweetText)) priority += 8;
    if (article?.querySelector('.nuke-spam-badge:not([data-avatar-ocr-badge])')) priority += 4;
    return priority;
}
function enqueueAvatarOcr(article, imageUrl) {
    clearDeferredAvatarOcrArticle(article);
    const visible = isArticleInViewport(article);
    if ((article.dataset.avatarOcrPending === 'true' || article.dataset.avatarOcrQueued === 'true') && !visible) return;
    if (isAvatarOcrJobActiveForArticle(article)) return;
    removeAvatarOcrJobsForArticle(article);
    article.dataset.avatarOcrQueued = 'true';
    article.dataset.avatarOcrPending = 'true';
    article.dataset.avatarOcrQueuedAt = String(Date.now());
    const job = { article, imageUrl, priority: getAvatarOcrJobPriority(article) };
    if (visible) avatarOcrQueue.unshift(job);
    else avatarOcrQueue.push(job);
    void pumpAvatarOcrQueue();
}
function hasStaleAvatarOcrPending(article) {
    if (article?.dataset?.avatarOcrPending !== 'true') return false;
    const queuedAt = parseInt(article.dataset.avatarOcrQueuedAt, 10) || 0;
    return !queuedAt || Date.now() - queuedAt > AVATAR_OCR_STALE_PENDING_MS;
}
function shouldPromoteVisibleAvatarOcrPending(article) {
    if (article?.dataset?.avatarOcrPending !== 'true') return false;
    if (!isArticleInViewport(article) || isAvatarOcrJobActiveForArticle(article)) return false;
    if (isAvatarOcrJobQueuedForArticle(article)) return true;
    const queuedAt = parseInt(article.dataset.avatarOcrQueuedAt, 10) || 0;
    return !queuedAt || Date.now() - queuedAt > AVATAR_OCR_VISIBLE_REQUEUE_MS;
}
function isArticleInViewport(article) {
    return isArticleNearOcrViewport(article, window.innerHeight, 0);
}
function avatarOcrJobScore(job) {
    if (!job?.article?.isConnected) return -Infinity;
    return (isArticleInViewport(job.article) ? 2000 : isArticleNearOcrViewport(job.article) ? 1000 : 0) + (Number(job.priority) || 0);
}
function takeNextAvatarOcrJob() {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < avatarOcrQueue.length; i += 1) {
        const score = avatarOcrJobScore(avatarOcrQueue[i]);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
        }
    }
    if (bestIndex > 0) return avatarOcrQueue.splice(bestIndex, 1)[0];
    return avatarOcrQueue.shift();
}
function shouldDeferAvatarOcrJob(job) {
    if (document.hidden) return true;
    if (!isArticleNearOcrViewport(job?.article)) return true;
    if (Date.now() - avatarOcrLastUserActivityAt < AVATAR_OCR_USER_IDLE_MS) return true;
    return shouldDeferBackgroundAvatarOcr();
}
function scheduleAvatarOcrPumpResume(delay = AVATAR_OCR_USER_IDLE_MS) {
    if (avatarOcrResumeTimeoutId) return;
    avatarOcrResumeTimeoutId = window.setTimeout(() => {
        avatarOcrResumeTimeoutId = null;
        resumeDeferredAvatarOcrArticles();
        if (avatarOcrQueue.length && !avatarOcrPumpRunning) void pumpAvatarOcrQueue();
    }, Math.max(0, delay));
}
function waitForAvatarOcrIdleOpportunity() {
    if (document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => resolve(), { timeout: 1200 });
        } else {
            window.setTimeout(resolve, 80);
        }
    });
}
function noteAvatarOcrUserActivity() {
    avatarOcrLastUserActivityAt = Date.now();
    scheduleAvatarOcrPumpResume();
}
function hasVisibleAvatarOcrJobWaiting() {
    return avatarOcrQueue.some((job) => isArticleInViewport(job?.article));
}
function updateAvatarOcrPumpProbe(state = '') {
    try {
        document.documentElement.dataset.cbSpamOcrPumpRunning = avatarOcrPumpRunning ? '1' : '0';
        document.documentElement.dataset.cbSpamOcrPumpState = state;
        document.documentElement.dataset.cbSpamOcrActiveAge = avatarOcrActiveStartedAt ? String(Date.now() - avatarOcrActiveStartedAt) : '0';
        document.documentElement.dataset.cbSpamOcrDeferred = String(deferredAvatarOcrArticles.size);
        document.documentElement.dataset.cbSpamOcrCacheSize = String(avatarOcrCache.size);
    } catch {
        /* probe only */
    }
}
function recoverStalledAvatarOcrPump() {
    if (!avatarOcrQueue.length) return;
    if (!avatarOcrPumpRunning) {
        void pumpAvatarOcrQueue();
        return;
    }
    if (!avatarOcrActiveStartedAt) return;
    const activeAge = Date.now() - avatarOcrActiveStartedAt;
    const hasVisibleJobWaiting = hasVisibleAvatarOcrJobWaiting();
    const maxActiveAge = hasVisibleJobWaiting ? AVATAR_OCR_VISIBLE_REQUEUE_MS : AVATAR_OCR_JOB_TIMEOUT_MS + AVATAR_OCR_PUMP_STALL_GRACE_MS;
    if (activeAge <= maxActiveAge) return;
    avatarOcrPumpRunId += 1;
    avatarOcrPumpRunning = false;
    avatarOcrActiveStartedAt = 0;
    avatarOcrActiveArticle = null;
    updateAvatarOcrPumpProbe(hasVisibleJobWaiting ? 'preempt-visible' : 'recovered');
    void pumpAvatarOcrQueue();
}
function shouldCheckProfileBioForArticle(article, tweetText) {
    if (!article || isStatusRootTweetArticle(article)) return false;
    if (article.dataset.profileBioScannedBuild === SPAM_SCANNER_BUILD) return false;
    if (article.dataset.profileBioPending === 'true' || article.dataset.profileBioQueued === 'true') return false;
    if (!getArticleAuthorScreenName(article)) return false;
    const raw = String(tweetText || '').trim();
    if (!raw) return true;
    const compact = compactSpamText(raw);
    return compact.length <= 28 || isShortDatingInviteCompact(compact) || isEmojiOnlyBaitText(raw);
}
function continueSpamScanAfterProfileBio(article) {
    if (!article?.isConnected) return;
    delete article.dataset.profileBioPending;
    delete article.dataset.profileBioQueued;
    delete article.dataset.profileBioQueuedAt;
    const avatarUrl = getAvatarImageUrlFromArticle(article);
    if (avatarUrl && !shouldSkipAvatarOcrForArticle(article) && isAvatarOcrEnabled()) {
        scheduleAvatarOcrForArticle(article, avatarUrl);
        return;
    }
    finalizeSpamArticleScan(article);
}
async function getCachedProfileBioUserData(screenName) {
    if (!screenName) return null;
    const key = screenName.toLowerCase();
    const cached = profileBioCache.get(key);
    if (cached && Date.now() - cached.at < FOLLOWER_COUNT_CACHE_MS) return cached.userResult;
    if (profileBioFetchPending.has(key)) return profileBioFetchPending.get(key);
    const pending = (async () => {
        try {
            const userResult = await getUserDataByScreenName(screenName);
            profileBioCache.set(key, { userResult, at: Date.now() });
            const count = getFollowersCountFromUserResult(userResult);
            followerCountCache.set(key, { count, at: Date.now() });
            return userResult;
        } catch (error) {
            if (isApiRateLimitError(error)) throw error;
            console.warn(`[CB] 无法获取 @${screenName} 的个人简介`, error);
            return null;
        } finally {
            profileBioFetchPending.delete(key);
        }
    })();
    profileBioFetchPending.set(key, pending);
    return pending;
}
function getUserDescriptionFromUserResult(userResult) {
    return String(userResult?.legacy?.description || userResult?.core?.description || userResult?.description || '').trim();
}
function shouldExemptProfileBioUserResult(userResult) {
    return isFollowerCountExempt(getFollowersCountFromUserResult(userResult));
}
function takeNextProfileBioJob() {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < profileBioQueue.length; i += 1) {
        const job = profileBioQueue[i];
        const score = (isArticleInViewport(job?.article) ? 1000 : 0) + (Number(job?.priority) || 0);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
        }
    }
    if (bestIndex > 0) return profileBioQueue.splice(bestIndex, 1)[0];
    return profileBioQueue.shift();
}
async function pumpProfileBioQueue() {
    if (profileBioPumpRunning) return;
    if (await getActiveApiRateLimitState()) return;
    profileBioPumpRunning = true;
    try {
        while (profileBioQueue.length) {
            const job = takeNextProfileBioJob();
            if (!job?.article?.isConnected) continue;
            if (document.hidden || !isArticleNearOcrViewport(job.article)) {
                deferProfileBioUntilNearViewport(job.article, job.screenName);
                continue;
            }
            profileBioActiveArticle = job.article;
            let matched = false;
            let deferredForApiLimit = false;
            try {
                if (scriptConfig.spamIdentifyEnabled === false) {
                    finalizeSpamArticleScan(job.article);
                    continue;
                }
                const userResult = await getCachedProfileBioUserData(job.screenName);
                job.article.dataset.profileBioScannedBuild = SPAM_SCANNER_BUILD;
                const bio = getUserDescriptionFromUserResult(userResult);
                const detection = detectProfileBioSpam(bio);
                if (detection.match) {
                    if (shouldExemptArticleByBlueVerified(job.article, 'profile_bio') || shouldExemptProfileBioUserResult(userResult)) {
                        matched = true;
                    } else {
                        ensureSpamBadge(job.article, detection, 'bio');
                        triggerAutoNukeForMarkedArticle(job.article, {
                            triggerMode: 'auto',
                            autoReason: 'profile_bio',
                            profileBioSummary: detection.summary
                        });
                        matched = true;
                    }
                }
            } catch (error) {
                if (isApiRateLimitError(error)) {
                    showApiLimitRetryToast(error);
                    deferredForApiLimit = true;
                    if (job.article?.isConnected) {
                        job.article.dataset.profileBioQueued = 'true';
                        job.article.dataset.profileBioPending = 'true';
                        job.article.dataset.profileBioQueuedAt = String(Date.now());
                        profileBioQueue.unshift(job);
                    }
                } else {
                    const failCount = (parseInt(job.article.dataset.profileBioFailCount, 10) || 0) + 1;
                    job.article.dataset.profileBioFailCount = String(failCount);
                    console.warn(`[CB] 个人简介识别失败 (${failCount})`, job.screenName, error);
                }
            } finally {
                profileBioActiveArticle = null;
            }
            if (deferredForApiLimit) break;
            if (job.article?.isConnected) {
                if (matched) finalizeSpamArticleScan(job.article);
                else continueSpamScanAfterProfileBio(job.article);
            }
            await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
    } finally {
        profileBioPumpRunning = false;
        profileBioActiveArticle = null;
        if (profileBioQueue.length) void pumpProfileBioQueue();
    }
}
async function pumpAvatarOcrQueue() {
    if (avatarOcrPumpRunning) return;
    avatarOcrPumpRunning = true;
    const pumpRunId = ++avatarOcrPumpRunId;
    updateAvatarOcrPumpProbe('running');
    const patterns = resolveAvatarKeywordPatterns();
    try {
        while (avatarOcrQueue.length && pumpRunId === avatarOcrPumpRunId) {
            await waitForAvatarOcrIdleOpportunity();
            const job = takeNextAvatarOcrJob();
            if (!job?.article?.isConnected) continue;
            if (shouldDeferAvatarOcrJob(job)) {
                if (!document.hidden && !isArticleNearOcrViewport(job.article)) {
                    deferAvatarOcrUntilNearViewport(job.article, job.imageUrl);
                    continue;
                }
                avatarOcrQueue.unshift(job);
                updateAvatarOcrPumpProbe('paused');
                scheduleAvatarOcrPumpResume();
                break;
            }
            let matched = false;
            let deferredForApiLimit = false;
            avatarOcrActiveStartedAt = Date.now();
            avatarOcrActiveArticle = job.article;
            updateAvatarOcrPumpProbe('active');
            try {
                if (scriptConfig.spamIdentifyEnabled === false || !isAvatarOcrEnabled()) {
                    if (job.article?.isConnected) finalizeSpamArticleScan(job.article);
                    continue;
                }
                const analysis = await withAvatarOcrJobTimeout(analyzeAvatarImageUrl(job.imageUrl, patterns));
                if (pumpRunId !== avatarOcrPumpRunId) return;
                if (analysis.match) {
                    const trustedExempt = await shouldExemptArticleByTrustedAuthor(job.article, 'avatar_ocr');
                    if (pumpRunId !== avatarOcrPumpRunId) return;
                    if (trustedExempt) {
                        matched = true;
                    } else {
                        const hit = analysis.hit || '头像关键词';
                        ensureSpamBadge(job.article, { match: true, score: 1, summary: hit }, 'avatar');
                        triggerAutoNukeForMarkedArticle(job.article, {
                            triggerMode: 'auto',
                            autoReason: 'avatar_ocr',
                            avatarOcrHit: hit
                        });
                        matched = true;
                    }
                }
            } catch (error) {
                if (pumpRunId !== avatarOcrPumpRunId) return;
                if (isApiRateLimitError(error)) {
                    showApiLimitRetryToast(error);
                    deferredForApiLimit = true;
                    if (job.article?.isConnected) {
                        releaseAvatarOcrForRetry(job.article);
                        job.article.dataset.avatarOcrQueued = 'true';
                        job.article.dataset.avatarOcrPending = 'true';
                        job.article.dataset.avatarOcrQueuedAt = String(Date.now());
                        avatarOcrQueue.unshift(job);
                    }
                } else {
                    noteAvatarOcrError(error);
                    const failCount = (parseInt(job.article.dataset.avatarOcrFailCount, 10) || 0) + 1;
                    job.article.dataset.avatarOcrFailCount = String(failCount);
                    console.warn(`[CB] 头像识别失败 (${failCount}/${AVATAR_OCR_MAX_FAILS})`, job.imageUrl, error);
                    if (!isAvatarOcrJobTimeout(error) && failCount < AVATAR_OCR_MAX_FAILS) {
                        releaseAvatarOcrForRetry(job.article);
                        continue;
                    }
                }
            } finally {
                if (pumpRunId === avatarOcrPumpRunId) {
                    avatarOcrActiveStartedAt = 0;
                    avatarOcrActiveArticle = null;
                    updateAvatarOcrPumpProbe('idle');
                }
            }
            if (deferredForApiLimit) break;
            if (job.article?.isConnected) finalizeSpamArticleScan(job.article);
            await new Promise((resolve) => window.setTimeout(resolve, 180));
        }
    } finally {
        if (pumpRunId === avatarOcrPumpRunId) {
            avatarOcrPumpRunning = false;
            avatarOcrActiveStartedAt = 0;
            avatarOcrActiveArticle = null;
            updateAvatarOcrPumpProbe('stopped');
            if (avatarOcrQueue.length) {
                scheduleAvatarOcrPumpResume();
            }
        }
    }
}
async function processSpamArticle(article) {
    if (shouldSkipSpamArticleScan(article)) return;
    const tweetText = getTweetTextFromArticle(article);
    const textDetection = tweetText ? detectSpamReply(tweetText) : null;
    if (shouldSkipSpamIdentifyForArticle(article, textDetection)) {
        clearSpamIdentifyTextBadge(article);
        finalizeSpamArticleScan(article);
        return;
    }
    if (tweetText) {
        const detection = textDetection || detectSpamReply(tweetText);
        article.dataset.spamTextScannedBuild = SPAM_SCANNER_BUILD;
        if (detection.match) {
            let trustedExempt = false;
            try {
                trustedExempt = await shouldExemptArticleByTrustedAuthor(article, 'spam_identify');
            } catch (error) {
                if (isApiRateLimitError(error)) {
                    showApiLimitRetryToast(error);
                    delete article.dataset.spamTextScannedBuild;
                    return;
                }
                throw error;
            }
            if (trustedExempt) {
                finalizeSpamArticleScan(article);
                return;
            }
            ensureSpamBadge(article, detection, 'text');
            if (triggerAutoNukeForMarkedArticle(article, {
                triggerMode: 'auto',
                autoReason: 'spam_identify',
                spamSummary: detection.summary,
                spamScore: detection.score
            })) {
                finalizeSpamArticleScan(article);
                return;
            }
        }
    }
    if (shouldCheckProfileBioForArticle(article, tweetText)) {
        scheduleProfileBioScanForArticle(article, getArticleAuthorScreenName(article));
        return;
    }
    const avatarUrl = getAvatarImageUrlFromArticle(article);
    if (avatarUrl && !shouldSkipAvatarOcrForArticle(article) && isAvatarOcrEnabled()) {
        scheduleAvatarOcrForArticle(article, avatarUrl);
        return;
    }
    finalizeSpamArticleScan(article);
}
const SPAM_EXPAND_LABEL_RE = /垃圾|spam|冒犯|offensive|可疑|probable|隐藏|更多回复|additional repl|显示可能的垃圾|可能含有垃圾/i;
const HIDDEN_SPAM_EXPAND_RE = /显示可能的垃圾|Show probable spam|probable spam|可能含有垃圾|冒犯性回复|Offensive replies/i;
function tryExpandHiddenSpamReplies() {
    if (scriptConfig.spamAutoExpandHidden === false || scriptConfig.spamIdentifyEnabled === false) return;
    if (!isStatusTweetPage()) return;
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
function shouldQueueArticleForDetection(article) {
    if (!article?.isConnected) return false;
    if (article.dataset?.avatarOcrPending === 'true' || article.dataset?.profileBioPending === 'true') return false;
    const autoComplete = ['complete', 'true'].includes(article.dataset?.autoblockChecked);
    const spamComplete = article.dataset?.spamScanned === 'complete';
    return !autoComplete || !spamComplete;
}
function selectDetectionScanArticles(pendingArticles, fullArticles, fullScan = false) {
    const source = fullScan ? (fullArticles || []) : (pendingArticles || []);
    return [...new Set(source)].filter(shouldQueueArticleForDetection);
}
function queueDetectionArticle(article) {
    if (!shouldQueueArticleForDetection(article)) return false;
    pendingDetectionArticles.add(article);
    return true;
}
function queueDetectionArticlesFromNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return 0;
    const articles = new Set();
    if (node.matches?.('article[data-testid="tweet"]')) articles.add(node);
    const closest = node.closest?.('article[data-testid="tweet"]');
    if (closest) articles.add(closest);
    node.querySelectorAll?.('article[data-testid="tweet"]').forEach((article) => articles.add(article));
    let queued = 0;
    articles.forEach((article) => {
        if (queueDetectionArticle(article)) queued += 1;
    });
    return queued;
}
function updateDetectionScanProbe(lastDurationMs = 0, lastArticleCount = 0) {
    try {
        document.documentElement.dataset.cbDetectionScanRuns = String(detectionScanRunCount);
        document.documentElement.dataset.cbDetectionScanArticles = String(detectionScanArticleCount);
        document.documentElement.dataset.cbDetectionScanLastArticles = String(lastArticleCount);
        document.documentElement.dataset.cbDetectionScanLastMs = String(Math.max(0, Math.round(lastDurationMs)));
        document.documentElement.dataset.cbDetectionScanPending = String(pendingDetectionArticles.size);
        document.documentElement.dataset.cbDetectionScanRunning = detectionScanRunning ? '1' : '0';
    } catch {
        /* probe only */
    }
}
function scheduleDetectionScan(fullScan = false, delay = DETECTION_SCAN_DELAY_MS) {
    if (fullScan) detectionFullScanPending = true;
    if (detectionScanTimeoutId || detectionScanIdleId) return;
    detectionScanTimeoutId = window.setTimeout(() => {
        detectionScanTimeoutId = null;
        const run = () => {
            detectionScanIdleId = null;
            void runDetectionScanBatch().catch((error) => console.error('[CB] 增量检测批次失败:', error));
        };
        if (typeof window.requestIdleCallback === 'function') {
            detectionScanIdleId = window.requestIdleCallback(run, { timeout: 700 });
        } else {
            run();
        }
    }, Math.max(0, delay));
}
async function runDetectionScanBatch() {
    if (detectionScanRunning) {
        detectionScanRerunRequested = true;
        return;
    }
    if (!shouldRunArticleDetectionScans() || !currentUserId) {
        if (shouldRunArticleDetectionScans()) detectionFullScanPending = true;
        ensureManualDetectedNukeButton();
        return;
    }
    detectionScanRunning = true;
    const startedAt = Date.now();
    const currentPath = window.location.pathname;
    const fullScan = detectionFullScanPending || detectionScanPath !== currentPath;
    detectionFullScanPending = false;
    detectionScanPath = currentPath;
    const fullArticles = fullScan ? Array.from(document.querySelectorAll('article[data-testid="tweet"]')) : [];
    const articles = selectDetectionScanArticles(Array.from(pendingDetectionArticles), fullArticles, fullScan);
    pendingDetectionArticles.clear();
    try {
        resetSpamScanMarkersForBuildUpgrade();
        markStatusRootTweetArticles();
        tryExpandHiddenSpamReplies();
        resumeDeferredProfileBioArticles();
        resumeDeferredAvatarOcrArticles();
        recoverStalledAvatarOcrPump();
        if (articles.length) {
            await scanAndProcessContent(articles);
            await scanSpamIdentifyContent(articles);
        } else {
            ensureManualDetectedNukeButton();
        }
        recoverStalledAvatarOcrPump();
        detectionScanRunCount += 1;
        detectionScanArticleCount += articles.length;
    } finally {
        detectionScanRunning = false;
        updateDetectionScanProbe(Date.now() - startedAt, articles.length);
        if (detectionScanRerunRequested || pendingDetectionArticles.size || detectionFullScanPending) {
            detectionScanRerunRequested = false;
            scheduleDetectionScan(false, 80);
        }
    }
}
function articleHasAvatarSpamBadge(article) {
    const badge = article?.querySelector('.nuke-spam-badge');
    return !!(badge && /头像|全国安排/.test(badge.textContent || ''));
}
function clearSpamIdentifyTextBadge(article) {
    const badge = article?.querySelector('.nuke-spam-badge');
    if (!badge || !/^疑似引流/.test(badge.textContent || '')) return;
    badge.remove();
    if (!article.querySelector('.nuke-spam-badge')) article.classList.remove('nuke-spam-identified');
}
function shouldSkipSpamArticleScan(article) {
    if (shouldPromoteVisibleAvatarOcrPending(article)) {
        releaseAvatarOcrForRetry(article);
        return false;
    }
    if (hasStaleAvatarOcrPending(article)) {
        releaseAvatarOcrForRetry(article);
        return false;
    }
    if (hasStaleProfileBioPending(article)) {
        releaseProfileBioForRetry(article);
        return false;
    }
    if (article.dataset.profileBioPending === 'true') return true;
    const hasPendingTextScan = !!getTweetTextFromArticle(article) && article.dataset.spamTextScannedBuild !== SPAM_SCANNER_BUILD && !article.querySelector('.nuke-spam-badge:not([data-avatar-ocr-badge])');
    if (article.dataset.avatarOcrPending === 'true') return !hasPendingTextScan;
    if (article.dataset.spamScanned !== 'complete') return false;
    if (articleHasAvatarSpamBadge(article)) return true;
    const textBadge = article.querySelector('.nuke-spam-badge');
    if (textBadge && !/头像|全国安排/.test(textBadge.textContent || '')) return true;
    return true;
}
function isSpamSectionExpandControl(element) {
    if (!element) return false;
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 140) return false;
    return SPAM_EXPAND_LABEL_RE.test(text);
}
function scheduleSpamRescan(extraDelaysMs = [300, 900, 1800]) {
    scheduleDetectionScan(true);
    extraDelaysMs.forEach((ms) => {
        window.setTimeout(() => scheduleDetectionScan(true, 0), ms);
    });
}
function scheduleSpamRescanDebounced() {
    scheduleDetectionScan(false);
}
async function scanSpamIdentifyContent(articles = []) {
    if (!shouldRunArticleDetectionScans() || !currentUserId || scriptConfig.spamIdentifyEnabled === false) return;
    if (profileBioQueue.length && !profileBioPumpRunning) void pumpProfileBioQueue();
    await Promise.allSettled((articles || []).filter((article) => article?.isConnected).map((article) => processSpamArticle(article)));
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
        document.documentElement.dataset.cbSpamProfileBioQueueLen = String(profileBioQueue.length);
        document.documentElement.dataset.cbSpamProfileBioPending = String(document.querySelectorAll('article[data-profile-bio-pending="true"]').length);
        document.documentElement.dataset.cbSpamProfileBioDeferred = String(deferredProfileBioArticles.size);
        ensureManualDetectedNukeButton();
    } catch {
        /* probe only */
    }
}
async function inspectTweetArticleForSpam(article) {
    const userLink = article.querySelector('div[data-testid="User-Name"] a[role="link"]');
    const screenName = getScreenNameFromProfileHref(userLink?.href) || '未知';
    const tweetText = getTweetTextFromArticle(article);
    let followerExempt = false;
    try {
        followerExempt = await shouldExemptArticleByTrustedAuthor(article, 'manual_spam_inspect');
    } catch (error) {
        if (isApiRateLimitError(error)) {
            showApiLimitRetryToast(error);
            return `@${screenName}: API 已达上限，等待恢复后再检测`;
        }
        throw error;
    }
    let summary = '';
    if (!followerExempt && tweetText) {
        const detection = detectSpamReply(tweetText);
        if (detection.match) {
            ensureSpamBadge(article, detection, 'text');
            summary = `${detection.summary}（${detection.score}分）`;
        }
    }
    const avatarUrl = getAvatarImageUrlFromArticle(article);
    if (!followerExempt && avatarUrl && !shouldSkipAvatarOcrForArticle(article) && isAvatarOcrEnabled()) {
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
    if (trigger.autoReason === 'display_name_spam') return 'auto_display_name_spam';
    if (trigger.autoReason === 'spam_identify') return 'auto_spam_identify';
    if (trigger.autoReason === 'avatar_ocr') return 'auto_avatar_ocr';
    if (trigger.autoReason === 'manual_detected_target') return 'auto_manual_detected';
    return 'manual_author';
}
function buildAuthorBlockNote(trigger, context = {}) {
    const reason = resolveAuthorBlockReason(trigger);
    const reasonLabels = {
        manual_author: '九族拉黑·主推',
        auto_promo_target: '自动九族·引流目标',
        auto_author_keyword: '自动拉黑·关键词',
        auto_display_name_spam: '自动拉黑·昵称引流',
        auto_spam_identify: '自动九族·引流识别',
        auto_avatar_ocr: '自动九族·头像OCR',
        auto_manual_detected: '手动九族·已检测目标'
    };
    const handle = context.authorHandle ? `@${context.authorHandle}` : '该用户';
    let blockNote = `${reasonLabels[reason] || '拉黑·主推'} ${handle} 的推文${formatTweetContextSuffix(context)}`.trim();
    if (reason === 'auto_promo_target' && trigger.promoTargetHandle) {
        blockNote += `（命中 @${trigger.promoTargetHandle}）`;
    }
    if (reason === 'auto_author_keyword' && trigger.suspiciousDisplayName) {
        blockNote += `（显示名: ${truncateBlockContextText(trigger.suspiciousDisplayName, 60)}）`;
    }
    if (reason === 'auto_spam_identify' && trigger.spamSummary) {
        const score = Number.isFinite(Number(trigger.spamScore)) ? `，${trigger.spamScore}分` : '';
        blockNote += `（${truncateBlockContextText(trigger.spamSummary, 60)}${score}）`;
    }
    if (reason === 'auto_avatar_ocr' && trigger.avatarOcrHit) {
        blockNote += `（头像 OCR: ${truncateBlockContextText(trigger.avatarOcrHit, 60)}）`;
    }
    if (reason === 'auto_manual_detected' && trigger.spamSummary) {
        blockNote += `（${truncateBlockContextText(trigger.spamSummary, 60)}）`;
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
    const statusLink = targetArticle ? Array.from(targetArticle.querySelectorAll('a')).find(a => /\/status\/\d+/.test(a.href)) : null;
    const tweetId = statusLink?.href.match(/\/status\/(\d+)/)?.[1] || null;
    const handle = authorHandle || getScreenNameFromProfileHref(statusLink?.href) || '';
    const tweetUrl = tweetId && handle ? `https://x.com/${handle}/status/${tweetId}` : (statusLink?.href?.split('?')[0] || '');
    return {
        tweetId,
        tweetUrl,
        tweetText: truncateBlockContextText(getTweetTextFromArticle(targetArticle)),
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
        sourceRootAuthorHandle: context.rootAuthorHandle || '',
        sourceRootAuthorId: context.rootAuthorId || null,
        nukeTaskIds: getEntryNukeTaskIds(context),
        blockReason: meta.blockReason,
        blockNote: meta.blockNote
    };
}
function mergeQueueEntries(existingEntry, incomingEntry, context) {
    const chainSources = [...new Set([...(existingEntry.chainSources || []), ...(incomingEntry.chainSources || [])])];
    const meta = buildChainBlockNote(chainSources, context);
    const nukeTaskIds = mergeNukeTaskIds(getEntryNukeTaskIds(existingEntry), getEntryNukeTaskIds(incomingEntry), getEntryNukeTaskIds(context));
    return { ...existingEntry, ...incomingEntry, chainSources, nukeTaskIds, blockReason: meta.blockReason, blockNote: meta.blockNote };
}
function createPendingHiddenUserEntry(entry, context = {}) {
    return {
        userId: entry.userId || null,
        screenName: normalizePromoHandle(entry.screenName),
        userNameText: entry.userNameText || entry.screenName || '',
        sourceTweetId: entry.sourceTweetId || context.tweetId || null,
        sourceTweetUrl: entry.sourceTweetUrl || context.tweetUrl || '',
        sourceTweetText: entry.sourceTweetText || context.tweetText || '',
        sourceAuthorHandle: entry.sourceAuthorHandle || context.authorHandle || '',
        nukeTaskIds: mergeNukeTaskIds(getEntryNukeTaskIds(entry), getEntryNukeTaskIds(context)),
        blockReason: entry.blockReason || '',
        blockNote: entry.blockNote || ''
    };
}
function createAuthorQueueEntry(resolvedTarget) {
    const { authorId, authorHandle, authorUserNameText, trigger, tweetContext } = resolvedTarget;
    const meta = buildAuthorBlockNote(trigger, tweetContext);
    const nukeTaskIds = mergeNukeTaskIds(getEntryNukeTaskIds(resolvedTarget), getEntryNukeTaskIds(tweetContext));
    return {
        userId: authorId,
        screenName: authorHandle,
        userNameText: authorUserNameText,
        sourceTweetId: tweetContext.tweetId || null,
        sourceTweetUrl: tweetContext.tweetUrl || '',
        sourceTweetText: truncateBlockContextText(tweetContext.tweetText),
        sourceAuthorHandle: tweetContext.authorHandle || authorHandle,
        sourceRootAuthorHandle: tweetContext.rootAuthorHandle || '',
        sourceRootAuthorId: tweetContext.rootAuthorId || null,
        nukeTaskIds,
        queuePriority: nukeTaskIds.length ? (isZeroEngagementNukeTarget(resolvedTarget) ? 0 : 1) : 5,
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
            const rawScreenName = String(entry.screenName || '');
            const userName = escapeHtml(entry.userNameText || rawScreenName || String(entry.userId));
            const screenNameHandle = escapeHtml(rawScreenName ? `@${rawScreenName}` : '');
            const profileUrl = rawScreenName ? `https://x.com/${encodeURIComponent(rawScreenName)}` : '';
            const userLinkHTML = profileUrl ? `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer" title="在新标签页中打开"><span class="nuke-list-user-name">${userName}</span></a>` : `<span class="nuke-list-user-name">${userName}</span>`;
            if (type === 'log') {
                const timestamp = escapeHtml(entry.blockTimestamp ? new Date(entry.blockTimestamp).toLocaleString() : '未知时间');
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
                const timestamp = escapeHtml(entry.addedAt ? new Date(entry.addedAt).toLocaleString() : '未知时间');
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
    UserByScreenName: { hash: '2qvSHpkWTMS9i0zJAwDNiA', features: {"hidden_profile_subscriptions_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_feature_can_gift_premium":true,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true}, fieldToggles: {"withPayments":false,"withAuxiliaryUserLabels":true} },
    UserByRestId: { hash: 'tD4_0f_p354q1Yin156s2Q', features: {"responsive_web_grok_bio_auto_translation_is_enabled":false,"hidden_profile_subscriptions_enabled":true,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":true,"subscriptions_feature_can_gift_premium":true,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true} },
    Retweeters: { hash: 'DmC_H6eV_XMiL0g4ltJvpg', features: {"rweb_video_screen_enabled":false,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":false,"responsive_web_grok_share_attachment_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_enhance_cards_enabled":false} },
    Favoriters: { hash: 'SoWvHOdzCsomAQdY-bFNDA', features: {"rweb_video_screen_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":false,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_enhance_cards_enabled":false} },
    TweetDetail: { hash: '-0WTL1e9Pij-JWAF5ztCCA', features: {"rweb_video_screen_enabled":false,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":false,"responsive_web_grok_share_attachment_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_enhance_cards_enabled":false} }
};
API_ENDPOINTS.TweetDetail = {
    hash: 'jd3V43oDY9cY7obs1YMfbQ',
    features: {"rweb_video_screen_enabled":false,"rweb_cashtags_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"rweb_cashtags_composer_attachment_enabled":false,"responsive_web_jetfuel_frame":false,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"rweb_conversational_replies_downvote_enabled":false,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":false,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"responsive_web_enhance_cards_enabled":false},
    fieldToggles: {"withArticleRichContentState":true,"withArticlePlainText":false,"withArticleSummaryText":true,"withArticleVoiceOver":true,"withGrokAnalyze":false,"withDisallowedReplyControls":false}
};
Object.assign(API_ENDPOINTS.TweetDetail.features, {
    rweb_cashtags_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_show_grok_translated_post: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_community_note_auto_translation_is_enabled: true
});
function buildGraphqlUrl(endpoint, operationName, variables) {
    const params = new URLSearchParams();
    params.set('variables', JSON.stringify(variables));
    params.set('features', JSON.stringify(endpoint.features || {}));
    if (endpoint.fieldToggles) params.set('fieldToggles', JSON.stringify(endpoint.fieldToggles));
    return `https://x.com/i/api/graphql/${endpoint.hash}/${operationName}?${params.toString()}`;
}
function getResponseHeaderValue(responseHeaders, name) {
    const wanted = String(name || '').toLowerCase();
    const line = String(responseHeaders || '').split(/\r?\n/).find((header) => header.toLowerCase().startsWith(`${wanted}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}
function getApiRateLimitRetryAtFromResponse(response) {
    const now = Date.now();
    const resetSeconds = parseInt(getResponseHeaderValue(response?.responseHeaders, 'x-rate-limit-reset'), 10);
    if (Number.isFinite(resetSeconds) && resetSeconds * 1000 > now) return resetSeconds * 1000;
    const retryAfterSeconds = parseInt(getResponseHeaderValue(response?.responseHeaders, 'retry-after'), 10);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return now + retryAfterSeconds * 1000;
    return now + API_RETRY_DELAY_MS;
}
function normalizeApiRateLimitState(value, now = Date.now()) {
    if (!value || typeof value !== 'object') return null;
    const retryAt = Number(value.retryAt || 0);
    if (!Number.isFinite(retryAt) || retryAt <= now) return null;
    return {
        retryAt,
        updatedAt: Number(value.updatedAt || 0) || 0,
        source: String(value.source || 'api')
    };
}
async function getActiveApiRateLimitState(now = Date.now()) {
    return normalizeApiRateLimitState(await GM_getValue(API_RATE_LIMIT_STATE_KEY, null), now);
}
async function clearExpiredApiRateLimitState(now = Date.now()) {
    const raw = await GM_getValue(API_RATE_LIMIT_STATE_KEY, null);
    const retryAt = Number(raw?.retryAt || 0);
    if (retryAt && retryAt <= now) await GM_setValue(API_RATE_LIMIT_STATE_KEY, { retryAt: 0, updatedAt: now, source: 'expired' });
}
async function recordApiRateLimitUntil(retryAt, source = 'api') {
    const now = Date.now();
    const fallbackRetryAt = now + API_RETRY_DELAY_MS;
    const parsedRetryAt = Number(retryAt);
    const nextRetryAt = Number.isFinite(parsedRetryAt) && parsedRetryAt > now ? parsedRetryAt : fallbackRetryAt;
    const current = await getActiveApiRateLimitState(now);
    const state = {
        retryAt: Math.max(current?.retryAt || 0, nextRetryAt),
        updatedAt: now,
        source
    };
    await GM_setValue(API_RATE_LIMIT_STATE_KEY, state);
    return state;
}
async function recordApiRateLimitFromResponse(response) {
    return recordApiRateLimitUntil(getApiRateLimitRetryAtFromResponse(response), 'api');
}
function buildApiRateLimitError(state) {
    return { message: 'API 已达上限，等待共享恢复时间', status: 429, retryAt: state.retryAt, sharedRateLimit: true };
}
async function throwIfApiRateLimited() {
    const state = await getActiveApiRateLimitState();
    if (state) throw buildApiRateLimitError(state);
}
function waitForMs(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function getApiOperationWaitMs(localStartedAt, sharedStartedAt, now = Date.now(), intervalMs = API_OPERATION_INTERVAL_MS) {
    const lastStartedAt = Math.max(Number(localStartedAt) || 0, Number(sharedStartedAt) || 0);
    return Math.max(0, lastStartedAt + intervalMs - now);
}
function withCrossTabLock(name, operation) {
    if (navigator.locks?.request) {
        return navigator.locks.request(name, { mode: 'exclusive' }, operation);
    }
    return operation();
}
function enqueueApiOperation(operation) {
    const run = async () => {
        return withCrossTabLock(API_CROSS_TAB_LOCK_NAME, async () => {
            await throwIfApiRateLimited();
            const sharedStartedAt = await GM_getValue(API_LAST_OPERATION_STARTED_KEY, 0);
            const waitMs = getApiOperationWaitMs(apiLastOperationStartedAt, sharedStartedAt);
            if (waitMs > 0) await waitForMs(waitMs);
            await throwIfApiRateLimited();
            apiLastOperationStartedAt = Date.now();
            await GM_setValue(API_LAST_OPERATION_STARTED_KEY, apiLastOperationStartedAt);
            return operation();
        });
    };
    const scheduled = apiOperationTail.then(run, run);
    apiOperationTail = scheduled.catch(() => {});
    return scheduled;
}
function getGraphqlErrorMessage(responseData) {
    if (!Array.isArray(responseData?.errors)) return '';
    return responseData.errors
        .map((error) => String(error?.message || '').trim())
        .filter(Boolean)
        .join('; ')
        .slice(0, 300);
}
function getApiResponseErrorMessage(status, responseText) {
    let detail = '';
    try {
        const parsed = responseText ? JSON.parse(responseText) : null;
        const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
        detail = errors.map((error) => {
            const message = String(error?.message || '').trim();
            const code = Number.isFinite(Number(error?.code)) ? ` (${Number(error.code)})` : '';
            return message ? `${message}${code}` : '';
        }).filter(Boolean).join('; ').slice(0, 300);
    } catch {
        detail = '';
    }
    return `API请求失败: ${status}${detail ? ` - ${detail}` : ''}`;
}
async function makeApiRequest(url, method = "GET", data = null, onStart = null) {
    return enqueueApiOperation(() => {
        onStart?.();
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method,
        url,
        data,
        timeout: API_REQUEST_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${getAuthToken()}`, "Content-Type": "application/x-www-form-urlencoded", "x-csrf-token": getCsrfToken() },
        onload: (r) => {
            if (r.status >= 200 && r.status < 300) {
                try {
                    const responseData = r.responseText ? JSON.parse(r.responseText) : null;
                    const graphqlError = getGraphqlErrorMessage(responseData);
                    if (graphqlError && !responseData?.data) {
                        reject({ message: `GraphQL 请求失败: ${graphqlError}`, status: r.status, graphqlError: true });
                        return;
                    }
                    resolve(responseData);
                } catch (error) {
                    reject({ message: 'API响应解析失败', status: r.status, error });
                }
                return;
            }
            if (r.status === 429) {
                void (async () => {
                    try {
                        const state = await recordApiRateLimitFromResponse(r);
                        reject({ message: `API请求失败: ${r.status}`, status: r.status, retryAt: state.retryAt, responseHeaders: r.responseHeaders || '' });
                    } catch (error) {
                        reject({ message: `API请求失败: ${r.status}`, status: r.status, error });
                    }
                })();
                return;
            }
            reject({ message: getApiResponseErrorMessage(r.status, r.responseText), status: r.status });
        },
        onerror: e => reject({ message: "Network or script error", error: e }),
        ontimeout: () => reject({ message: "API请求超时", status: 0 })
        }));
    });
}
function isApiRateLimitError(error) {
    return error?.status === 429 || error?.sharedRateLimit === true;
}
function isApiTimeoutError(error) {
    return error?.status === 0 || /超时|timeout/i.test(String(error?.message || ''));
}
function clearApiLimitTimers() {
    if (apiLimitCountdownInterval) clearInterval(apiLimitCountdownInterval);
    if (apiLimitRetryTimeoutId) clearTimeout(apiLimitRetryTimeoutId);
    apiLimitCountdownInterval = null;
    apiLimitRetryTimeoutId = null;
    apiLimitRetryAt = 0;
}
function scheduleApiLimitRetry(retryAt) {
    if (!retryAt || retryAt <= Date.now()) return;
    if (apiLimitRetryAt === retryAt && apiLimitRetryTimeoutId) return;
    if (apiLimitRetryTimeoutId) clearTimeout(apiLimitRetryTimeoutId);
    apiLimitRetryAt = retryAt;
    apiLimitRetryTimeoutId = setTimeout(() => {
        apiLimitRetryTimeoutId = null;
        apiLimitRetryAt = 0;
        initialize();
    }, Math.max(0, retryAt - Date.now()));
}
function startApiLimitCountdown(retryAt) {
    if (apiLimitCountdownInterval) clearInterval(apiLimitCountdownInterval);
    const render = async () => {
        const toastStatusEl = document.querySelector('#nuke-api-limit-toast .nuke-toast-status');
        if (!toastStatusEl) {
            if (apiLimitCountdownInterval) clearInterval(apiLimitCountdownInterval);
            apiLimitCountdownInterval = null;
            return;
        }
        const state = await getActiveApiRateLimitState();
        const activeRetryAt = state?.retryAt || retryAt;
        const secondsLeft = Math.ceil((activeRetryAt - Date.now()) / 1000);
        if (secondsLeft <= 0) {
            toastStatusEl.innerHTML = '正在重试...';
            if (apiLimitCountdownInterval) clearInterval(apiLimitCountdownInterval);
            apiLimitCountdownInterval = null;
            if (!apiLimitRetryTimeoutId) {
                apiLimitRetryTimeoutId = setTimeout(() => {
                    apiLimitRetryTimeoutId = null;
                    apiLimitRetryAt = 0;
                    initialize();
                }, 0);
            }
            return;
        }
        scheduleApiLimitRetry(activeRetryAt);
        toastStatusEl.innerHTML = `将在 <b>${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}</b> 后重试`;
    };
    void render();
    apiLimitCountdownInterval = setInterval(() => {
        void render();
    }, 1000);
}
function showApiLimitRetryToast(error = null) {
    showToast('nuke-api-limit-toast', 'API 已达上限', '正在计算时间...', null);
    void (async () => {
        let state = error?.retryAt ? await recordApiRateLimitUntil(error.retryAt, error.sharedRateLimit ? 'shared' : 'api') : await getActiveApiRateLimitState();
        if (!state) state = await recordApiRateLimitUntil(Date.now() + API_RETRY_DELAY_MS, 'local');
        startApiLimitCountdown(state.retryAt);
    })();
}
function showManualDetectedApiStopToast(error) {
    if (isApiRateLimitError(error)) {
        showApiLimitRetryToast(error);
        showToast('nuke-manual-detected-toast', '后台列表等待重试', 'X API 已达上限，已保留本地隐藏和队列；稍后自动重试', 5000);
        return;
    }
    if (isApiTimeoutError(error)) {
        showToast('nuke-manual-detected-toast', '后台列表等待重试', 'API 请求超时，已保留本地隐藏和队列；稍后自动重试', 5000);
        return;
    }
    showToast('nuke-manual-detected-toast', '手动执行失败', error?.message || String(error), 5000);
}
function showManualDetectedChainCollectPausedToast(error) {
    if (isApiRateLimitError(error)) {
        showApiLimitRetryToast(error);
        showToast('nuke-manual-detected-toast', '九族列表收集已暂停', 'X API 已达上限，停止继续收集关联列表；已入队用户会后台处理', 5000);
        return;
    }
    if (isApiTimeoutError(error)) {
        showToast('nuke-manual-detected-toast', '九族列表收集已暂停', '关联列表请求超时，停止继续收集；已入队用户会后台处理', 5000);
        return;
    }
    showToast('nuke-manual-detected-toast', '九族列表收集失败', error?.message || String(error), 5000);
}
function skipFailedChainList(label, onCollectFailure) {
    return (error) => {
        console.warn(`[CB] 获取${label}失败，将跳过${label}关联用户`, error);
        try {
            onCollectFailure?.(error, label);
        } catch {
            /* ignore */
        }
        if (isApiRateLimitError(error)) showApiLimitRetryToast(error);
        return [];
    };
}
function getCsrfToken() { const e = document.cookie.split("; ").find(e => e.startsWith("ct0=")); return e ? e.split("=")[1] : null; }
function parseTwidUserId(cookieText = document.cookie) {
    const cookie = String(cookieText || '').split(/;\s*/).find((part) => part.startsWith('twid='));
    if (!cookie) return '';
    let value = cookie.slice(cookie.indexOf('=') + 1).replace(/^"|"$/g, '');
    try {
        value = decodeURIComponent(value);
    } catch {
        /* use the raw cookie value */
    }
    return value.match(/(?:^|&)u=(\d+)/)?.[1] || '';
}
function getAuthToken() { return "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"; }
async function getUserDataByScreenName(screenName) {
    const endpoint = API_ENDPOINTS.UserByScreenName;
    const url = buildGraphqlUrl(endpoint, 'UserByScreenName', {screen_name:screenName,withGrokTranslatedBio:true});
    const data = await makeApiRequest(url);
    const identity = getNormalizedUserIdentity(data?.data?.user?.result);
    if (identity) return identity.user;
    throw new Error(`无法找到用户 @${screenName} 的数据`);
}
async function getUserDataById(userId) {
    const endpoint = API_ENDPOINTS.UserByRestId;
    const url = buildGraphqlUrl(endpoint, 'UserByRestId', {userId,withSafetyModeUserFields:true});
    const data = await makeApiRequest(url);
    const identity = getNormalizedUserIdentity(data?.data?.user?.result);
    if (identity) return identity.user;
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
function matchesBuiltInDisplayNameSpam(userNameText) {
    const normalized = String(userNameText || '').replace(/\s+/g, '').replace(/[^\u4e00-\u9fffa-z0-9]/gi, '').toLowerCase();
    if (!normalized) return false;
    return /找个(?:搭子|单男)$/.test(normalized) || /附近的(?:dd|来)$/.test(normalized) || (/同城/.test(normalized) && /[上丄]门/.test(normalized) && /附近/.test(normalized)) || /裸聊/.test(normalized) || (/小姨子/.test(normalized) && /找姐夫/.test(normalized)) || /无线下$/.test(normalized) || ((/赚钱|挣钱|搞钱|网赚|兼职|副业|快钱|日结/.test(normalized) && /跑分|灰产|偏门|洗钱|返佣|外汇|区块链|币圈/.test(normalized)) || /跑分灰产|灰产副业|网赚兼职|快钱日结/.test(normalized));
}
function getUsernameRuleFollowerExemptThreshold() {
    return scriptConfig.usernameRuleFollowerExemptThreshold ?? DEFAULT_USERNAME_RULE_FOLLOWER_EXEMPT_THRESHOLD;
}
function isBlueVerifiedExemptEnabled() {
    return scriptConfig.blueVerifiedExemptEnabled !== false;
}
function isFollowerCountExempt(followerCount) {
    if (followerCount == null || Number.isNaN(followerCount)) return false;
    return followerCount > getUsernameRuleFollowerExemptThreshold();
}
function getAutoBlockDecision(userNameText, followerCount) {
    const exemptThreshold = getUsernameRuleFollowerExemptThreshold();
    const keywordMatch = matchesStandardKeywords(userNameText, scriptConfig.blockKeywordsStandard || []);
    const builtInDisplayNameMatch = matchesBuiltInDisplayNameSpam(userNameText);
    if (!keywordMatch && !builtInDisplayNameMatch) return { block: false, reason: 'no_match' };
    if (followerCount == null || Number.isNaN(followerCount)) {
        return { block: true, reason: builtInDisplayNameMatch ? 'display_name_spam' : 'standard_keywords', followerCount: null, exemptThreshold };
    }
    if (followerCount <= exemptThreshold) return { block: true, reason: builtInDisplayNameMatch ? 'display_name_spam' : 'standard_keywords', followerCount, exemptThreshold };
    return { block: false, reason: 'follower_exempt', followerCount, exemptThreshold };
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
function getArticleAuthorScreenName(article) {
    const userLink = article?.querySelector('div[data-testid="User-Name"] a[role="link"]');
    return getScreenNameFromProfileHref(userLink?.href);
}
function getVisibleFollowerCountFromText(text) {
    const source = String(text || '').replace(/,/g, '');
    const patterns = [
        /(\d+(?:\.\d+)?)\s*([万千kKmM]?)\s*(?:粉丝|关注者|followers?)/i,
        /(?:粉丝|关注者|followers?)\s*(\d+(?:\.\d+)?)\s*([万千kKmM]?)/i
    ];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match) return parseCompactEngagementCount(`${match[1]}${match[2] || ''}`);
    }
    return null;
}
function getVisibleFollowerCountFromArticle(article) {
    if (!article) return null;
    const candidates = [
        article.textContent || '',
        ...Array.from(article.querySelectorAll('[aria-label], [title]')).flatMap((node) => [
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || ''
        ])
    ];
    for (const text of candidates) {
        const count = getVisibleFollowerCountFromText(text);
        if (count != null) return count;
    }
    return null;
}
function getCachedFollowerCount(screenName) {
    if (!screenName) return null;
    const cached = followerCountCache.get(screenName.toLowerCase());
    return cached && Date.now() - cached.at < FOLLOWER_COUNT_CACHE_MS ? cached.count : null;
}
function getVisibleOrCachedFollowerCount(article, screenName) {
    const visibleCount = getVisibleFollowerCountFromArticle(article);
    if (visibleCount != null) return visibleCount;
    return getCachedFollowerCount(screenName);
}
function isTwitterBlueColor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text === 'none' || text === 'currentcolor') return false;
    if (text === '#1d9bf0' || text === 'rgb(29, 155, 240)' || text === 'rgba(29, 155, 240, 1)') return true;
    const match = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    const [, r, g, b] = match.map(Number);
    return Math.abs(r - 29) <= 8 && Math.abs(g - 155) <= 10 && Math.abs(b - 240) <= 10;
}
function isBlueVerifiedUserElement(userElement) {
    if (!isBlueVerifiedExemptEnabled() || !userElement) return false;
    const candidates = [userElement, ...userElement.querySelectorAll('[aria-label], [data-testid], svg, path')];
    return candidates.some((node) => {
        const label = String(node.getAttribute?.('aria-label') || node.parentElement?.getAttribute?.('aria-label') || '').toLowerCase();
        const testId = String(node.getAttribute?.('data-testid') || node.parentElement?.getAttribute?.('data-testid') || '').toLowerCase();
        const hasVerifiedSignal = /verified|认证|已认证/.test(label) || /verified/.test(testId);
        if (!hasVerifiedSignal) return false;
        const style = getComputedStyle(node);
        const parentStyle = node.parentElement ? getComputedStyle(node.parentElement) : null;
        return [style.color, style.fill, style.stroke, parentStyle?.color, parentStyle?.fill, parentStyle?.stroke].some(isTwitterBlueColor);
    });
}
function isArticleBlueVerified(article) {
    return isBlueVerifiedUserElement(article?.querySelector('div[data-testid="User-Name"]'));
}
async function shouldExemptArticleByFollowerCount(article, reason) {
    const screenName = getArticleAuthorScreenName(article);
    if (!screenName) return false;
    const followerCount = getVisibleOrCachedFollowerCount(article, screenName);
    if (!isFollowerCountExempt(followerCount)) return false;
    console.log(`[CB] 跳过${reason || '自动标记'} @${screenName} (粉丝数 ${followerCount} 高于阈值 ${getUsernameRuleFollowerExemptThreshold()})`);
    return true;
}
function shouldExemptArticleByBlueVerified(article, reason) {
    if (!isStatusRootTweetArticle(article)) return false;
    if (!isArticleBlueVerified(article)) return false;
    const screenName = getArticleAuthorScreenName(article) || '未知';
    console.log(`[CB] 跳过${reason || '自动标记'} @${screenName} (蓝 V 主贴作者自动豁免)`);
    return true;
}
async function shouldExemptArticleByTrustedAuthor(article, reason) {
    if (shouldExemptArticleByBlueVerified(article, reason)) return true;
    return shouldExemptArticleByFollowerCount(article, reason);
}
async function maybeAutoBlockTarget(targetArticle, userNameText, screenName) {
    if (!userNameText) return;
    if (!isAutoNukeEnabled()) return;
    if (shouldExemptArticleByBlueVerified(targetArticle, 'auto_rule')) return;
    let decision = null;
    try {
        decision = await evaluateUsernameAutoBlock(userNameText, screenName);
    } catch (error) {
        if (isApiRateLimitError(error)) {
            showApiLimitRetryToast(error);
            return;
        }
        throw error;
    }
    if (!decision.block) {
        if (decision.reason === 'follower_exempt') {
            console.log(`[CB] 跳过常规用户名规则自动拉黑 @${screenName || '未知'} (粉丝数高于阈值 ${getUsernameRuleFollowerExemptThreshold()})`);
        }
        return;
    }
    if (screenName) {
        showAggregatedToast('nuke-auto-trigger-toast', '🤖 自动执行拉黑', `检测到可疑用户名: ${screenName}`, 4000);
    }
    void initiateNukeProcess(targetArticle, { triggerMode: 'auto', autoReason: decision.reason, suspiciousDisplayName: userNameText });
}
function normalizeTimelineUserResult(userResult) {
    let user = userResult;
    for (let i = 0; i < 4; i += 1) {
        if (!user || typeof user !== 'object') return null;
        if (user.rest_id || user.id_str || user.legacy?.id_str) return user;
        if (user.user) {
            user = user.user;
            continue;
        }
        if (user.result && user.result !== user) {
            user = user.result;
            continue;
        }
        break;
    }
    return user && typeof user === 'object' ? user : null;
}
function getTimelineUserRestId(userResult) {
    const user = normalizeTimelineUserResult(userResult);
    const id = user?.rest_id || user?.id_str || user?.legacy?.id_str || user?.id;
    return id ? String(id) : '';
}
function getUserScreenNameFromResult(userResult) {
    const user = normalizeTimelineUserResult(userResult);
    return normalizePromoHandle(user?.core?.screen_name || user?.legacy?.screen_name || user?.screen_name);
}
function getNormalizedUserIdentity(userResult) {
    const user = normalizeTimelineUserResult(userResult);
    const userId = getTimelineUserRestId(user);
    if (!user || !userId) return null;
    return {
        user: user.rest_id ? user : { ...user, rest_id: userId },
        userId,
        screenName: getUserScreenNameFromResult(user)
    };
}
function addTimelineUserResult(users, pageUsers, userResult) {
    const normalizedUser = normalizeTimelineUserResult(userResult);
    const userId = getTimelineUserRestId(normalizedUser);
    if (!userId || users.has(userId)) return false;
    const user = normalizedUser.rest_id ? normalizedUser : { ...normalizedUser, rest_id: userId };
    users.set(userId, user);
    pageUsers.push(user);
    return true;
}
function unwrapTimelineTweetResult(tweetResults) {
    let tweet = tweetResults?.result || tweetResults;
    for (let i = 0; i < 4; i += 1) {
        if (!tweet || typeof tweet !== 'object') return null;
        if (tweet.core?.user_results) return tweet;
        if (tweet.tweet) {
            tweet = tweet.tweet;
            continue;
        }
        if (tweet.result && tweet.result !== tweet) {
            tweet = tweet.result;
            continue;
        }
        break;
    }
    return tweet && typeof tweet === 'object' ? tweet : null;
}
function getUserResultFromTweetResults(tweetResults) {
    const tweet = unwrapTimelineTweetResult(tweetResults);
    return normalizeTimelineUserResult(tweet?.core?.user_results?.result);
}
async function getRetweetersData(tweetId, onProgress, onUsersPage) {
    let users = new Map(), cursor = null, endpoint = API_ENDPOINTS.Retweeters;
    do {
        onProgress(`正在获取转推列表...(已找到: ${users.size})`);
        const url = buildGraphqlUrl(endpoint, 'Retweeters', {tweetId,count:100,cursor,includePromotedContent:true});
        const data = await makeApiRequest(url);
        const entries = data?.data?.retweeters_timeline?.timeline?.instructions?.find(i=>i.type==='TimelineAddEntries')?.entries;
        if (!entries) break;
        let foundNewUsers = false;
        const pageUsers = [];
        for (const entry of entries) {
            if (entry.entryId.startsWith('user-')) {
                const userResult = entry.content?.itemContent?.user_results?.result;
                if (addTimelineUserResult(users, pageUsers, userResult)) foundNewUsers = true;
            } else if (entry.entryId.startsWith('cursor-bottom-')) { cursor = entry.content.value; }
        }
        if (pageUsers.length) await onUsersPage?.(pageUsers);
        if (!foundNewUsers || !cursor) break;
    } while (cursor);
    return Array.from(users.values());
}
async function getFavoritersData(tweetId, onProgress, onUsersPage) {
    let users = new Map(), cursor = null, endpoint = API_ENDPOINTS.Favoriters;
    do {
        onProgress(`正在获取点赞列表...(已找到: ${users.size})`);
        const url = buildGraphqlUrl(endpoint, 'Favoriters', {tweetId,count:100,cursor,includePromotedContent:true});
        const data = await makeApiRequest(url);
        const entries = data?.data?.favoriters_timeline?.timeline?.instructions?.find(i=>i.type==='TimelineAddEntries')?.entries;
        if (!entries) break;
        let foundNewUsers = false;
        const pageUsers = [];
        for (const entry of entries) {
            if (entry.entryId.startsWith('user-')) {
                const userResult = entry.content?.itemContent?.user_results?.result;
                if (addTimelineUserResult(users, pageUsers, userResult)) foundNewUsers = true;
            } else if (entry.entryId.startsWith('cursor-bottom-')) { cursor = entry.content.value; }
        }
        if (pageUsers.length) await onUsersPage?.(pageUsers);
        if (!foundNewUsers || !cursor) break;
    } while (cursor);
    return Array.from(users.values());
}
async function getRepliersData(tweetId, onProgress, onUsersPage) {
    let users = new Map(), cursor = null, endpoint = API_ENDPOINTS.TweetDetail;
    const baseVariables = {"with_rux_injections":false,"includePromotedContent":true,"withCommunity":true,"withQuickPromoteEligibilityTweetFields":true,"withBirdwatchNotes":true,"withVoice":true};
    do {
        onProgress(`正在获取回复列表...(已找到: ${users.size})`);
        const variables = {...baseVariables, focalTweetId: tweetId, cursor, count: 40, rankingMode:"Relevance"};
        const url = buildGraphqlUrl(endpoint, 'TweetDetail', variables);
        const data = await makeApiRequest(url);
        const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
        const entriesInstruction = instructions.find(i => i.type === 'TimelineAddEntries');
        const entries = entriesInstruction?.entries;
        if (!entries) break;
        let nextCursor = null;
        let foundNewUsersInPage = false;
        const pageUsers = [];
        for (const entry of entries) {
            if (entry.entryId.startsWith('conversationthread-')) {
                const threadItems = entry.content?.items;
                if(threadItems && Array.isArray(threadItems)){
                    for(const item of threadItems){
                        const userResult = getUserResultFromTweetResults(item.item?.itemContent?.tweet_results);
                        if (addTimelineUserResult(users, pageUsers, userResult)) foundNewUsersInPage = true;
                    }
                }
            } else if (entry.entryId.startsWith('tweet-')) {
                const userResult = getUserResultFromTweetResults(entry.content?.itemContent?.tweet_results);
                if (addTimelineUserResult(users, pageUsers, userResult)) foundNewUsersInPage = true;
            } else if (entry.entryId.startsWith('cursor-bottom-')) {
                nextCursor = entry.content.value;
            }
        }
        if (pageUsers.length) await onUsersPage?.(pageUsers);
        if (cursor === nextCursor || !foundNewUsersInPage) break;
        cursor = nextCursor;
    } while (cursor);
    return Array.from(users.values());
}
function markBlockAttemptStarted(userData, now = Date.now()) {
    if (!userData) return 0;
    userData.lastBlockTimestamp = now;
    return now;
}
async function blockUserById(userId, onStart = null) { return makeApiRequest("https://x.com/i/api/1.1/blocks/create.json", "POST", `user_id=${userId}`, onStart); }
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
    if (!Array.isArray(userData.pendingHiddenUsers)) userData.pendingHiddenUsers = [];
    if (!Array.isArray(userData.hiddenReleaseQueue)) userData.hiddenReleaseQueue = [];
    if (!Array.isArray(userData.nukeCaptures)) userData.nukeCaptures = [];
    if (!Array.isArray(userData.manualDetectedNukeTasks)) userData.manualDetectedNukeTasks = [];
    if (!Number.isFinite(Number(userData.lastBlockTimestamp))) userData.lastBlockTimestamp = 0;
    const releasedHiddenUsers = applyHiddenUserReleaseQueue(userData);
    const normalizedManualTasks = normalizeManualDetectedNukeTasks(userData);
    const discardedTerminalFailures = discardTerminalManualDetectedNukeFailures(userData);
    const backfilledRootProtection = backfillQueueRootAuthorProtection(userData);
    if (userData.spamIdentifyLog) {
        delete userData.spamIdentifyLog;
        allData[currentUserId] = userData;
        await GM_setValue(STORAGE_KEY, allData);
    } else if (releasedHiddenUsers > 0 || normalizedManualTasks > 0 || discardedTerminalFailures > 0 || backfilledRootProtection > 0) {
        allData[currentUserId] = userData;
        await GM_setValue(STORAGE_KEY, allData);
    }
    return userData;
}
async function saveUserData(data) {
    if (!currentUserId) return;
    const allData = await GM_getValue(STORAGE_KEY, {});
    allData[currentUserId] = data;
    await GM_setValue(STORAGE_KEY, allData);
}

// --- UI & FEEDBACK ---
function upsertUnifiedToastEntry(entries, entry, now = Date.now()) {
    const nextEntry = { ...entry, updatedAt: now };
    return [nextEntry, ...(entries || []).filter((item) => item?.id !== entry?.id)]
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}
function getUnifiedToastPanelPlacement(sidebarRect, viewportWidth = (typeof window !== 'undefined' ? window.innerWidth : 0), toggleRect = null, viewportHeight = (typeof window !== 'undefined' ? window.innerHeight : 0)) {
    const fallbackWidth = Math.min(360, Math.max(0, viewportWidth - 40));
    let placement = { right: 20, bottom: 20, width: fallbackWidth };
    const width = Number(sidebarRect?.width);
    const right = Number(sidebarRect?.right);
    if (Number.isFinite(width) && Number.isFinite(right) && Number.isFinite(viewportWidth) && width >= 280 && width <= 460 && right > viewportWidth * 0.5) {
        placement = { ...placement, right: Math.max(12, Math.round(viewportWidth - right)), width: Math.round(width) };
    }
    const toggleLeft = Number(toggleRect?.left);
    const toggleBottom = Number(toggleRect?.bottom);
    if (Number.isFinite(toggleLeft) && Number.isFinite(toggleBottom) && Number.isFinite(viewportWidth) && Number.isFinite(viewportHeight)) {
        placement.right = Math.max(12, Math.round(viewportWidth - toggleLeft + 12));
        placement.bottom = Math.max(12, Math.round(viewportHeight - toggleBottom));
        placement.width = Math.min(placement.width, Math.max(0, viewportWidth - placement.right - 12));
    }
    return placement;
}
function getUnifiedToastSidebarRect() {
    const candidates = [];
    document.querySelectorAll('[data-testid="sidebarColumn"], aside').forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width >= 280 && rect.width <= 460 && rect.height > 120 && rect.right > window.innerWidth * 0.5) {
            candidates.push(rect);
        }
    });
    return candidates.sort((left, right) => right.right - left.right || right.width - left.width)[0] || null;
}
function syncUnifiedToastPanelPlacement(panel = document.getElementById('nuke-toast-panel')) {
    if (!panel) return;
    const toggleRect = document.getElementById('nuke-toast-panel-toggle-button')?.getBoundingClientRect() || null;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const placement = getUnifiedToastPanelPlacement(getUnifiedToastSidebarRect(), viewportWidth, toggleRect, window.innerHeight);
    panel.style.setProperty('--nuke-toast-panel-right', `${placement.right}px`);
    panel.style.setProperty('--nuke-toast-panel-bottom', `${placement.bottom}px`);
    panel.style.setProperty('--nuke-toast-panel-width', `${placement.width}px`);
}
function bindUnifiedToastPanelPlacement() {
    if (unifiedToastPanelPlacementBound) return;
    unifiedToastPanelPlacementBound = true;
    window.addEventListener('resize', () => syncUnifiedToastPanelPlacement(), { passive: true });
}
function getUnifiedToastPanel() {
    let panel = document.getElementById('nuke-toast-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'nuke-toast-panel';
        panel.className = 'nuke-toast-panel-empty';
        panel.innerHTML = '<div class="nuke-toast-panel-list"></div>';
        document.body.appendChild(panel);
        bindUnifiedToastPanelPlacement();
    }
    panel.classList.toggle('nuke-toast-panel-collapsed', unifiedToastPanelCollapsed);
    ensureUnifiedToastPanelToggleButton();
    syncUnifiedToastPanelPlacement(panel);
    return panel;
}
function getUnifiedToastList() {
    const panel = getUnifiedToastPanel();
    let list = panel.querySelector('.nuke-toast-panel-list');
    if (!list) {
        list = document.createElement('div');
        list.className = 'nuke-toast-panel-list';
        panel.appendChild(list);
    }
    return list;
}
function layoutToasts() {
    const panel = document.getElementById('nuke-toast-panel');
    if (!panel) return;
    syncUnifiedToastPanelPlacement(panel);
    const hasVisibleToast = !!panel.querySelector('.nuke-toast:not(.fading-out)');
    panel.classList.toggle('nuke-toast-panel-empty', !hasVisibleToast);
}
function dismissToast(id) {
    const toast = document.getElementById(id);
    if (!toast) return;
    if (id === 'nuke-status-toast') clearQueueStatusCountdown();
    if (toast._nukeToastTimer) clearTimeout(toast._nukeToastTimer);
    if (toast._nukeToastRemoveTimer) clearTimeout(toast._nukeToastRemoveTimer);
    toast.remove();
    layoutToasts();
}
function trustedToastHtml(html) {
    return { __nukeTrustedToastHtml: String(html ?? '') };
}
function getToastContent(content) {
    if (content && typeof content === 'object' && typeof content.__nukeTrustedToastHtml === 'string') {
        return { html: content.__nukeTrustedToastHtml, text: '' };
    }
    return { html: null, text: String(content ?? '') };
}
function showToast(id, title, status, duration = null) {
    const list = getUnifiedToastList();
    let toast = Array.from(list.children).find((item) => item.id === id);
    if (!toast) {
        toast = document.createElement('div');
        toast.id = id;
        toast.className = 'nuke-toast';
        list.prepend(toast);
    }
    if (toast._nukeToastTimer) clearTimeout(toast._nukeToastTimer);
    if (toast._nukeToastRemoveTimer) clearTimeout(toast._nukeToastRemoveTimer);
    toast.classList.remove('fading-out');
    const titleEl = document.createElement('div');
    titleEl.className = 'nuke-toast-title';
    titleEl.textContent = String(title ?? '');
    const statusEl = document.createElement('div');
    statusEl.className = 'nuke-toast-status';
    const toastContent = getToastContent(status);
    if (toastContent.html === null) statusEl.textContent = toastContent.text;
    else statusEl.innerHTML = toastContent.html;
    toast.replaceChildren(titleEl, statusEl);
    list.prepend(toast);
    layoutToasts();
    if (duration) {
        toast._nukeToastTimer = setTimeout(() => {
            toast.classList.add('fading-out');
            toast._nukeToastRemoveTimer = setTimeout(() => {
                toast.remove();
                layoutToasts();
            }, 500);
        }, duration);
    }
}
function stripToastHtml(status) {
    return String(status ?? '').replace(/\s+/g, ' ').trim();
}
function showAggregatedToast(id, title, status, duration = 4000) {
    const now = Date.now();
    const state = aggregatedToastState.get(id) || { count: 0, lines: [], startedAt: now };
    if (now - state.startedAt > 15000) {
        state.count = 0;
        state.lines = [];
        state.startedAt = now;
    }
    state.count += 1;
    const line = stripToastHtml(status);
    if (line) state.lines = [line, ...state.lines.filter((item) => item !== line)].slice(0, 5);
    aggregatedToastState.set(id, state);
    const linesHtml = state.lines.map((item) => `<div class="nuke-aggregated-toast-line">${escapeHtml(item)}</div>`).join('');
    showToast(id, title, trustedToastHtml(`<div class="nuke-aggregated-toast-summary">本轮 ${state.count} 条操作</div>${linesHtml}`), duration);
}
function getNextQueueActionAt(userData, apiRateLimitState = null, now = Date.now(), blockIntervalMs = BLOCK_INTERVAL_MS) {
    const queue = userData?.queue || [];
    if (!queue.length) return 0;
    const lastBlockAt = Number(userData?.lastBlockTimestamp) || 0;
    const intervalReadyAt = lastBlockAt ? lastBlockAt + blockIntervalMs : now;
    const apiReadyAt = Number(apiRateLimitState?.retryAt) || now;
    const hasRunnableEntry = queue.some((entry) => !entry?.retryAfter || Number(entry.retryAfter) <= now);
    const retryTimes = queue.map((entry) => Number(entry?.retryAfter) || 0).filter((retryAt) => retryAt > now);
    const queueReadyAt = hasRunnableEntry || !retryTimes.length ? now : Math.min(...retryTimes);
    return Math.max(now, intervalReadyAt, apiReadyAt, queueReadyAt);
}
function formatQueueCountdown(nextActionAt, now = Date.now()) {
    const seconds = Math.max(0, Math.ceil((Number(nextActionAt) - now) / 1000));
    if (seconds <= 0) return '00:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    const clock = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock;
}
function clearQueueStatusCountdown() {
    if (queueStatusCountdownInterval) clearInterval(queueStatusCountdownInterval);
    queueStatusCountdownInterval = null;
}
function renderQueueStatusCountdown(nextActionAt) {
    const countdown = document.querySelector('#nuke-status-toast [data-nuke-queue-countdown]');
    if (!countdown) {
        clearQueueStatusCountdown();
        return;
    }
    countdown.textContent = ` · 下次 ${formatQueueCountdown(nextActionAt)}`;
}
function startQueueStatusCountdown(nextActionAt) {
    clearQueueStatusCountdown();
    renderQueueStatusCountdown(nextActionAt);
    queueStatusCountdownInterval = setInterval(() => renderQueueStatusCountdown(nextActionAt), 1000);
}
async function updateStatusToast() {
    const userData = await loadUserData();
    if (!userData || userData.queue.length === 0) {
        clearQueueStatusCountdown();
        let toast = document.getElementById('nuke-status-toast');
        if (toast) { toast.classList.add('fading-out'); setTimeout(() => toast.remove(), 500); }
        return;
    }
    const apiRateLimitState = await getActiveApiRateLimitState();
    const nextActionAt = getNextQueueActionAt(userData, apiRateLimitState);
    showToast('nuke-status-toast', '🚀 九族拉黑队列', trustedToastHtml(`<b>待处理:</b> ${userData.queue.length}<span data-nuke-queue-countdown></span>`));
    startQueueStatusCountdown(nextActionAt);
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

function isDirectManualRootQueueEntry(entry) {
    return entry?.blockReason === 'manual_author';
}
function isQueueEntryProtectedRootAuthor(entry) {
    if (!entry) return false;
    if (isDirectManualRootQueueEntry(entry)) return false;
    const entryHandle = normalizePromoHandle(entry.screenName);
    const sourceRootAuthorId = entry.sourceRootAuthorId ? String(entry.sourceRootAuthorId) : '';
    if (sourceRootAuthorId && String(entry.userId || '') === sourceRootAuthorId) return true;
    const sourceRootAuthorHandle = normalizePromoHandle(entry.sourceRootAuthorHandle);
    return !!(sourceRootAuthorHandle && entryHandle === sourceRootAuthorHandle);
}
function backfillQueueRootAuthorProtection(userData) {
    if (!userData || !Array.isArray(userData.queue)) return 0;
    const contextByTweetId = new Map();
    const addContext = (context) => {
        const tweetId = context?.tweetId ? String(context.tweetId) : '';
        if (!tweetId || (!context.rootAuthorId && !context.rootAuthorHandle)) return;
        const previous = contextByTweetId.get(tweetId) || {};
        contextByTweetId.set(tweetId, {
            ...previous,
            ...context,
            rootAuthorId: context.rootAuthorId || previous.rootAuthorId || null,
            rootAuthorHandle: context.rootAuthorHandle || previous.rootAuthorHandle || ''
        });
    };
    (userData.nukeCaptures || []).forEach((capture) => addContext(capture?.tweetContext));
    (userData.manualDetectedNukeTasks || []).forEach((task) => {
        (task?.captures || []).forEach((capture) => addContext({
            ...(capture?.tweetContext || {}),
            rootAuthorId: capture?.rootAuthorId || capture?.tweetContext?.rootAuthorId || null
        }));
    });
    let changed = 0;
    for (const entry of userData.queue) {
        if (isDirectManualRootQueueEntry(entry)) continue;
        const context = contextByTweetId.get(String(entry?.sourceTweetId || ''));
        if (!context) continue;
        let entryChanged = false;
        if (!entry.sourceRootAuthorId && context.rootAuthorId) {
            entry.sourceRootAuthorId = String(context.rootAuthorId);
            entryChanged = true;
        }
        if (!entry.sourceRootAuthorHandle && context.rootAuthorHandle) {
            entry.sourceRootAuthorHandle = normalizePromoHandle(context.rootAuthorHandle);
            entryChanged = true;
        }
        if (entryChanged) changed += 1;
    }
    return changed;
}
function getNukeQueueEntryPriority(entry) {
    const priority = Number(entry?.queuePriority);
    return Number.isFinite(priority) ? priority : 10;
}
function insertNukeQueueEntryByPriority(userData, entry, now = Date.now()) {
    if (!userData || !entry) return -1;
    if (!Array.isArray(userData.queue)) userData.queue = [];
    if (!Number.isFinite(Number(entry.queuedAt))) entry.queuedAt = now;
    const priority = getNukeQueueEntryPriority(entry);
    const index = userData.queue.findIndex((queued) => getNukeQueueEntryPriority(queued) > priority);
    if (index < 0) {
        userData.queue.push(entry);
        return userData.queue.length - 1;
    }
    userData.queue.splice(index, 0, entry);
    return index;
}
function getNextRunnableQueueEntryIndex(queue, now = Date.now()) {
    return (queue || []).findIndex((entry) => !entry?.retryAfter || Number(entry.retryAfter) <= now);
}
function isRetryableBlockError(error) {
    const status = Number(error?.status);
    if (isApiRateLimitError(error)) return false;
    if (isApiTimeoutError(error)) return true;
    if (!Number.isFinite(status) || status === 0) return true;
    return status >= 500;
}
function getBlockRetryDelayMs(attempt) {
    const exponent = Math.max(0, (Number(attempt) || 1) - 1);
    return Math.min(BLOCK_RETRY_MAX_MS, BLOCK_RETRY_BASE_MS * (2 ** exponent));
}
function scheduleBlockQueueRetry(entry, error, now = Date.now()) {
    if (!entry || !isRetryableBlockError(error)) return false;
    const nextAttempt = (Number(entry.blockAttempts) || 0) + 1;
    if (nextAttempt >= BLOCK_RETRY_MAX_ATTEMPTS) return false;
    entry.blockAttempts = nextAttempt;
    entry.retryAfter = now + getBlockRetryDelayMs(nextAttempt);
    entry.lastBlockError = String(error?.message || `HTTP ${error?.status || 'error'}`).slice(0, 160);
    return true;
}

function setBackgroundWorkerProbe(state) {
    try {
        document.documentElement.dataset.cbBackgroundWorker = state;
    } catch {
        /* probe only */
    }
}
function stopBackgroundWorkerRunners() {
    if (processIntervalId) clearInterval(processIntervalId);
    if (manualDetectedNukeResumeTimeoutId) clearTimeout(manualDetectedNukeResumeTimeoutId);
    processIntervalId = null;
    manualDetectedNukeResumeTimeoutId = null;
}
async function runBackgroundWorkerTick() {
    if (!backgroundWorkerLeader || backgroundWorkerTickRunning) return;
    backgroundWorkerTickRunning = true;
    try {
        await resumeManualDetectedNukeTasks();
        await processQueue();
    } finally {
        backgroundWorkerTickRunning = false;
    }
}
function startBackgroundWorkerRunners() {
    stopBackgroundWorkerRunners();
    processIntervalId = setInterval(() => { void runBackgroundWorkerTick(); }, PROCESS_CHECK_INTERVAL_MS);
    window.setTimeout(() => { void runBackgroundWorkerTick(); }, 1000);
}
function scheduleBackgroundWorkerLeadershipRetry(delay = PROCESS_CHECK_INTERVAL_MS) {
    if (backgroundWorkerRetryTimeoutId || backgroundWorkerLeader) return;
    backgroundWorkerRetryTimeoutId = window.setTimeout(() => {
        backgroundWorkerRetryTimeoutId = null;
        void requestBackgroundWorkerLeadership();
    }, delay);
}
async function requestBackgroundWorkerLeadership() {
    if (!currentUserId || backgroundWorkerLeader || backgroundWorkerLeadershipPending) return;
    if (!navigator.locks?.request) {
        backgroundWorkerLeader = true;
        setBackgroundWorkerProbe('leader-fallback');
        startBackgroundWorkerRunners();
        return;
    }
    backgroundWorkerLeadershipPending = true;
    setBackgroundWorkerProbe('standby');
    try {
        await navigator.locks.request(`${BACKGROUND_WORKER_LOCK_PREFIX}:${currentUserId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
            if (!lock) return;
            backgroundWorkerLeader = true;
            setBackgroundWorkerProbe('leader');
            startBackgroundWorkerRunners();
            await new Promise((resolve) => { backgroundWorkerRelease = resolve; });
            backgroundWorkerRelease = null;
            stopBackgroundWorkerRunners();
            backgroundWorkerLeader = false;
            setBackgroundWorkerProbe('standby');
        });
    } catch (error) {
        console.warn('[CB] 后台执行者选举失败，稍后重试', error);
    } finally {
        backgroundWorkerLeadershipPending = false;
        if (!backgroundWorkerLeader) scheduleBackgroundWorkerLeadershipRetry();
    }
}
function releaseBackgroundWorkerLeadership() {
    if (backgroundWorkerRetryTimeoutId) clearTimeout(backgroundWorkerRetryTimeoutId);
    backgroundWorkerRetryTimeoutId = null;
    backgroundWorkerRelease?.();
}

// --- CORE LOGIC ---
async function processQueue() {
    if (!backgroundWorkerLeader || isProcessingQueue || manualDetectedNukeRunning || !currentUserId) return;
    if (await getActiveApiRateLimitState()) return;
    const userData = await loadUserData();
    if (!userData || userData.queue.length === 0 || (Date.now() - userData.lastBlockTimestamp < BLOCK_INTERVAL_MS)) return;
    const queueIndex = getNextRunnableQueueEntryIndex(userData.queue);
    if (queueIndex < 0) return;
    isProcessingQueue = true;
    const userToBlock = userData.queue[queueIndex];
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
        if (isQueueEntryProtectedRootAuthor(userToBlock)) {
            console.warn(`[CB] 跳过队列中的主贴作者 @${userToBlock.screenName || userToBlock.userId}`);
            recordManualDetectedNukeQueueOutcome(userData, userToBlock, 'skipped');
            queueHiddenUserRelease(userData, userToBlock);
            applyHiddenUserReleaseQueue(userData);
            userData.queue.splice(queueIndex, 1);
            return;
        }
        await blockUserById(userToBlock.userId, () => markBlockAttemptStarted(userData));
        userData.queue.splice(queueIndex, 1);
        delete userToBlock.retryAfter;
        delete userToBlock.lastBlockError;
        recordManualDetectedNukeQueueOutcome(userData, userToBlock, 'blocked');
        userData.blockedLog.push({ ...userToBlock, blockTimestamp: Date.now(), blockNote: userToBlock.blockNote || '', blockReason: userToBlock.blockReason || '' });
        queueHiddenUserRelease(userData, userToBlock);
        applyHiddenUserReleaseQueue(userData);
        const limit = scriptConfig.blockLogLimit || 500;
        if (limit > 0) { while (userData.blockedLog.length > limit) userData.blockedLog.shift(); }
    } catch (error) {
        if (isApiRateLimitError(error)) {
            console.warn(`[Chain Blocker] API 已达上限，暂停队列拉黑 @${userToBlock.screenName || userToBlock.userId}.`, error);
            showApiLimitRetryToast(error);
        } else if (scheduleBlockQueueRetry(userToBlock, error)) {
            console.warn(`[Chain Blocker] 拉黑 @${userToBlock.screenName || userToBlock.userId} 暂时失败，将重试.`, error);
            showToast('nuke-status-toast', '拉黑任务稍后重试', `@${userToBlock.screenName || userToBlock.userId} 将在后台重试`, 4000);
        } else {
            console.error(`[Chain Blocker] 拉黑 @${userToBlock.screenName || userToBlock.userId} 失败，移除.`, error);
            recordManualDetectedNukeQueueOutcome(userData, userToBlock, 'discarded');
            userData.queue.splice(queueIndex, 1);
        }
    } finally {
        const completedTask = completeFinishedManualDetectedNukeTasks(userData);
        await saveUserData(userData);
        await updateStatusToast();
        if (completedTask) {
            showManualDetectedNukeTaskToast(completedTask, userData, 4500);
        } else {
            await updateManualDetectedNukeTaskToast(userData);
        }
        isProcessingQueue = false;
    }
}
function getArticleAuthorHandle(article) {
    const userLink = article?.querySelector?.('div[data-testid="User-Name"] a[role="link"]');
    return normalizePromoHandle(getScreenNameFromProfileHref(userLink?.href) || userLink?.href?.split('/')?.pop()?.split('?')?.[0] || '');
}
function getPendingHiddenHandleSet(userData) {
    return new Set((userData?.pendingHiddenUsers || []).map((entry) => normalizePromoHandle(entry.screenName)).filter(Boolean));
}
function hideArticlesByHandles(handles, articles = null) {
    if (!handles?.size) return 0;
    let hiddenCount = 0;
    const targets = articles || document.querySelectorAll('article[data-testid="tweet"]');
    Array.from(targets).forEach((article) => {
        const handle = getArticleAuthorHandle(article);
        if (!handle || !handles.has(handle)) return;
        article.dataset.cbPendingHiddenUser = handle;
        article.style.setProperty('display', 'none', 'important');
        hiddenCount += 1;
    });
    return hiddenCount;
}
function applyPendingHiddenUsersToPage(userData, articles = null) {
    return hideArticlesByHandles(getPendingHiddenHandleSet(userData), articles);
}
async function refreshPendingHiddenUsersOnPage() {
    const userData = await loadUserData();
    if (!userData) return 0;
    return applyPendingHiddenUsersToPage(userData);
}
function addPendingHiddenUsers(userData, entries) {
    if (!userData || !entries?.length) return [];
    const before = new Set((userData.pendingHiddenUsers || []).map(getHiddenUserStorageKey).filter(Boolean));
    userData.pendingHiddenUsers = mergePendingHiddenUserEntries(userData.pendingHiddenUsers, entries);
    return userData.pendingHiddenUsers.filter((entry) => !before.has(getHiddenUserStorageKey(entry)));
}
function recordNukeCapture(userData, capture) {
    if (!userData) return null;
    const now = Date.now();
    const entry = {
        captureId: capture.captureId || `${capture.tweetContext?.tweetId || capture.authorHandle || 'tweet'}:${now}`,
        authorHandle: normalizePromoHandle(capture.authorHandle),
        authorUserNameText: capture.authorUserNameText || capture.authorHandle || '',
        trigger: capture.trigger || {},
        tweetContext: capture.tweetContext || {},
        pageUrl: location.href,
        capturedAt: now
    };
    userData.nukeCaptures = [entry, ...(userData.nukeCaptures || []).filter((item) => item.captureId !== entry.captureId)].slice(0, NUKE_CAPTURE_LOG_LIMIT);
    return entry;
}
function getStatusRootTweetArticle() {
    if (!getCurrentStatusPageInfo().tweetId) return null;
    markStatusRootTweetArticles();
    const articles = Array.from(document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"], article[data-testid="tweet"]'));
    return articles.find((article) => article.dataset.cbSpamRootTweet === 'true') || null;
}
function getRootTweetAuthorHandle() {
    const info = getCurrentStatusPageInfo();
    if (!info.tweetId) return '';
    const rootArticle = getStatusRootTweetArticle();
    const articleHandle = getArticleAuthorHandle(rootArticle);
    if (articleHandle) {
        const rootTweetId = getArticleOwnStatusId(rootArticle) || statusRootTweetCache.rootTweetId || '';
        statusRootTweetCache = { pageTweetId: info.tweetId, rootTweetId, authorHandle: articleHandle };
        return articleHandle;
    }
    return statusRootTweetCache.pageTweetId === info.tweetId ? statusRootTweetCache.authorHandle : '';
}
function getChainExemptHandlesForTarget(targetArticle) {
    const rootAuthorHandle = getRootTweetAuthorHandle();
    const targetAuthorHandle = getArticleAuthorHandle(targetArticle);
    return rootAuthorHandle && rootAuthorHandle !== targetAuthorHandle ? [rootAuthorHandle] : [];
}
function isResolvedTargetRootAuthor(resolvedTarget) {
    const authorHandle = normalizePromoHandle(resolvedTarget?.authorHandle);
    const rootAuthorHandle = normalizePromoHandle(resolvedTarget?.rootAuthorHandle);
    if (authorHandle && rootAuthorHandle && authorHandle === rootAuthorHandle) return true;
    return !!(resolvedTarget?.authorId && resolvedTarget?.rootAuthorId && resolvedTarget.authorId === resolvedTarget.rootAuthorId);
}
function isDirectManualRootAuthorBlock(resolvedTarget) {
    return isResolvedTargetRootAuthor(resolvedTarget) && resolvedTarget?.trigger?.triggerMode === 'manual';
}
function buildChainSkipUserIds(resolvedTarget) {
    const ids = new Set();
    if (resolvedTarget?.authorId) ids.add(resolvedTarget.authorId);
    if (resolvedTarget?.rootAuthorId && resolvedTarget.rootAuthorId !== resolvedTarget.authorId) ids.add(resolvedTarget.rootAuthorId);
    return ids;
}
function removeProtectedAuthorsFromChainQueue(queueById, resolvedTarget) {
    if (!queueById) return;
    buildChainSkipUserIds(resolvedTarget).forEach((id) => queueById.delete(id));
    const protectedHandles = new Set([resolvedTarget?.authorHandle, resolvedTarget?.rootAuthorHandle].map(normalizePromoHandle).filter(Boolean));
    if (!protectedHandles.size) return;
    for (const [userId, entry] of queueById.entries()) {
        if (protectedHandles.has(normalizePromoHandle(entry?.screenName))) queueById.delete(userId);
    }
}
function mergeUserIdSets(sets = []) {
    const merged = new Set();
    sets.forEach((set) => {
        if (!set) return;
        Array.from(set).forEach((id) => {
            if (id) merged.add(id);
        });
    });
    return merged;
}
function captureNukeTargetForImmediateHide(targetArticle, trigger, userData, options = {}) {
    const userLink = targetArticle?.querySelector?.('div[data-testid="User-Name"] a[role="link"]');
    const authorHandle = getArticleAuthorHandle(targetArticle) || getScreenNameFromProfileHref(userLink?.href) || userLink?.href?.split('/').pop()?.split('?')[0];
    const authorUserNameText = targetArticle?.querySelector?.('div[data-testid="User-Name"] a[role="link"] span')?.textContent?.trim() || authorHandle;
    if (!authorHandle) throw new Error("无法确定作者 handle");
    const tweetContext = getTweetContextFromTarget(targetArticle, authorHandle);
    const rootAuthorHandle = getRootTweetAuthorHandle();
    tweetContext.rootAuthorHandle = rootAuthorHandle || '';
    const capture = recordNukeCapture(userData, { authorHandle, authorUserNameText, trigger, tweetContext });
    const isProtectedRoot = rootAuthorHandle && normalizePromoHandle(rootAuthorHandle) === normalizePromoHandle(authorHandle) && trigger?.triggerMode !== 'manual';
    if (!isProtectedRoot) {
        addPendingHiddenUsers(userData, [createPendingHiddenUserEntry({
            screenName: authorHandle,
            userNameText: authorUserNameText,
            sourceTweetId: tweetContext.tweetId,
            sourceTweetUrl: tweetContext.tweetUrl,
            sourceTweetText: tweetContext.tweetText,
            sourceAuthorHandle: tweetContext.authorHandle,
            blockReason: trigger?.autoReason || trigger?.triggerMode || 'nuke_capture',
            blockNote: `待拉黑·@${authorHandle}${formatTweetContextSuffix(tweetContext)}`
        }, tweetContext)]);
        if (!options.deferPageHide) hideArticlesByHandles(new Set([normalizePromoHandle(authorHandle)]));
    }
    return { capture, authorHandle, authorUserNameText, tweetContext, isProtectedRoot };
}
async function resolveNukeTarget(targetArticle, trigger) {
    const userLink = targetArticle.querySelector('div[data-testid="User-Name"] a[role="link"]');
    const authorHandle = getArticleAuthorHandle(targetArticle) || getScreenNameFromProfileHref(userLink?.href) || userLink?.href.split('/').pop()?.split('?')[0];
    const authorUserNameText = targetArticle.querySelector('div[data-testid="User-Name"] a[role="link"] span')?.textContent?.trim() || authorHandle;
    if (!authorHandle) throw new Error("无法确定作者 handle");
    const tweetContext = getTweetContextFromTarget(targetArticle, authorHandle);
    const rootAuthorHandle = getRootTweetAuthorHandle();
    let authorId = null;
    let rootAuthorId = null;
    try {
        const authorData = await getUserDataByScreenName(authorHandle);
        authorId = authorData?.rest_id || null;
        if (!authorId) throw new Error(`无法获取 @${authorHandle} 的用户ID`);
    } catch (authorError) {
        console.error(`[CB] 获取作者 @${authorHandle} 失败:`, authorError);
        if (isApiRateLimitError(authorError) || isApiTimeoutError(authorError)) throw authorError;
    }
    if (rootAuthorHandle && rootAuthorHandle === authorHandle) {
        rootAuthorId = authorId;
    } else if (rootAuthorHandle) {
        try {
            const rootAuthorData = await getUserDataByScreenName(rootAuthorHandle);
            rootAuthorId = rootAuthorData?.rest_id || null;
        } catch (rootAuthorError) {
            console.warn(`[CB] 获取主贴作者 @${rootAuthorHandle} 失败，将仅按 handle 豁免`, rootAuthorError);
            if (isApiRateLimitError(rootAuthorError) || isApiTimeoutError(rootAuthorError)) throw rootAuthorError;
        }
    }
    tweetContext.rootAuthorHandle = rootAuthorHandle || '';
    tweetContext.rootAuthorId = rootAuthorId || null;
    return { targetArticle, trigger, authorHandle, authorUserNameText, tweetContext, authorId, rootAuthorHandle, rootAuthorId, engagementCounts: getArticleEngagementCounts(targetArticle) };
}
function queueResolvedNukeAuthor(resolvedTarget, userData, whitelistIds, exemptHandles) {
    const { authorId, authorHandle } = resolvedTarget;
    if (!authorId) {
        console.error(`[CB] 作者 @${authorHandle} 入队失败:`, new Error("无法获取作者用户ID"));
        return false;
    }
    if (isResolvedTargetRootAuthor(resolvedTarget) && !isDirectManualRootAuthorBlock(resolvedTarget)) {
        console.warn(`[CB] 跳过主贴作者 @${authorHandle}：非直接手动主贴操作`);
        queueHiddenUserRelease(userData, { userId: authorId, screenName: authorHandle });
        applyHiddenUserReleaseQueue(userData);
        showToast('nuke-fetch-toast', '🛡️ 已跳过主贴作者', `非直接手动操作，不拉黑 @${authorHandle}`, 4000);
        return false;
    }
    const normalizedHandle = normalizePromoHandle(authorHandle);
    if (whitelistIds.has(authorId) || (exemptHandles || []).map(normalizePromoHandle).includes(normalizedHandle)) {
        queueHiddenUserRelease(userData, { userId: authorId, screenName: authorHandle });
        applyHiddenUserReleaseQueue(userData);
        showToast('nuke-fetch-toast', '🛡️ 用户在白名单或豁免列表', `已跳过 @${authorHandle}`, 4000);
        return false;
    }
    const entry = createAuthorQueueEntry(resolvedTarget);
    if (isQueueEntryDiscardedForLinkedTask(userData, entry)) return false;
    const existingQueueEntry = userData.queue.find((item) => item.userId === authorId);
    if (existingQueueEntry) {
        attachNukeTaskIdsToEntry(existingQueueEntry, getEntryNukeTaskIds(entry));
        recordManualDetectedNukeQueueOutcome(userData, existingQueueEntry, 'queued');
        return false;
    }
    const existingBlockedEntry = userData.blockedLog.find((item) => item.userId === authorId);
    if (existingBlockedEntry) {
        attachNukeTaskIdsToEntry(existingBlockedEntry, getEntryNukeTaskIds(entry));
        recordManualDetectedNukeQueueOutcome(userData, existingBlockedEntry, 'blocked');
        return false;
    }
    if (authorId === currentUserId) return false;
    insertNukeQueueEntryByPriority(userData, entry);
    recordManualDetectedNukeQueueOutcome(userData, entry, 'queued');
    addPendingHiddenUsers(userData, [createPendingHiddenUserEntry(entry, resolvedTarget.tweetContext)]);
    applyPendingHiddenUsersToPage(userData);
    return true;
}
async function collectChainUsersForResolvedTarget(resolvedTarget, userData, whitelistIds, exemptHandles, onCollectProgress, onCollectFailure, onApiUsersPage) {
    const { tweetContext } = resolvedTarget;
    const tweetId = tweetContext.tweetId;
    if (!tweetId) return 0;
    let totalQueued = 0;
    const skipUserIds = buildChainSkipUserIds(resolvedTarget);
    const persistUsersPage = async (users, chainSource) => {
        onApiUsersPage?.(users, chainSource);
        const queueById = new Map();
        addUsersToChainQueue(queueById, users, chainSource, tweetContext);
        removeProtectedAuthorsFromChainQueue(queueById, resolvedTarget);
        const newUsers = addNewChainQueueEntries(userData, queueById, whitelistIds, exemptHandles, skipUserIds);
        if (!newUsers.length) return;
        totalQueued += newUsers.length;
        await saveUserData(userData);
        await updateStatusToast();
    };
    const collect = async (label, chainSource, getter) => {
        if (!shouldCollectChainSourceFromCounts(resolvedTarget.engagementCounts, chainSource)) {
            onCollectProgress?.(`${label}为 0，跳过 API 请求`);
            return;
        }
        try {
            await getter(tweetId, onCollectProgress, (users) => persistUsersPage(users, chainSource));
        } catch (error) {
            skipFailedChainList(label, onCollectFailure)(error);
            if (isApiRateLimitError(error) || isApiTimeoutError(error)) throw error;
        }
    };
    await collect('转推列表', 'retweet', getRetweetersData);
    await collect('回复列表', 'reply', getRepliersData);
    await collect('点赞列表', 'like', getFavoritersData);
    return totalQueued;
}
function isQueueEntryDiscardedForLinkedTask(userData, entry) {
    const userId = String(entry?.userId || '');
    const taskIds = getEntryNukeTaskIds(entry);
    if (!userId || !taskIds.length) return false;
    const tasksById = new Map((userData?.manualDetectedNukeTasks || []).map((task) => [String(task?.taskId || ''), task]));
    return taskIds.every((taskId) => {
        const task = tasksById.get(taskId);
        return task && normalizeNukeTaskIds(task.discardedUserIds).includes(userId);
    });
}
function selectNewChainQueueEntries(userData, queueById, whitelistIds, exemptHandles, skipUserIds = new Set()) {
    const existingUserIds = new Set([...userData.queue.map(u => u.userId), ...userData.blockedLog.map(u => u.userId), ...whitelistIds, ...skipUserIds]);
    const exemptHandleSet = new Set((exemptHandles || []).map(normalizePromoHandle).filter(Boolean));
    return Array.from(queueById.values()).filter(u => u.userId && u.userId !== currentUserId && !existingUserIds.has(u.userId) && !exemptHandleSet.has(normalizePromoHandle(u.screenName)) && !isQueueEntryDiscardedForLinkedTask(userData, u));
}
function addNewChainQueueEntries(userData, queueById, whitelistIds, exemptHandles, skipUserIds = new Set()) {
    for (const incomingEntry of queueById.values()) {
        const existingQueueEntry = userData.queue.find((entry) => entry.userId === incomingEntry.userId);
        if (existingQueueEntry) {
            attachNukeTaskIdsToEntry(existingQueueEntry, getEntryNukeTaskIds(incomingEntry));
            recordManualDetectedNukeQueueOutcome(userData, existingQueueEntry, 'queued');
        }
        const existingBlockedEntry = userData.blockedLog.find((entry) => entry.userId === incomingEntry.userId);
        if (existingBlockedEntry) {
            attachNukeTaskIdsToEntry(existingBlockedEntry, getEntryNukeTaskIds(incomingEntry));
            recordManualDetectedNukeQueueOutcome(userData, existingBlockedEntry, 'blocked');
        }
    }
    const newUsersToQueue = selectNewChainQueueEntries(userData, queueById, whitelistIds, exemptHandles, skipUserIds);
    if (newUsersToQueue.length > 0) {
        newUsersToQueue.forEach((entry) => insertNukeQueueEntryByPriority(userData, entry));
        newUsersToQueue.forEach((entry) => recordManualDetectedNukeQueueOutcome(userData, entry, 'queued'));
        addPendingHiddenUsers(userData, newUsersToQueue.map((entry) => createPendingHiddenUserEntry(entry)));
        applyPendingHiddenUsersToPage(userData);
    }
    return newUsersToQueue;
}
async function initiateNukeProcess(targetArticle, trigger = { triggerMode: 'manual' }) {
    showToast('nuke-fetch-toast', '🚀 九族拉黑已启动', '已记录目标并本地隐藏，后台慢慢处理...', null);
    try {
        const userData = await loadUserData();
        if (!userData) throw new Error("无法加载用户数据");
        captureNukeTargetForImmediateHide(targetArticle, trigger, userData);
        await saveUserData(userData);
        const whitelistIds = new Set(userData.whitelist.map(u => u.userId));
        const resolvedTarget = await resolveNukeTarget(targetArticle, trigger);
        const authorQueued = queueResolvedNukeAuthor(resolvedTarget, userData, whitelistIds, []);
        await saveUserData(userData);
        const chainExemptHandles = getChainExemptHandlesForTarget(resolvedTarget.targetArticle);
        await processPromoMentionsFromArticle(targetArticle, resolvedTarget.tweetContext, userData, resolvedTarget.authorHandle, whitelistIds, chainExemptHandles);
        if (!resolvedTarget.tweetContext.tweetId) return;
        const onCollectProgress = status => showToast('nuke-fetch-toast', '收集中...', status, null);
        const queuedChainUsers = await collectChainUsersForResolvedTarget(resolvedTarget, userData, whitelistIds, chainExemptHandles, onCollectProgress);
        if (authorQueued || queuedChainUsers > 0) {
            await saveUserData(userData);
            showToast('nuke-fetch-toast', '✅ 已加入后台队列', `作者${authorQueued ? '已' : '未'}入队，关联用户新增 ${queuedChainUsers} 个。`, 4000);
        } else {
            showToast('nuke-fetch-toast', 'ℹ️ 操作完成', `没有找到新的可拉黑用户。`, 4000);
        }
        await updateStatusToast();
        setTimeout(processQueue, 1000);
    } catch (error) {
        console.error("[CB] 收集过程中发生错误:", error);
        if (isApiRateLimitError(error)) {
            showApiLimitRetryToast(error);
            showToast(`nuke-fetch-toast`, 'API 已达上限', '已暂停本次九族拉黑，等待恢复后可重试', 5000);
        } else {
            showToast(`nuke-fetch-toast`, '❌ 发生错误', error.message, 5000);
        }
    }
}

// --- UI SCANNING & AUTOMATION ---
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
async function evaluateUsernameAutoBlock(userNameText, screenName, followerCount = null) {
    const needsFollowerCheck = matchesStandardKeywords(userNameText, scriptConfig.blockKeywordsStandard || []) || matchesBuiltInDisplayNameSpam(userNameText);
    const countForDecision = needsFollowerCheck && followerCount == null && screenName ? getCachedFollowerCount(screenName) : followerCount;
    return getAutoBlockDecision(userNameText, countForDecision);
}
function getAutoBlockRuleLabel(reason) {
    if (reason === 'standard_keywords') return '用户名关键词';
    if (reason === 'display_name_spam') return '昵称引流';
    if (reason === 'promo_target_mention') return '引流目标';
    return '自动规则';
}
async function processAutoBlockArticle(article, userData) {
    if (article.dataset.autoblockTriggered === 'true') return;
    const userLink = article.querySelector('div[data-testid="User-Name"] a[role="link"]');
    const userNameText = getDisplayNameFromUserLink(userLink);
    const screenName = getScreenNameFromProfileHref(userLink?.href);
    const tweetText = getTweetTextFromArticle(article);

    if (shouldExemptArticleByBlueVerified(article, 'auto_rule')) {
        article.dataset.autoblockChecked = 'complete';
        return;
    }

    if (userNameText) {
        let decision = null;
        try {
            decision = await evaluateUsernameAutoBlock(userNameText, screenName, getVisibleOrCachedFollowerCount(article, screenName));
        } catch (error) {
            if (isApiRateLimitError(error)) {
                showApiLimitRetryToast(error);
                return;
            }
            throw error;
        }
        if (decision.block) {
            const label = getAutoBlockRuleLabel(decision.reason);
            if (isStatusRootTweetArticle(article)) {
                markArticleForAutoRule(article, label, `命中${label}: ${userNameText}`);
                article.dataset.autoblockChecked = 'complete';
                return;
            }
            if (!isAutoNukeEnabled()) {
                markArticleForAutoRule(article, label, `命中${label}: ${userNameText}`);
                article.dataset.autoblockChecked = 'complete';
                return;
            }
            if (screenName) {
                showAggregatedToast('nuke-auto-trigger-toast', '🤖 自动执行拉黑', `检测到可疑用户名: ${screenName}`, 4000);
            }
            triggerAutoNukeForMarkedArticle(article, { triggerMode: 'auto', autoReason: decision.reason, suspiciousDisplayName: userNameText });
            return;
        }
        if (decision.reason === 'follower_exempt') {
            console.log(`[CB] 跳过auto_rule @${screenName || '未知'} (粉丝数 ${decision.followerCount} 高于阈值 ${decision.exemptThreshold})`);
        }
    }

    if (isStatusRootTweetArticle(article)) {
        article.dataset.autoblockChecked = 'complete';
        return;
    }

    if (tweetText && userData?.promoTargets?.length) {
        const matched = getMatchedPromoTargetInTweet(tweetText, userData.promoTargets);
        if (matched) {
            if (!isAutoNukeEnabled()) {
                markArticleForAutoRule(article, `引流目标 @${matched}`, `推文提及引流目标 @${matched}`);
                article.dataset.autoblockChecked = 'complete';
                return;
            }
            triggerAutoNukeForMarkedArticle(article, {
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
async function scanAndProcessContent(articles = []) {
    if (!shouldRunArticleDetectionScans()) {
        ensureManualDetectedNukeButton();
        return;
    }
    if (!currentUserId) return;
    const connectedArticles = (articles || []).filter((article) => article?.isConnected);
    const userData = await loadUserData();
    if (!userData) return;
    applyPendingHiddenUsersToPage(userData, connectedArticles);
    await Promise.allSettled(connectedArticles
        .filter((article) => !article.dataset.autoblockChecked)
        .map((article) => processAutoBlockArticle(article, userData)));
    if (!isAutoNukeEnabled()) {
        ensureManualDetectedNukeButton();
        return;
    }
    document.querySelectorAll('div[data-testid="cellInnerDiv"]:not([style*="display: none"]) button[data-testid$="-unblock"]').forEach(btn => btn.closest('div[data-testid="cellInnerDiv"]').style.display = 'none');
    const userCells = Array.from(document.querySelectorAll('div[data-testid="UserCell"]:not([data-autoblock-checked])'));
    await Promise.allSettled(userCells.map(async (cell) => {
        cell.dataset.autoblockChecked = 'true';
        const userLink = cell.querySelector('a[role="link"]');
        const userNameText = getDisplayNameFromUserLink(userLink);
        const screenName = getScreenNameFromProfileHref(userLink?.href) || cell.querySelector('a[role="link"] span')?.textContent.trim() || '';
        await maybeAutoBlockTarget(cell.closest('div[data-testid="cellInnerDiv"]'), userNameText, screenName);
    }));
    ensureManualDetectedNukeButton();
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
    const svgIcon = nukeButton.querySelector('svg');
    if (svgIcon) {
        svgIcon.innerHTML = `<g><path d="${NUKE_ICON_PATH}" fill="currentColor"></path></g>`;
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
        const engine = normalizeAvatarOcrEngine(detail.engine);
        if (getAvatarOcrEngine() !== engine) {
            avatarOcrCache.clear();
            resetAvatarOcrRuntime();
            resetAvatarOcrArticleMarkers();
        }
        scriptConfig.spamAvatarOcrEngine = engine;
        delete scriptConfig.spamAvatarOcrEnabled;
        void saveConfig(scriptConfig).then(() => scheduleDetectionScan(true, 0));
        return;
    }
    if (detail.action === 'manualNukeDetected') {
        void executeManualNukeForDetectedTargets();
    }
    if (detail.action === 'toastAggregate') {
        showAggregatedToast('nuke-auto-trigger-toast', '🤖 自动执行拉黑', detail.status || '调试聚合提示', 5000);
    }
}
function exposePageSpamProbe() {
    try {
        installInternalConfigTrigger();
        document.documentElement.dataset.cbSpamProbeReady = '1';
        getPageWindow().__cbSpamProbe = {
            openConfig: () => {
                document.dispatchEvent(new CustomEvent('cb-spam-probe', { detail: { action: 'openConfig' } }));
            },
            switchEngine: (engine) => {
                document.dispatchEvent(new CustomEvent('cb-spam-probe', { detail: { action: 'switchEngine', engine } }));
            },
            saveEngine: (engine) => {
                document.dispatchEvent(new CustomEvent('cb-spam-probe', { detail: { action: 'saveEngine', engine } }));
            },
            manualNukeDetected: () => {
                document.dispatchEvent(new CustomEvent('cb-spam-probe', { detail: { action: 'manualNukeDetected' } }));
            },
            toastAggregate: (status) => {
                document.dispatchEvent(new CustomEvent('cb-spam-probe', { detail: { action: 'toastAggregate', status } }));
            }
        };
    } catch {
        /* ignore */
    }
}

// --- INITIALIZATION & EXECUTION ---
async function initialize() {
    if (initializeRunning) return;
    initializeRunning = true;
    try {
        if (!handleUserscriptBuildRerun()) return;
        await ensureUserscriptBootstrap();
        const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        if (!profileLink) {
            scheduleInitializeRetry();
            return;
        }
        if (!currentUserId) {
            const profileScreenName = normalizePromoHandle(getScreenNameFromProfileHref(profileLink.href));
            let identity = {
                userId: parseTwidUserId(),
                screenName: profileScreenName
            };
            if (!identity.userId || !identity.screenName) {
                const user = await getUserDataByScreenName(profileScreenName);
                const apiIdentity = getNormalizedUserIdentity(user);
                identity = {
                    userId: identity.userId || apiIdentity?.userId || '',
                    screenName: identity.screenName || apiIdentity?.screenName || ''
                };
            }
            if (!identity.userId) throw new Error('无法确定当前登录用户 ID');
            currentUserId = identity.userId;
            currentUserScreenName = identity.screenName || profileScreenName || 'unknown';
            console.log(`[Chain Blocker] Initialized for @${currentUserScreenName}(ID: ${currentUserId}).`);
        }
        await clearExpiredApiRateLimitState();
        const apiRateLimitState = await getActiveApiRateLimitState();
        if (apiRateLimitState) {
            showApiLimitRetryToast(buildApiRateLimitError(apiRateLimitState));
        } else {
            clearApiLimitTimers();
            dismissToast('nuke-api-limit-toast');
        }
        await updateStatusToast();
        ensureManualDetectedNukeButton();
        const debugConfigTriggerEnabled = shouldShowDebugConfigTrigger();
        if (debugConfigTriggerEnabled) {
            document.documentElement.dataset.cbSpamDebugMode = '1';
        } else {
            delete document.documentElement.dataset.cbSpamDebugMode;
        }
        scheduleDetectionScan(true, 0);
        void requestBackgroundWorkerLeadership();
    } catch (error) {
        if (isApiRateLimitError(error)) {
            console.warn(`[CB] API rate limit hit. Retrying in ${API_RETRY_DELAY_MS / 60000} minutes.`);
            showApiLimitRetryToast(error);
        } else { console.error("[CB] Initialization failed.", error); }
    } finally {
        initializeRunning = false;
    }
}
const observer = new MutationObserver(mutations => {
    let queuedArticles = 0;
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
                    if (shouldRunArticleDetectionScans()) queuedArticles += queueDetectionArticlesFromNode(node);
                }
            });
        }
    }
    if (queuedArticles > 0) scheduleSpamRescanDebounced();
});
document.addEventListener('click', e => {
    const optionsButton = e.target.closest('button[data-testid="caret"]');
    if (optionsButton) activeTweetArticle = optionsButton.closest('article[data-testid="tweet"]');
    const expandControl = e.target.closest('[role="button"], button, a, div[tabindex="0"]');
    if (expandControl && isSpamSectionExpandControl(expandControl)) scheduleSpamRescan();
}, true);
document.addEventListener('pointerdown', noteAvatarOcrUserActivity, { capture: true, passive: true });
document.addEventListener('keydown', noteAvatarOcrUserActivity, true);
window.addEventListener('scroll', noteAvatarOcrUserActivity, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        noteAvatarOcrUserActivity();
        return;
    }
    resumeDeferredProfileBioArticles();
    resumeDeferredAvatarOcrArticles();
    scheduleAvatarOcrPumpResume(100);
});
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('pagehide', releaseBackgroundWorkerLeadership, { once: true });
setInterval(() => {
    if (!shouldRunArticleDetectionScans()) {
        ensureManualDetectedNukeButton();
        return;
    }
    const currentPath = window.location.pathname;
    const pathChanged = detectionScanPath !== currentPath;
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => queueDetectionArticle(article));
    if (pathChanged || pendingDetectionArticles.size) scheduleDetectionScan(pathChanged, 0);
}, DETECTION_SAFETY_INTERVAL_MS);
initialize();
})();
