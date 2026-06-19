// ==UserScript==
// @name         Lianjia Rent Assistant
// @name:zh-CN   链家租房助手
// @namespace    http://tampermonkey.net/
// @version      0.5.18
// @description  Enhance Lianjia rent pages with helper controls and listing tools.
// @description:zh-CN 增强链家租房列表页，提供筛选辅助和房源工具。
// @author       codex
// @license      MIT
// @match        https://*.lianjia.com/ditiezufang/
// @match        https://*.lianjia.com/ditiezufang/*
// @match        https://*.lianjia.com/zufang/
// @match        https://*.lianjia.com/zufang/*
// @match        https://*.lianjia.com/apartment/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==
(function () {
'use strict';

const SCRIPT_VERSION = '0.5.18';
const STORAGE_KEY = 'LIANJIA_RENT_CONTENT_FILTER_STATE';
const MAP_CACHE_STORAGE_KEY = 'LIANJIA_RENT_MAP_LISTING_CACHE';
const AUTO_FETCH_STORAGE_KEY = 'LIANJIA_RENT_MAP_AUTO_FETCH_STATE';
const TIMING_SETTINGS_STORAGE_KEY = 'LIANJIA_RENT_TIMING_SETTINGS';
const COORDINATE_SOURCE_STORAGE_KEY = 'LIANJIA_RENT_COORDINATE_SOURCE';
const MAP_CACHE_VERSION = 1;
const CONTENT_FILTER_HOST_LABEL = '品牌';
const STREAM_LOAD_THRESHOLD_PX = 900;
const BAIDU_MAP_AK = 'djAasQ167kYWRGbjL2az8aGmHBUmXp4V';
const MAP_DETAIL_FETCH_LIMIT = 1;
const MAP_DETAIL_FETCH_DELAY_MS = 4000;
const MAP_DETAIL_FETCH_TIMEOUT_MS = 10000;
const AUTO_FETCH_PAGE_DELAY_MS = 4000;
const CAPTCHA_RETRY_DELAY_MS = 20000;
const MAX_AUTO_FETCH_RETRY_COUNT = 99;
const COORDINATE_SOURCE_GEOCODE = 'geocode';
const COORDINATE_SOURCE_FETCH = 'fetch';
const COORDINATE_SOURCE_TAB = 'tab';
const COORDINATE_SOURCE_IFRAME = 'iframe';
const COORDINATE_SOURCE_CASCADE = 'cascade';
const DEFAULT_COORDINATE_SOURCE = COORDINATE_SOURCE_GEOCODE;
const COORDINATE_SOURCE_OPTIONS = Object.freeze([
    { value: COORDINATE_SOURCE_GEOCODE, label: '地理编码' },
    { value: COORDINATE_SOURCE_FETCH, label: 'fetch' },
    { value: COORDINATE_SOURCE_TAB, label: '后台标签' },
    { value: COORDINATE_SOURCE_IFRAME, label: 'iframe' },
    { value: COORDINATE_SOURCE_CASCADE, label: '级联模式' }
]);
const CASCADE_COORDINATE_SOURCES = Object.freeze([
    COORDINATE_SOURCE_GEOCODE,
    COORDINATE_SOURCE_IFRAME,
    COORDINATE_SOURCE_TAB,
    COORDINATE_SOURCE_FETCH
]);
const DEFAULT_FILTER_STATE = Object.freeze({
    beikePreferred: true,
    apartment: true,
    guessYouLike: true
});
const DEFAULT_TIMING_SETTINGS = Object.freeze({
    autoFetchPageDelayMs: AUTO_FETCH_PAGE_DELAY_MS,
    mapDetailFetchDelayMs: MAP_DETAIL_FETCH_DELAY_MS,
    captchaRetryDelayMs: CAPTCHA_RETRY_DELAY_MS
});
const streamState = {
    initialized: false,
    loading: false,
    list: null,
    pager: null,
    status: null,
    observer: null,
    nextPage: 0,
    totalPage: 0,
    pageUrlTemplate: '',
    seenKeys: new Set()
};
const mapState = {
    initialized: false,
    panel: null,
    canvas: null,
    status: null,
    map: null,
    mapScriptPromise: null,
    mapReadyPromise: null,
    autoFetchControl: null,
    autoFetchStatus: null,
    autoFetchState: null,
    autoFetchLoading: false,
    autoFetchTimer: 0,
    autoFetchCountdownTimer: 0,
    timingSettings: null,
    timingSettingsPanel: null,
    coordinateSource: null,
    queuedKeys: new Set(),
    fetchedListings: new Map(),
    failedKeys: new Set(),
    previewImageLoadingKeys: new Set(),
    previewImageFailedKeys: new Set(),
    activeFetches: 0,
    mapQueueTimer: 0,
    lastMapFetchFinishedAt: 0,
    pendingRecords: [],
    blocked: false,
    cache: null
};

function normalizeFilterState(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        beikePreferred: source.beikePreferred !== false,
        apartment: source.apartment !== false,
        guessYouLike: source.guessYouLike !== false
    };
}

function serializeFilterState(state) {
    return JSON.stringify(normalizeFilterState(state));
}

function classifyListingContent(listing) {
    const text = String(listing?.text || '');
    const hrefs = Array.isArray(listing?.hrefs) ? listing.hrefs : [];
    return {
        beikePreferred: /贝壳优选/.test(text),
        apartment: /公寓/.test(text) || hrefs.some((href) => /\/apartment\//.test(String(href || ''))),
        guessYouLike: listing?.guessYouLike === true
    };
}

function shouldShowListing(kinds, state) {
    const filters = normalizeFilterState(state);
    return (filters.beikePreferred || !kinds.beikePreferred)
        && (filters.apartment || !kinds.apartment)
        && (filters.guessYouLike || !kinds.guessYouLike);
}

function normalizeListingKinds(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        beikePreferred: value.beikePreferred === true,
        apartment: value.apartment === true,
        guessYouLike: value.guessYouLike === true
    };
}

function normalizeAutoFetchState(value) {
    let source = value;
    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch {
            source = {};
        }
    }

    const progress = {};
    const rawProgress = source?.progress && typeof source.progress === 'object' ? source.progress : {};
    Object.entries(rawProgress).forEach(([key, page]) => {
        const pageNumber = Number.parseInt(page, 10);
        if (key && Number.isFinite(pageNumber) && pageNumber > 0) {
            progress[key] = pageNumber;
        }
    });
    const retryCount = Number.parseInt(source?.retryCount, 10);
    const state = {
        enabled: source?.enabled === true,
        progress
    };
    if (Number.isFinite(retryCount) && retryCount > 0) {
        state.retryCount = retryCount;
    }
    return state;
}

function normalizeDelayMs(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function normalizeTimingSettings(value) {
    let source = value;
    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch {
            source = {};
        }
    }

    return {
        autoFetchPageDelayMs: normalizeDelayMs(source?.autoFetchPageDelayMs, DEFAULT_TIMING_SETTINGS.autoFetchPageDelayMs),
        mapDetailFetchDelayMs: normalizeDelayMs(source?.mapDetailFetchDelayMs, DEFAULT_TIMING_SETTINGS.mapDetailFetchDelayMs),
        captchaRetryDelayMs: normalizeDelayMs(source?.captchaRetryDelayMs, DEFAULT_TIMING_SETTINGS.captchaRetryDelayMs)
    };
}

function serializeTimingSettings(settings) {
    return JSON.stringify(normalizeTimingSettings(settings));
}

function getAutoFetchPageDelay(settings = DEFAULT_TIMING_SETTINGS, multiplier = 1) {
    const factor = normalizeDelayMs(multiplier, 1);
    return normalizeTimingSettings(settings).autoFetchPageDelayMs * factor;
}

function getMapDetailFetchDelay(settings = DEFAULT_TIMING_SETTINGS) {
    return normalizeTimingSettings(settings).mapDetailFetchDelayMs;
}

function getCaptchaRetryDelay(settings = DEFAULT_TIMING_SETTINGS) {
    return normalizeTimingSettings(settings).captchaRetryDelayMs;
}

function normalizeCoordinateSource(value) {
    const source = String(value || '').trim();
    return COORDINATE_SOURCE_OPTIONS.some((option) => option.value === source) ? source : DEFAULT_COORDINATE_SOURCE;
}

function getCoordinateSourceSequence(source) {
    const normalized = normalizeCoordinateSource(source);
    return normalized === COORDINATE_SOURCE_CASCADE ? Array.from(CASCADE_COORDINATE_SOURCES) : [normalized];
}

function getAutoFetchNextPage(state, searchKey, currentPage, totalPage) {
    const normalized = normalizeAutoFetchState(state);
    const current = parsePositiveInteger(currentPage);
    const total = parsePositiveInteger(totalPage);
    const fetched = parsePositiveInteger(normalized.progress[searchKey]);
    const baseline = Math.max(current, fetched);
    return total && baseline < total ? baseline + 1 : 0;
}

function markAutoFetchPageFetched(state, searchKey, page) {
    const normalized = normalizeAutoFetchState(state);
    const pageNumber = parsePositiveInteger(page);
    if (!searchKey || !pageNumber) return normalized;
    normalized.progress[searchKey] = Math.max(parsePositiveInteger(normalized.progress[searchKey]), pageNumber);
    return normalized;
}

function getAutoFetchRetryDelay(state, settings = DEFAULT_TIMING_SETTINGS) {
    return getCaptchaRetryDelay(settings);
}

function getAutoFetchRetryStatusText(remainingMs) {
    const seconds = Math.ceil(Math.max(0, Number(remainingMs) || 0) / 1000);
    return seconds > 0 ? `遇到验证，${seconds} 秒后重试` : '正在重试';
}

function markAutoFetchCaptchaRetry(state) {
    const normalized = normalizeAutoFetchState(state);
    normalized.retryCount = Math.min((normalized.retryCount || 0) + 1, MAX_AUTO_FETCH_RETRY_COUNT);
    return normalized;
}

function resetAutoFetchRetry(state) {
    const normalized = normalizeAutoFetchState(state);
    delete normalized.retryCount;
    return normalized;
}

function buildPageUrl(template, page, baseUrl) {
    const pageNumber = Number(page);
    if (!template || !Number.isFinite(pageNumber) || pageNumber < 1) return '';
    return new URL(String(template).replace('{page}', String(pageNumber)).replace(/#.*$/, ''), baseUrl).href;
}

function normalizeSubwayStationLinkHref(href) {
    const source = String(href || '').trim();
    if (!source) return '';
    return source
        .replace(/^(https?:\/\/[^/]+\.lianjia\.com)\/zufang(?=\/|$|\?)/i, '$1/ditiezufang')
        .replace(/^(\/\/[^/]+\.lianjia\.com)\/zufang(?=\/|$|\?)/i, '$1/ditiezufang')
        .replace(/^\/zufang(?=\/|$|\?)/, '/ditiezufang');
}

function isSubwaySwitchLinkText(text) {
    return /^按地铁(?:线|站)$/.test(String(text || '').replace(/\s+/g, ''));
}

function getListingKey(listing) {
    const houseCode = String(listing?.houseCode || '').trim();
    if (houseCode) return `house:${houseCode}`;

    const hrefs = Array.isArray(listing?.hrefs) ? listing.hrefs : [];
    const href = hrefs.map((value) => String(value || '').trim()).find(Boolean);
    return href ? `href:${href}` : '';
}

function getListingKeyFromDetailUrl(url) {
    const match = /\/(?:zufang|apartment)\/([^/?#]+)\.html(?:[?#].*)?$/.exec(String(url || ''));
    return match ? `house:${match[1]}` : '';
}

function filterNewListingKeys(listings, seenKeys) {
    const result = [];
    listings.forEach((listing) => {
        const key = getListingKey(listing);
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        result.push(key);
    });
    return result;
}

function getListingDetailUrl(listing, baseUrl) {
    const hrefs = Array.isArray(listing?.hrefs) ? listing.hrefs : [];
    const href = hrefs.map((value) => String(value || '').trim()).find((value) => {
        return /\/(?:zufang|apartment)\/[^/?#]+\.html(?:[?#].*)?$/.test(value);
    });
    return href ? new URL(href, baseUrl).href : '';
}

function normalizeMapPoint(point) {
    const longitude = Number(point?.longitude ?? point?.lng ?? point?.lon);
    const latitude = Number(point?.latitude ?? point?.lat);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    if (longitude < 73 || longitude > 136 || latitude < 3 || latitude > 54) return null;
    return { longitude, latitude };
}

function readCoordinateField(text, key) {
    const match = new RegExp(`${key}["']?\\s*[:=]\\s*["']?(-?\\d+(?:\\.\\d+)?)`, 'i').exec(text);
    return match ? match[1] : '';
}

function extractMapPointFromDetailHtml(html) {
    const source = String(html || '');
    const coordBlock = /g_conf\.coord\s*=\s*\{([\s\S]*?)\}/.exec(source);
    if (coordBlock) {
        const point = normalizeMapPoint({
            longitude: readCoordinateField(coordBlock[1], 'longitude'),
            latitude: readCoordinateField(coordBlock[1], 'latitude')
        });
        if (point) return point;
    }

    const latFirst = /["']latitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?\s*,\s*["']longitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?/i.exec(source);
    if (latFirst) {
        const point = normalizeMapPoint({ latitude: latFirst[1], longitude: latFirst[2] });
        if (point) return point;
    }

    const lonFirst = /["']longitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?\s*,\s*["']latitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?/i.exec(source);
    return lonFirst ? normalizeMapPoint({ longitude: lonFirst[1], latitude: lonFirst[2] }) : null;
}

function normalizePreviewImageUrl(value, baseUrl = typeof window === 'object' ? window.location.href : 'https://lianjia.com/') {
    const source = String(value || '').trim();
    if (!source || /^data:|^javascript:/i.test(source)) return '';
    try {
        const url = new URL(source.replace(/^\/\//, 'https://'), baseUrl);
        return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function readHtmlAttribute(text, name) {
    const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(String(text || ''));
    return match ? match[1] : '';
}

function extractPreviewImageFromDetailHtml(html, baseUrl) {
    const source = String(html || '');
    const metaMatch = /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image|image)["'][^>]*>/i.exec(source);
    const metaUrl = normalizePreviewImageUrl(readHtmlAttribute(metaMatch?.[0], 'content'), baseUrl);
    if (metaUrl) return metaUrl;

    const imgMatches = source.match(/<img\b[^>]*>/gi) || [];
    for (const img of imgMatches) {
        const imageUrl = normalizePreviewImageUrl(
            readHtmlAttribute(img, 'data-src') || readHtmlAttribute(img, 'data-original') || readHtmlAttribute(img, 'src'),
            baseUrl
        );
        if (imageUrl) return imageUrl;
    }
    return '';
}

function normalizeCachedMapRecord(record, fallbackUpdatedAt) {
    const key = String(record?.key || '').trim();
    const detailUrl = String(record?.detailUrl || '').trim();
    if (!key || !detailUrl) return null;

    const updatedAt = Number(record?.updatedAt);
    const normalized = {
        key,
        detailUrl,
        title: String(record?.title || ''),
        price: String(record?.price || ''),
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : fallbackUpdatedAt
    };
    if (record?.address) normalized.address = String(record.address);
    if (record?.city) normalized.city = String(record.city);
    const point = normalizeMapPoint(record?.point);
    if (point) normalized.point = point;
    const previewImageUrl = normalizePreviewImageUrl(record?.previewImageUrl, detailUrl);
    if (previewImageUrl) normalized.previewImageUrl = previewImageUrl;
    if (record?.coordinateSource) normalized.coordinateSource = normalizeCoordinateSource(record.coordinateSource);
    const kinds = normalizeListingKinds(record?.kinds);
    if (kinds) normalized.kinds = kinds;
    const searchKeys = Array.isArray(record?.searchKeys)
        ? record.searchKeys.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    if (searchKeys.length) normalized.searchKeys = Array.from(new Set(searchKeys));
    return normalized;
}

function parseStoredMapCache(rawValue) {
    let source = rawValue;
    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch {
            source = {};
        }
    }

    const result = { version: MAP_CACHE_VERSION, listings: {} };
    const listings = source?.listings && typeof source.listings === 'object' ? source.listings : {};
    Object.values(listings).forEach((record) => {
        const normalized = normalizeCachedMapRecord(record, Number(record?.updatedAt) || Date.now());
        if (normalized) result.listings[normalized.key] = normalized;
    });
    return result;
}

function mergeMapCacheRecords(cache, records, updatedAt = Date.now(), sourceKey = '') {
    const next = parseStoredMapCache(cache);
    records.forEach((record) => {
        const key = String(record?.key || '').trim();
        const existing = next.listings[key];
        const existingPoint = normalizeMapPoint(existing?.point);
        const incomingPoint = normalizeMapPoint(record?.point);
        const previewImageUrl = normalizePreviewImageUrl(record?.previewImageUrl || existing?.previewImageUrl, record?.detailUrl || existing?.detailUrl);
        const searchKeys = [
            ...(Array.isArray(existing?.searchKeys) ? existing.searchKeys : []),
            ...(Array.isArray(record?.searchKeys) ? record.searchKeys : []),
            sourceKey
        ].map((value) => String(value || '').trim()).filter(Boolean);
        const normalized = normalizeCachedMapRecord({
            ...existing,
            ...record,
            point: incomingPoint || existingPoint,
            previewImageUrl,
            searchKeys,
            updatedAt
        }, updatedAt);
        if (normalized) next.listings[normalized.key] = normalized;
    });
    return next;
}

function getSearchCacheRecords(cache, searchKey, filterState) {
    const filters = normalizeFilterState(filterState);
    return Object.values(parseStoredMapCache(cache).listings).filter((record) => {
        if (!Array.isArray(record.searchKeys) || !record.searchKeys.includes(searchKey)) return false;
        const kinds = normalizeListingKinds(record.kinds);
        return !kinds || shouldShowListing(kinds, filters);
    });
}

function filterMapRecordsByState(records, filterState) {
    const filters = normalizeFilterState(filterState);
    return records.filter((record) => {
        const kinds = normalizeListingKinds(record?.kinds);
        return !kinds || shouldShowListing(kinds, filters);
    });
}

function hydrateMapRecordsFromCache(records, cache) {
    const parsed = parseStoredMapCache(cache);
    return records.map((record) => {
        const cached = parsed.listings[String(record?.key || '').trim()];
        const point = normalizeMapPoint(cached?.point);
        if (!point) return record;
        const previewImageUrl = normalizePreviewImageUrl(record.previewImageUrl || cached.previewImageUrl, record.detailUrl || cached.detailUrl);
        return {
            ...record,
            point,
            ...(previewImageUrl ? { previewImageUrl } : {}),
            updatedAt: cached.updatedAt
        };
    });
}

function parseStoredFilterState(rawValue) {
    if (!rawValue) return DEFAULT_FILTER_STATE;
    if (typeof rawValue === 'string') {
        try {
            return normalizeFilterState(JSON.parse(rawValue));
        } catch {
            return DEFAULT_FILTER_STATE;
        }
    }
    return normalizeFilterState(rawValue);
}

function readStoredFilterState() {
    if (typeof GM_getValue === 'function') {
        return parseStoredFilterState(GM_getValue(STORAGE_KEY, null));
    }
    try {
        return parseStoredFilterState(window.localStorage?.getItem(STORAGE_KEY));
    } catch {
        return DEFAULT_FILTER_STATE;
    }
}

function writeStoredFilterState(state) {
    const serialized = serializeFilterState(state);
    if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, serialized);
        return;
    }
    try {
        window.localStorage?.setItem(STORAGE_KEY, serialized);
    } catch {
        // Degraded environments can still filter for the current page session.
    }
}

function readStoredMapCache() {
    if (typeof GM_getValue === 'function') {
        return parseStoredMapCache(GM_getValue(MAP_CACHE_STORAGE_KEY, null));
    }
    try {
        return parseStoredMapCache(window.localStorage?.getItem(MAP_CACHE_STORAGE_KEY));
    } catch {
        return parseStoredMapCache(null);
    }
}

function writeStoredMapCache(cache) {
    const serialized = JSON.stringify(parseStoredMapCache(cache));
    if (typeof GM_setValue === 'function') {
        GM_setValue(MAP_CACHE_STORAGE_KEY, serialized);
        return;
    }
    try {
        window.localStorage?.setItem(MAP_CACHE_STORAGE_KEY, serialized);
    } catch {
        // Map points still work for the current page session when storage is unavailable.
    }
}

function readStoredAutoFetchState() {
    if (typeof GM_getValue === 'function') {
        return normalizeAutoFetchState(GM_getValue(AUTO_FETCH_STORAGE_KEY, null));
    }
    try {
        return normalizeAutoFetchState(window.localStorage?.getItem(AUTO_FETCH_STORAGE_KEY));
    } catch {
        return normalizeAutoFetchState(null);
    }
}

function writeStoredAutoFetchState(state) {
    const serialized = JSON.stringify(normalizeAutoFetchState(state));
    if (typeof GM_setValue === 'function') {
        GM_setValue(AUTO_FETCH_STORAGE_KEY, serialized);
        return;
    }
    try {
        window.localStorage?.setItem(AUTO_FETCH_STORAGE_KEY, serialized);
    } catch {
        // The toggle still works for the current page session when storage is unavailable.
    }
}

function readStoredTimingSettings() {
    if (typeof GM_getValue === 'function') {
        return normalizeTimingSettings(GM_getValue(TIMING_SETTINGS_STORAGE_KEY, null));
    }
    try {
        return normalizeTimingSettings(window.localStorage?.getItem(TIMING_SETTINGS_STORAGE_KEY));
    } catch {
        return DEFAULT_TIMING_SETTINGS;
    }
}

function writeStoredTimingSettings(settings) {
    const serialized = serializeTimingSettings(settings);
    if (typeof GM_setValue === 'function') {
        GM_setValue(TIMING_SETTINGS_STORAGE_KEY, serialized);
        return;
    }
    try {
        window.localStorage?.setItem(TIMING_SETTINGS_STORAGE_KEY, serialized);
    } catch {
        // Timing changes still apply for the current page session when storage is unavailable.
    }
}

function readStoredCoordinateSource() {
    if (typeof GM_getValue === 'function') {
        return normalizeCoordinateSource(GM_getValue(COORDINATE_SOURCE_STORAGE_KEY, null));
    }
    try {
        return normalizeCoordinateSource(window.localStorage?.getItem(COORDINATE_SOURCE_STORAGE_KEY));
    } catch {
        return DEFAULT_COORDINATE_SOURCE;
    }
}

function writeStoredCoordinateSource(source) {
    const normalized = normalizeCoordinateSource(source);
    if (typeof GM_setValue === 'function') {
        GM_setValue(COORDINATE_SOURCE_STORAGE_KEY, normalized);
        return;
    }
    try {
        window.localStorage?.setItem(COORDINATE_SOURCE_STORAGE_KEY, normalized);
    } catch {
        // Coordinate source changes still apply for the current page session when storage is unavailable.
    }
}

function getAsideText(row) {
    const aside = row?.querySelector?.('.filter__item--aside');
    return (aside?.textContent || '').replace(/\s+/g, '');
}

function findFilterHostRow() {
    return Array.from(document.querySelectorAll('#filter .filter__ul')).find((row) => getAsideText(row) === CONTENT_FILTER_HOST_LABEL) || null;
}

function buildFilterOption(key, text, checked) {
    const item = document.createElement('li');
    item.className = 'filter__item--level5 check lj-content-filter__item';

    const label = document.createElement('label');
    label.className = 'lj-content-filter__option';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.ljContentFilterOption = key;

    const labelText = document.createElement('span');
    labelText.textContent = text;

    label.append(input, labelText);
    item.append(label);
    return item;
}

function getCurrentFilterState(row) {
    return normalizeFilterState({
        beikePreferred: row.querySelector('[data-lj-content-filter-option="beikePreferred"]')?.checked,
        apartment: row.querySelector('[data-lj-content-filter-option="apartment"]')?.checked,
        guessYouLike: row.querySelector('[data-lj-content-filter-option="guessYouLike"]')?.checked
    });
}

function isGuessYouLikeCard(card) {
    return (card?.parentElement?.previousElementSibling?.textContent || '').replace(/\s+/g, '') === '猜你喜欢';
}

function getListingData(card) {
    const hrefs = Array.from(card.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') || '');
    return {
        houseCode: card.getAttribute('data-house_code') || '',
        text: (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim(),
        hrefs,
        guessYouLike: isGuessYouLikeCard(card)
    };
}

function applyFilters(state) {
    document.querySelectorAll('.content__list--item').forEach((card) => {
        const kinds = classifyListingContent(getListingData(card));
        const show = shouldShowListing(kinds, state);
        if (show) {
            if (card.dataset.ljContentFilterHidden === 'true') {
                card.style.display = '';
                delete card.dataset.ljContentFilterHidden;
            }
            return;
        }
        card.dataset.ljContentFilterHidden = 'true';
        card.style.display = 'none';
    });
}

function installStyles() {
    const css = [
        '.lj-content-filter__item{height:27px;line-height:27px;}',
        '.lj-content-filter__option{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:#394043;font-size:12px;}',
        '.lj-content-filter__option input{width:13px;height:13px;margin:0;accent-color:#00ae66;}',
        '.lj-content-filter__option span{line-height:27px;}',
        '.lj-stream-hidden-pager{display:none!important;}',
        '.lj-stream-status{margin:24px 0 8px;text-align:center;color:#888;font-size:13px;line-height:32px;}',
        '.lj-stream-status[data-clickable="true"]{cursor:pointer;color:#00ae66;}',
        '.lj-rent-map-panel{margin:10px 0 18px;border:1px solid #e5e5e5;background:#fff;}',
        '.lj-rent-map-panel__header{display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 14px;border-bottom:1px solid #f0f0f0;color:#394043;font-size:14px;}',
        '.lj-rent-map-panel__header strong{font-weight:600;}',
        '.lj-rent-map-panel__actions{display:flex;align-items:center;gap:12px;}',
        '.lj-rent-map-auto{display:inline-flex;align-items:center;gap:5px;color:#666;font-size:12px;cursor:pointer;white-space:nowrap;}',
        '.lj-rent-map-auto input{width:13px;height:13px;margin:0;accent-color:#00ae66;}',
        '.lj-rent-map-settings{position:relative;display:inline-flex;align-items:center;}',
        '.lj-rent-map-settings__button{height:22px;padding:0 8px;border:1px solid #ddd;background:#fff;color:#666;font-size:12px;line-height:20px;cursor:pointer;}',
        '.lj-rent-map-settings__panel{position:absolute;top:28px;right:0;z-index:10;width:210px;padding:10px;border:1px solid #ddd;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.12);color:#394043;font-size:12px;}',
        '.lj-rent-map-settings__row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;}',
        '.lj-rent-map-settings__row input{width:64px;height:24px;padding:0 5px;border:1px solid #ddd;color:#394043;font-size:12px;}',
        '.lj-rent-map-settings__row select{width:94px;height:24px;border:1px solid #ddd;background:#fff;color:#394043;font-size:12px;}',
        '.lj-rent-map-settings__field{display:inline-flex;align-items:center;gap:4px;}',
        '.lj-rent-map-settings__actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px;}',
        '.lj-rent-map-settings__actions button{height:24px;padding:0 9px;border:1px solid #ddd;background:#fff;color:#394043;font-size:12px;cursor:pointer;}',
        '.lj-rent-map-settings__actions button[data-primary="true"]{border-color:#00ae66;background:#00ae66;color:#fff;}',
        '.lj-rent-map-settings__error{min-height:16px;color:#fa5741;font-size:12px;line-height:16px;}',
        '.lj-rent-map-panel__status{color:#888;font-size:12px;}',
        '.lj-rent-map-panel__canvas{height:360px;background:#f7f7f7;}',
        '.lj-rent-map-info{min-width:180px;max-width:260px;color:#394043;line-height:1.5;}',
        '.lj-rent-map-info__title{font-weight:600;margin-bottom:4px;}',
        '.lj-rent-map-info__preview{width:220px;max-width:100%;height:128px;margin:4px 0 6px;border-radius:2px;background:#f5f5f5;object-fit:cover;display:block;}',
        '.lj-rent-map-info__preview-state{width:220px;max-width:100%;height:34px;margin:4px 0 6px;color:#999;font-size:12px;line-height:34px;text-align:center;background:#f7f7f7;}',
        '.lj-rent-map-info__price{color:#fa5741;margin-bottom:4px;}',
        '.lj-rent-map-info__link{color:#00ae66;text-decoration:none;}'
    ].join('');

    if (typeof GM_addStyle === 'function') {
        GM_addStyle(css);
        return;
    }

    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
}

function removeLegacyFilterRows() {
    document.querySelectorAll('[data-lj-content-filter-row="true"]').forEach((row) => row.remove());
}

function ensureFilterControls() {
    removeLegacyFilterRows();

    const hostRow = findFilterHostRow();
    if (!hostRow) return null;

    const state = readStoredFilterState();
    hostRow.classList.remove('hide');
    hostRow.dataset.ljContentFilterHost = 'true';
    hostRow.dataset.version = SCRIPT_VERSION;

    if (!hostRow.querySelector('[data-lj-content-filter-option="beikePreferred"]')) {
        hostRow.append(buildFilterOption('beikePreferred', '贝壳优选', state.beikePreferred));
    }
    if (!hostRow.querySelector('[data-lj-content-filter-option="apartment"]')) {
        hostRow.append(buildFilterOption('apartment', '公寓', state.apartment));
    }
    if (!hostRow.querySelector('[data-lj-content-filter-option="guessYouLike"]')) {
        hostRow.append(buildFilterOption('guessYouLike', '猜你喜欢', state.guessYouLike));
    }

    if (hostRow.dataset.ljContentFilterBound !== 'true') {
        hostRow.addEventListener('change', (event) => {
            if (!event.target?.matches?.('[data-lj-content-filter-option]')) return;
            const nextState = getCurrentFilterState(hostRow);
            writeStoredFilterState(nextState);
            applyFilters(nextState);
            refreshListingMap();
        });
        hostRow.dataset.ljContentFilterBound = 'true';
    }

    return hostRow;
}

function fixSubwayStationLinks(root = document) {
    const links = Array.from(root?.querySelectorAll?.('a[href]') || []);
    let changed = 0;
    links.forEach((link) => {
        if (!isSubwaySwitchLinkText(link.textContent)) return;
        const href = link.getAttribute('href') || '';
        const nextHref = normalizeSubwayStationLinkHref(href);
        if (!nextHref || nextHref === href) return;
        link.setAttribute('href', nextHref);
        changed += 1;
    });
    return changed;
}

function scheduleApply() {
    window.clearTimeout(scheduleApply.timer);
    scheduleApply.timer = window.setTimeout(() => {
        fixSubwayStationLinks();
        const hostRow = ensureFilterControls();
        applyFilters(hostRow ? getCurrentFilterState(hostRow) : readStoredFilterState());
        refreshListingMap();
    }, 80);
}

function applyCurrentFilters() {
    fixSubwayStationLinks();
    const hostRow = ensureFilterControls();
    applyFilters(hostRow ? getCurrentFilterState(hostRow) : readStoredFilterState());
    refreshListingMap();
}

function getPageWindow() {
    try {
        if (typeof unsafeWindow === 'object' && unsafeWindow) return unsafeWindow;
    } catch {
        // Fall back to the userscript window when page-world access is unavailable.
    }
    return window;
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function getListingTitle(card) {
    return (card.querySelector('.content__list--item--title')?.textContent || card.textContent || '').replace(/\s+/g, ' ').trim();
}

function getListingPrice(card) {
    return (card.querySelector('.content__list--item-price')?.textContent || '').replace(/\s+/g, ' ').trim();
}

function getListingAddress(card) {
    return (card.querySelector('.content__list--item--des')?.textContent || '').replace(/\s+/g, ' ').trim();
}

function getListingPreviewImage(card) {
    const image = Array.from(card.querySelectorAll('img')).find((node) => {
        return normalizePreviewImageUrl(node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src'));
    });
    return image ? normalizePreviewImageUrl(image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src')) : '';
}

function getCurrentCityName(hostname = window.location.hostname) {
    const cityCode = String(hostname || '').split('.')[0];
    const cityNames = {
        bj: '北京',
        cd: '成都',
        cq: '重庆',
        cs: '长沙',
        dg: '东莞',
        fs: '佛山',
        gz: '广州',
        hz: '杭州',
        nj: '南京',
        sh: '上海',
        sz: '深圳',
        tj: '天津',
        wh: '武汉',
        xa: '西安'
    };
    return cityNames[cityCode] || '';
}

function buildGeocodeQuery(record) {
    const city = String(record?.city || getCurrentCityName()).trim();
    const candidate = [record?.community, record?.title, record?.address]
        .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
        .find(Boolean);
    if (!candidate) return city;
    return city && !candidate.includes(city) ? `${city}${candidate}` : candidate;
}

function getMapRecordFromCard(card) {
    const listing = getListingData(card);
    const key = getListingKey(listing);
    const detailUrl = getListingDetailUrl(listing, window.location.href);
    if (!key || !detailUrl) return null;
    return {
        key,
        detailUrl,
        address: getListingAddress(card),
        city: getCurrentCityName(),
        title: getListingTitle(card),
        price: getListingPrice(card),
        previewImageUrl: getListingPreviewImage(card),
        kinds: classifyListingContent(listing)
    };
}

function isVisibleMapCard(card) {
    return card.dataset.ljContentFilterHidden !== 'true' && card.style.display !== 'none';
}

function getLoadedMapRecords() {
    return Array.from(document.querySelectorAll('.content__list--item'))
        .map(getMapRecordFromCard)
        .filter(Boolean);
}

function getVisibleMapRecords() {
    return Array.from(document.querySelectorAll('.content__list--item'))
        .filter(isVisibleMapCard)
        .map(getMapRecordFromCard)
        .filter(Boolean);
}

function ensureMapCache() {
    if (!mapState.cache) {
        mapState.cache = readStoredMapCache();
    }
    return mapState.cache;
}

function rememberMapRecords(records, searchKey = '') {
    if (!records.length) return;
    mapState.cache = mergeMapCacheRecords(ensureMapCache(), records, Date.now(), searchKey);
    writeStoredMapCache(mapState.cache);
}

function getCurrentMapFilterState() {
    const hostRow = findFilterHostRow();
    return hostRow ? getCurrentFilterState(hostRow) : readStoredFilterState();
}

function getCurrentSearchKey() {
    const pageKey = streamState.pageUrlTemplate || findPagination()?.getAttribute('data-url') || window.location.pathname;
    return `${pageKey}#filters=${serializeFilterState(getCurrentMapFilterState())}`;
}

function mergeMapRecordsByKey(records) {
    const merged = new Map();
    records.forEach((record) => {
        if (!record?.key) return;
        merged.set(record.key, { ...merged.get(record.key), ...record });
    });
    return Array.from(merged.values());
}

function getCurrentMapRecords() {
    const cache = ensureMapCache();
    const searchKey = getCurrentSearchKey();
    const records = hydrateMapRecordsFromCache(mergeMapRecordsByKey([
        ...getSearchCacheRecords(cache, searchKey, getCurrentMapFilterState()),
        ...getVisibleMapRecords()
    ]), cache);
    records.forEach((record) => {
        if (record.point) {
            mapState.fetchedListings.set(record.key, record);
        }
    });
    return records;
}

function findResultTitle() {
    return document.querySelector('.content__article > .content__title')
        || Array.from(document.querySelectorAll('.content__title')).find((node) => /已为您找到\s*\d+\s*套/.test(node.textContent || ''))
        || null;
}

function ensureMapPanel() {
    if (mapState.panel?.isConnected) return mapState.panel;

    const title = findResultTitle();
    if (!title) return null;

    const panel = document.createElement('section');
    panel.className = 'lj-rent-map-panel';
    panel.dataset.ljRentMapPanel = 'true';
    panel.dataset.version = SCRIPT_VERSION;

    const header = document.createElement('div');
    header.className = 'lj-rent-map-panel__header';

    const heading = document.createElement('strong');
    heading.textContent = '房源地图';

    const status = document.createElement('span');
    status.className = 'lj-rent-map-panel__status';
    status.dataset.ljRentMapStatus = 'true';
    status.textContent = '正在读取坐标...';

    const actions = document.createElement('div');
    actions.className = 'lj-rent-map-panel__actions';
    actions.append(buildAutoFetchControl(), buildTimingSettingsControl(), status);

    const canvas = document.createElement('div');
    canvas.className = 'lj-rent-map-panel__canvas';
    canvas.id = 'lj-rent-map-canvas';

    header.append(heading, actions);
    panel.append(header, canvas);
    title.after(panel);

    mapState.panel = panel;
    mapState.canvas = canvas;
    mapState.status = status;
    return panel;
}

function setMapStatus(text) {
    ensureMapPanel();
    if (mapState.status) mapState.status.textContent = text;
}

function getAutoFetchState() {
    if (!mapState.autoFetchState) {
        mapState.autoFetchState = readStoredAutoFetchState();
    }
    return mapState.autoFetchState;
}

function isAutoFetchEnabled() {
    return getAutoFetchState().enabled === true;
}

function getTimingSettings() {
    if (!mapState.timingSettings) {
        mapState.timingSettings = readStoredTimingSettings();
    }
    return mapState.timingSettings;
}

function getCoordinateSource() {
    if (!mapState.coordinateSource) {
        mapState.coordinateSource = readStoredCoordinateSource();
    }
    return mapState.coordinateSource;
}

function saveAutoFetchState(state) {
    mapState.autoFetchState = normalizeAutoFetchState(state);
    writeStoredAutoFetchState(mapState.autoFetchState);
}

function saveTimingSettings(settings) {
    mapState.timingSettings = normalizeTimingSettings(settings);
    writeStoredTimingSettings(mapState.timingSettings);
    return mapState.timingSettings;
}

function saveCoordinateSource(source) {
    mapState.coordinateSource = normalizeCoordinateSource(source);
    writeStoredCoordinateSource(mapState.coordinateSource);
    return mapState.coordinateSource;
}

function setAutoFetchStatus(text) {
    if (mapState.autoFetchStatus) {
        mapState.autoFetchStatus.textContent = text;
    }
}

function clearMapQueue() {
    window.clearTimeout(mapState.mapQueueTimer);
    mapState.mapQueueTimer = 0;
    mapState.pendingRecords = [];
    mapState.queuedKeys.clear();
}

function applyTimingSettingsNow() {
    window.clearTimeout(mapState.mapQueueTimer);
    mapState.mapQueueTimer = 0;
    processMapQueue();

    window.clearTimeout(mapState.autoFetchTimer);
    mapState.autoFetchTimer = 0;
    if (!isAutoFetchEnabled() || mapState.autoFetchLoading) return;

    if (mapState.blocked) {
        const delay = getAutoFetchRetryDelay(getAutoFetchState(), getTimingSettings());
        startAutoFetchRetryCountdown(delay);
        scheduleAutoFetch(delay);
        return;
    }

    stopAutoFetchRetryCountdown();
    scheduleAutoFetch(getAutoFetchPageDelay(getTimingSettings()));
}

function buildAutoFetchControl() {
    const state = getAutoFetchState();
    const label = document.createElement('label');
    label.className = 'lj-rent-map-auto';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.enabled;
    input.dataset.ljRentMapAutoFetch = 'true';

    const text = document.createElement('span');
    text.textContent = '自动抓取';

    const status = document.createElement('span');
    status.className = 'lj-rent-map-auto__status';
    status.dataset.ljRentMapAutoFetchStatus = 'true';
    status.textContent = state.enabled ? '等待中' : '';

    input.addEventListener('change', () => {
        saveAutoFetchState({ ...getAutoFetchState(), enabled: input.checked });
        if (input.checked) {
            startAutoFetch();
        } else {
            stopAutoFetch();
        }
    });

    label.append(input, text, status);
    mapState.autoFetchControl = input;
    mapState.autoFetchStatus = status;
    return label;
}

function getTimingSettingSeconds(settings, key) {
    return Math.max(1, Math.round(normalizeTimingSettings(settings)[key] / 1000));
}

function fillTimingSettingsPanel(panel, settings) {
    panel.querySelectorAll('[data-lj-rent-timing-key]').forEach((input) => {
        input.value = String(getTimingSettingSeconds(settings, input.dataset.ljRentTimingKey));
    });
    const sourceSelect = panel.querySelector('[data-lj-rent-coordinate-source]');
    if (sourceSelect) sourceSelect.value = DEFAULT_COORDINATE_SOURCE;
}

function readTimingSettingsPanel(panel) {
    const values = {};
    let valid = true;
    panel.querySelectorAll('[data-lj-rent-timing-key]').forEach((input) => {
        const seconds = Number(input.value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
            valid = false;
            return;
        }
        values[input.dataset.ljRentTimingKey] = Math.round(seconds * 1000);
    });
    return valid ? normalizeTimingSettings(values) : null;
}

function buildTimingSettingsRow(key, labelText, settings) {
    const row = document.createElement('label');
    row.className = 'lj-rent-map-settings__row';

    const label = document.createElement('span');
    label.textContent = labelText;

    const field = document.createElement('span');
    field.className = 'lj-rent-map-settings__field';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = String(getTimingSettingSeconds(settings, key));
    input.dataset.ljRentTimingKey = key;

    const unit = document.createElement('span');
    unit.textContent = '秒';

    field.append(input, unit);
    row.append(label, field);
    return row;
}

function buildCoordinateSourceRow(source) {
    const row = document.createElement('label');
    row.className = 'lj-rent-map-settings__row';

    const label = document.createElement('span');
    label.textContent = '坐标来源';

    const select = document.createElement('select');
    select.dataset.ljRentCoordinateSource = 'true';
    COORDINATE_SOURCE_OPTIONS.forEach((option) => {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label;
        select.append(item);
    });
    select.value = normalizeCoordinateSource(source);

    row.append(label, select);
    return row;
}

function buildTimingSettingsPanel() {
    const settings = getTimingSettings();
    const coordinateSource = getCoordinateSource();
    const panel = document.createElement('div');
    panel.className = 'lj-rent-map-settings__panel';
    panel.dataset.ljRentTimingSettingsPanel = 'true';

    const error = document.createElement('div');
    error.className = 'lj-rent-map-settings__error';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '重置';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = '确定';
    confirm.dataset.primary = 'true';

    const actions = document.createElement('div');
    actions.className = 'lj-rent-map-settings__actions';
    actions.append(reset, confirm);

    panel.append(
        buildCoordinateSourceRow(coordinateSource),
        buildTimingSettingsRow('autoFetchPageDelayMs', '自动抓取间隔', settings),
        buildTimingSettingsRow('mapDetailFetchDelayMs', '坐标读取间隔', settings),
        buildTimingSettingsRow('captchaRetryDelayMs', '验证重试间隔', settings),
        error,
        actions
    );

    reset.addEventListener('click', () => {
        error.textContent = '';
        fillTimingSettingsPanel(panel, DEFAULT_TIMING_SETTINGS);
    });

    confirm.addEventListener('click', () => {
        const nextSettings = readTimingSettingsPanel(panel);
        if (!nextSettings) {
            error.textContent = '请输入大于 0 的秒数';
            return;
        }
        saveTimingSettings(nextSettings);
        saveCoordinateSource(panel.querySelector('[data-lj-rent-coordinate-source]')?.value);
        applyTimingSettingsNow();
        setAutoFetchStatus('设置已保存');
        mapState.timingSettingsPanel = null;
        panel.remove();
    });

    mapState.timingSettingsPanel = panel;
    return panel;
}

function buildTimingSettingsControl() {
    const wrapper = document.createElement('div');
    wrapper.className = 'lj-rent-map-settings';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lj-rent-map-settings__button';
    button.textContent = '设置';

    button.addEventListener('click', () => {
        if (mapState.timingSettingsPanel?.isConnected) {
            mapState.timingSettingsPanel.remove();
            mapState.timingSettingsPanel = null;
            return;
        }
        wrapper.append(buildTimingSettingsPanel());
    });

    wrapper.append(button);
    return wrapper;
}

function updateMapStatus(records) {
    const mapped = records.filter((record) => mapState.fetchedListings.has(record.key)).length;
    const failed = records.filter((record) => mapState.failedKeys.has(record.key)).length;
    const pending = records.length - mapped - failed;

    if (!isAutoFetchEnabled() && pending > 0) {
        setMapStatus(mapped > 0 ? `已标记 ${mapped} 套，自动抓取已关闭` : '自动抓取已关闭');
        return;
    }

    if (mapState.blocked) {
        setMapStatus('遇到验证，稍后重试');
        return;
    }

    if (!records.length) {
        setMapStatus('暂无可标记房源');
    } else if (pending > 0) {
        setMapStatus(`正在读取坐标 ${mapped}/${records.length}`);
    } else if (mapped > 0) {
        setMapStatus(`已标记 ${mapped} 套`);
    } else {
        setMapStatus('未找到可用坐标');
    }
}

function loadBaiduMap() {
    const pageWindow = getPageWindow();
    if (pageWindow.BMap) return Promise.resolve(pageWindow.BMap);
    if (mapState.mapScriptPromise) return mapState.mapScriptPromise;

    mapState.mapScriptPromise = new Promise((resolve, reject) => {
        const callbackName = `__lianjiaRentMapReady_${Date.now()}`;
        const script = document.createElement('script');

        pageWindow[callbackName] = () => {
            const BMap = pageWindow.BMap;
            if (BMap) {
                resolve(BMap);
            } else {
                reject(new Error('BMap missing after script load'));
            }
            window.setTimeout(() => {
                try {
                    delete pageWindow[callbackName];
                } catch {
                    pageWindow[callbackName] = undefined;
                }
            }, 0);
        };

        script.onerror = () => reject(new Error('Baidu map script failed'));
        script.src = `${window.location.protocol}//api.map.baidu.com/api?v=2.0&ak=${BAIDU_MAP_AK}&callback=${callbackName}`;
        document.body.append(script);
    });

    return mapState.mapScriptPromise;
}

async function ensureMapReady() {
    if (mapState.map) return mapState.map;
    if (mapState.mapReadyPromise) return mapState.mapReadyPromise;

    const panel = ensureMapPanel();
    if (!panel || !mapState.canvas) throw new Error('Map container missing');

    mapState.mapReadyPromise = loadBaiduMap().then((BMap) => {
        const map = new BMap.Map(mapState.canvas.id, { enableMapClick: false });
        if (typeof map.addControl === 'function' && BMap.NavigationControl) {
            map.addControl(new BMap.NavigationControl({ type: getPageWindow().BMAP_NAVIGATION_CONTROL_SMALL }));
        }
        mapState.map = map;
        return map;
    }).catch((error) => {
        mapState.mapReadyPromise = null;
        throw error;
    });
    return mapState.mapReadyPromise;
}

function buildPreviewHtml(record, options = {}) {
    const previewImageUrl = normalizePreviewImageUrl(record?.previewImageUrl, record?.detailUrl);
    if (previewImageUrl) {
        return `<img class="lj-rent-map-info__preview" src="${escapeHtml(previewImageUrl)}" alt="">`;
    }
    if (options.previewLoading) {
        return '<div class="lj-rent-map-info__preview-state">正在读取图片...</div>';
    }
    if (options.previewFailed) {
        return '<div class="lj-rent-map-info__preview-state">图片获取失败</div>';
    }
    return '';
}

function buildInfoWindowHtml(record, options = {}) {
    const title = escapeHtml(record.title);
    const price = escapeHtml(record.price);
    const detailUrl = escapeHtml(record.detailUrl);
    return [
        '<div class="lj-rent-map-info">',
        `<div class="lj-rent-map-info__title">${title}</div>`,
        buildPreviewHtml(record, options),
        price ? `<div class="lj-rent-map-info__price">${price}</div>` : '',
        `<a class="lj-rent-map-info__link" href="${detailUrl}" target="_blank" rel="noopener">查看房源</a>`,
        '</div>'
    ].join('');
}

function clearMapOverlaysIfPresent(map) {
    if (typeof map?.clearOverlays !== 'function') return false;
    map.clearOverlays();
    return true;
}

function renderListingMap() {
    const records = getCurrentMapRecords();
    updateMapStatus(records);

    const mappedRecords = records
        .map((record) => mapState.fetchedListings.get(record.key))
        .filter((record) => record?.point);
    if (!mappedRecords.length) {
        clearMapOverlaysIfPresent(mapState.map);
        return;
    }

    ensureMapReady().then((map) => {
        const BMap = getPageWindow().BMap;
        if (!BMap) return;

        clearMapOverlaysIfPresent(map);
        const points = mappedRecords.map((record) => new BMap.Point(record.point.longitude, record.point.latitude));
        mappedRecords.forEach((record, index) => {
            const point = points[index];
            const marker = new BMap.Marker(point);
            const infoWindow = new BMap.InfoWindow(buildInfoWindowHtml(record));
            marker.addEventListener('click', () => {
                map.openInfoWindow(infoWindow, point);
                loadPreviewImageForInfoWindow(record, infoWindow);
            });
            map.addOverlay(marker);
        });

        if (points.length === 1) {
            map.centerAndZoom(points[0], 15);
        } else {
            map.setViewport(points, { margins: [40, 40, 40, 40] });
        }
        updateMapStatus(records);
    }).catch(() => {
        setMapStatus('地图加载失败');
    });
}

function updateInfoWindowContent(infoWindow, record, options = {}) {
    if (typeof infoWindow?.setContent === 'function') {
        infoWindow.setContent(buildInfoWindowHtml(record, options));
    }
}

async function loadPreviewImageForInfoWindow(record, infoWindow) {
    if (record.previewImageUrl || mapState.previewImageLoadingKeys.has(record.key)) return;
    if (mapState.previewImageFailedKeys.has(record.key)) {
        updateInfoWindowContent(infoWindow, record, { previewFailed: true });
        return;
    }

    mapState.previewImageLoadingKeys.add(record.key);
    updateInfoWindowContent(infoWindow, record, { previewLoading: true });
    try {
        const previewImageUrl = await fetchPreviewImageForRecord(record);
        const cachedRecord = { ...record, previewImageUrl };
        mapState.fetchedListings.set(record.key, cachedRecord);
        rememberMapRecords([cachedRecord]);
        updateInfoWindowContent(infoWindow, cachedRecord);
    } catch {
        mapState.previewImageFailedKeys.add(record.key);
        updateInfoWindowContent(infoWindow, record, { previewFailed: true });
    } finally {
        mapState.previewImageLoadingKeys.delete(record.key);
    }
}

async function fetchPreviewImageForRecord(record) {
    const response = await fetchWithTimeout(record.detailUrl, { credentials: 'same-origin' }, MAP_DETAIL_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (isCaptchaResponse(response, html)) throw new Error('captcha');
    const previewImageUrl = extractPreviewImageFromDetailHtml(html, record.detailUrl);
    if (!previewImageUrl) throw new Error('preview image missing');
    return previewImageUrl;
}

function rememberCoordinateRecord(record, point, coordinateSource) {
    const cachedRecord = { ...record, point, coordinateSource };
    mapState.fetchedListings.set(record.key, cachedRecord);
    rememberMapRecords([cachedRecord]);
    return cachedRecord;
}

function findCachedCoordinateRecord(record, cache = readStoredMapCache()) {
    const parsed = parseStoredMapCache(cache);
    const key = String(record?.key || '').trim();
    const detailUrl = String(record?.detailUrl || '').trim();
    const cached = parsed.listings[key] || Object.values(parsed.listings).find((item) => item.detailUrl === detailUrl);
    const point = normalizeMapPoint(cached?.point);
    return point ? { ...record, ...cached, point } : null;
}

function closeOpenedTab(tabHandle) {
    try {
        if (typeof tabHandle?.close === 'function') tabHandle.close();
    } catch {
        // The opened tab may already be closed by the browser or userscript manager.
    }
}

function waitForCachedCoordinate(record, tabHandle) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (!isAutoFetchEnabled()) {
                closeOpenedTab(tabHandle);
                reject(new Error('auto disabled'));
                return;
            }
            const cached = findCachedCoordinateRecord(record);
            if (cached) {
                closeOpenedTab(tabHandle);
                resolve(cached.point);
                return;
            }
            if (Date.now() - startedAt >= MAP_DETAIL_FETCH_TIMEOUT_MS) {
                closeOpenedTab(tabHandle);
                reject(new Error('coordinate missing'));
                return;
            }
            window.setTimeout(poll, 1000);
        };
        poll();
    });
}

function geocodePoint(query, city) {
    return ensureMapReady().then(() => loadBaiduMap()).then((BMap) => new Promise((resolve, reject) => {
        if (!BMap?.Geocoder) {
            reject(new Error('geocoder missing'));
            return;
        }
        const geocoder = new BMap.Geocoder();
        const timeoutId = window.setTimeout(() => reject(new Error('coordinate missing')), MAP_DETAIL_FETCH_TIMEOUT_MS);
        geocoder.getPoint(query, (point) => {
            window.clearTimeout(timeoutId);
            const normalized = normalizeMapPoint(point);
            if (normalized) {
                resolve(normalized);
            } else {
                reject(new Error('coordinate missing'));
            }
        }, city || undefined);
    }));
}

async function fetchMapRecordByGeocode(record) {
    const query = buildGeocodeQuery(record);
    if (!query) throw new Error('coordinate missing');
    const point = await geocodePoint(query, record.city || getCurrentCityName());
    return rememberCoordinateRecord(record, point, COORDINATE_SOURCE_GEOCODE);
}

async function fetchMapRecordByFetch(record) {
    const response = await fetchWithTimeout(record.detailUrl, { credentials: 'same-origin' }, MAP_DETAIL_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (isCaptchaResponse(response, html)) {
        throw new Error('captcha');
    }
    const point = extractMapPointFromDetailHtml(html);
    if (!point) throw new Error('coordinate missing');
    return rememberCoordinateRecord({
        ...record,
        previewImageUrl: extractPreviewImageFromDetailHtml(html, record.detailUrl) || record.previewImageUrl
    }, point, COORDINATE_SOURCE_FETCH);
}

async function fetchMapRecordByIframe(record) {
    if (typeof document !== 'object') throw new Error('iframe unavailable');
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;visibility:hidden;';
    iframe.src = record.detailUrl;

    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            window.clearTimeout(timeoutId);
            iframe.remove();
        };
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };
        const timeoutId = window.setTimeout(() => settle(reject, new Error('coordinate missing')), MAP_DETAIL_FETCH_TIMEOUT_MS);

        iframe.addEventListener('load', () => {
            try {
                const frameWindow = iframe.contentWindow;
                const frameDocument = iframe.contentDocument || frameWindow?.document;
                const html = frameDocument?.documentElement?.outerHTML || '';
                if (isCaptchaResponse({ url: frameWindow?.location?.href || iframe.src }, html)) {
                    settle(reject, new Error('captcha'));
                    return;
                }
                const point = extractMapPointFromDetailHtml(html);
                if (!point) {
                    settle(reject, new Error('coordinate missing'));
                    return;
                }
                settle(resolve, rememberCoordinateRecord({
                    ...record,
                    previewImageUrl: extractPreviewImageFromDetailHtml(html, record.detailUrl) || record.previewImageUrl
                }, point, COORDINATE_SOURCE_IFRAME));
            } catch {
                settle(reject, new Error('coordinate missing'));
            }
        });
        iframe.addEventListener('error', () => settle(reject, new Error('coordinate missing')));
        document.body.append(iframe);
    });
}

async function fetchMapRecordByTab(record) {
    if (typeof GM_openInTab !== 'function') throw new Error('tab unavailable');
    const tabHandle = GM_openInTab(record.detailUrl, { active: false, insert: true, setParent: true });
    const point = await waitForCachedCoordinate(record, tabHandle);
    return rememberCoordinateRecord(record, point, COORDINATE_SOURCE_TAB);
}

async function fetchMapRecordWithSource(record, source) {
    if (source === COORDINATE_SOURCE_GEOCODE) return fetchMapRecordByGeocode(record);
    if (source === COORDINATE_SOURCE_IFRAME) return fetchMapRecordByIframe(record);
    if (source === COORDINATE_SOURCE_TAB) return fetchMapRecordByTab(record);
    return fetchMapRecordByFetch(record);
}

async function fetchMapRecord(record) {
    let lastError = null;
    for (const source of getCoordinateSourceSequence(getCoordinateSource())) {
        if (!isAutoFetchEnabled()) throw new Error('auto disabled');
        try {
            return await fetchMapRecordWithSource(record, source);
        } catch (error) {
            if (error?.message === 'captcha') throw error;
            lastError = error;
        }
    }
    throw lastError || new Error('coordinate missing');
}

function fetchWithTimeout(url, options = {}, timeoutMs = MAP_DETAIL_FETCH_TIMEOUT_MS, fetchImpl = fetch) {
    if (typeof AbortController !== 'function' || !timeoutMs) {
        return fetchImpl(url, options);
    }

    const controller = new AbortController();
    const timerApi = typeof window === 'object' ? window : globalThis;
    const timeoutId = timerApi.setTimeout(() => controller.abort(), timeoutMs);
    return fetchImpl(url, { ...options, signal: controller.signal }).finally(() => {
        timerApi.clearTimeout(timeoutId);
    });
}

function isRentListPageUrl(url) {
    return /^https:\/\/[^/]+\.lianjia\.com\/(?:ditiezufang|zufang)(?:\/|$)/.test(String(url || ''))
        && !isRentDetailPageUrl(url);
}

function isRentDetailPageUrl(url) {
    return /^https:\/\/[^/]+\.lianjia\.com\/(?:zufang|apartment)\/[^/?#]+\.html(?:[?#].*)?$/.test(String(url || ''));
}

function captureDetailPageCoordinate() {
    const key = getListingKeyFromDetailUrl(window.location.href);
    if (!key) return;
    const point = extractMapPointFromDetailHtml(document.documentElement?.outerHTML || '');
    if (!point) return;
    const record = {
        key,
        detailUrl: window.location.href,
        title: document.title || '',
        price: '',
        point,
        previewImageUrl: extractPreviewImageFromDetailHtml(document.documentElement?.outerHTML || '', window.location.href),
        coordinateSource: COORDINATE_SOURCE_TAB
    };
    mapState.cache = mergeMapCacheRecords(readStoredMapCache(), [record], Date.now(), '');
    writeStoredMapCache(mapState.cache);
}

function isCaptchaResponse(response, html) {
    return /\/captcha(?:\?|$)/.test(response?.url || '') || /hip\.lianjia\.com\/captcha|人机验证|CAPTCHA/.test(String(html || ''));
}

function releaseQueuedMapRecordKeys(queuedKeys, records) {
    records.forEach((record) => {
        if (record?.key) queuedKeys.delete(record.key);
    });
    return queuedKeys;
}

function getMapQueueWaitMs(state, settingsOrNow = DEFAULT_TIMING_SETTINGS, nowOrUndefined) {
    const settings = typeof settingsOrNow === 'number' ? DEFAULT_TIMING_SETTINGS : settingsOrNow;
    const now = typeof settingsOrNow === 'number' ? settingsOrNow : (nowOrUndefined ?? Date.now());
    if (state?.autoFetchEnabled === false || state?.blocked || (state?.activeFetches || 0) >= MAP_DETAIL_FETCH_LIMIT || !state?.pendingRecords?.length) {
        return null;
    }
    const lastFinishedAt = Number(state?.lastMapFetchFinishedAt) || 0;
    if (!lastFinishedAt) return 0;
    return Math.max(0, lastFinishedAt + getMapDetailFetchDelay(settings) - now);
}

function scheduleMapQueue(delay) {
    window.clearTimeout(mapState.mapQueueTimer);
    mapState.mapQueueTimer = 0;
    if (delay === null || mapState.blocked || !isAutoFetchEnabled() || !mapState.pendingRecords.length) return;
    mapState.mapQueueTimer = window.setTimeout(processMapQueue, Math.max(0, delay));
}

function processMapQueue() {
    window.clearTimeout(mapState.mapQueueTimer);
    mapState.mapQueueTimer = 0;

    if (!isAutoFetchEnabled()) {
        clearMapQueue();
        return;
    }

    const waitMs = getMapQueueWaitMs({ ...mapState, autoFetchEnabled: true }, getTimingSettings());
    if (waitMs === null) return;
    if (waitMs > 0) {
        scheduleMapQueue(waitMs);
        return;
    }

    const record = mapState.pendingRecords.shift();
    mapState.activeFetches += 1;
    fetchMapRecord(record)
        .catch((error) => {
            if (error?.message === 'captcha') {
                pauseForCaptchaRetry();
                releaseQueuedMapRecordKeys(mapState.queuedKeys, mapState.pendingRecords);
                mapState.pendingRecords = [];
                return;
            }
            mapState.failedKeys.add(record.key);
        })
        .finally(() => {
            mapState.activeFetches -= 1;
            mapState.lastMapFetchFinishedAt = Date.now();
            mapState.queuedKeys.delete(record.key);
            renderListingMap();
            if (!mapState.blocked) {
                processMapQueue();
            }
        });
}

function enqueueMapRecords(records) {
    if (mapState.blocked || !isAutoFetchEnabled()) return;

    records.forEach((record) => {
        if (mapState.fetchedListings.has(record.key) || mapState.failedKeys.has(record.key) || mapState.queuedKeys.has(record.key)) return;
        mapState.queuedKeys.add(record.key);
        mapState.pendingRecords.push(record);
    });
}

function getCurrentPageNumber() {
    return parsePositiveInteger(streamState.pager?.getAttribute('data-curpage'))
        || parsePositiveInteger(findPagination()?.getAttribute('data-curpage'))
        || 1;
}

function getCurrentTotalPage() {
    return streamState.totalPage || parsePositiveInteger(findPagination()?.getAttribute('data-totalpage'));
}

function getAutoFetchPageUrl(page) {
    const template = streamState.pageUrlTemplate || findPagination()?.getAttribute('data-url') || '';
    return buildPageUrl(template, page, window.location.href);
}

function stopAutoFetch() {
    window.clearTimeout(mapState.autoFetchTimer);
    stopAutoFetchRetryCountdown();
    clearMapQueue();
    mapState.blocked = false;
    mapState.autoFetchTimer = 0;
    mapState.autoFetchLoading = false;
    setAutoFetchStatus('');
    refreshListingMap();
}

function scheduleAutoFetch(delay = getAutoFetchPageDelay(getTimingSettings())) {
    window.clearTimeout(mapState.autoFetchTimer);
    if (!isAutoFetchEnabled()) return;
    mapState.autoFetchTimer = window.setTimeout(runAutoFetchStep, delay);
}

function startAutoFetch() {
    if (mapState.blocked) {
        const delay = getAutoFetchRetryDelay(getAutoFetchState(), getTimingSettings());
        startAutoFetchRetryCountdown(delay);
        scheduleAutoFetch(delay);
        return;
    }
    setAutoFetchStatus('等待中');
    scheduleAutoFetch(0);
}

function stopAutoFetchRetryCountdown() {
    window.clearInterval(mapState.autoFetchCountdownTimer);
    mapState.autoFetchCountdownTimer = 0;
}

function startAutoFetchRetryCountdown(delay) {
    const retryAt = Date.now() + delay;
    stopAutoFetchRetryCountdown();
    const render = () => {
        const remaining = retryAt - Date.now();
        setAutoFetchStatus(getAutoFetchRetryStatusText(remaining));
        if (remaining <= 0) {
            stopAutoFetchRetryCountdown();
        }
    };
    render();
    mapState.autoFetchCountdownTimer = window.setInterval(render, 1000);
}

function refreshMapAfterAutoFetchStep() {
    const currentRecords = getCurrentMapRecords();
    enqueueMapRecords(currentRecords);
    updateMapStatus(currentRecords);
    processMapQueue();
    renderListingMap();
}

function pauseForCaptchaRetry() {
    mapState.blocked = true;
    const currentState = getAutoFetchState();
    const delay = getAutoFetchRetryDelay(currentState, getTimingSettings());
    const state = markAutoFetchCaptchaRetry(currentState);
    saveAutoFetchState(state);
    startAutoFetchRetryCountdown(delay);
    setMapStatus('遇到验证，稍后重试');
    scheduleAutoFetch(delay);
}

async function runAutoFetchStep() {
    if (!isAutoFetchEnabled() || mapState.autoFetchLoading) return;
    stopAutoFetchRetryCountdown();
    if (mapState.blocked) {
        mapState.blocked = false;
    }

    const searchKey = getCurrentSearchKey();
    const page = getAutoFetchNextPage(getAutoFetchState(), searchKey, getCurrentPageNumber(), getCurrentTotalPage());
    if (!page) {
        setAutoFetchStatus('已全部抓取');
        refreshMapAfterAutoFetchStep();
        return;
    }

    const pageUrl = getAutoFetchPageUrl(page);
    if (!pageUrl) {
        setAutoFetchStatus('无分页');
        return;
    }

    mapState.autoFetchLoading = true;
    setAutoFetchStatus(`第 ${page} 页`);

    try {
        const response = await fetch(pageUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (isCaptchaResponse(response, html)) throw new Error('captcha');

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const records = filterMapRecordsByState(
            getCardsFromDocument(doc).map(getMapRecordFromCard).filter(Boolean),
            getCurrentMapFilterState()
        );
        rememberMapRecords(records, searchKey);
        saveAutoFetchState(resetAutoFetchRetry(markAutoFetchPageFetched(getAutoFetchState(), searchKey, page)));

        refreshMapAfterAutoFetchStep();
        setAutoFetchStatus(`已到 ${page} 页`);
        scheduleAutoFetch();
    } catch (error) {
        if (error?.message === 'captcha') {
            pauseForCaptchaRetry();
            return;
        }
        setAutoFetchStatus('抓取失败');
        scheduleAutoFetch(getAutoFetchPageDelay(getTimingSettings(), 2));
    } finally {
        mapState.autoFetchLoading = false;
    }
}

function refreshListingMap() {
    if (!ensureMapPanel()) return;

    const searchKey = getCurrentSearchKey();
    rememberMapRecords(filterMapRecordsByState(getLoadedMapRecords(), getCurrentMapFilterState()), searchKey);
    const records = getCurrentMapRecords();
    enqueueMapRecords(records);
    updateMapStatus(records);
    processMapQueue();
    renderListingMap();
}

function initListingMap() {
    if (mapState.initialized) return;
    if (!ensureMapPanel()) return;
    mapState.initialized = true;
    ensureMapCache();
    refreshListingMap();
    if (isAutoFetchEnabled()) {
        startAutoFetch();
    }
}

function findPagination() {
    return document.querySelector('.content__pg[data-url][data-totalpage][data-curpage]');
}

function parsePositiveInteger(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function collectSeenListingKeys() {
    streamState.seenKeys = new Set();
    document.querySelectorAll('.content__list--item').forEach((card) => {
        const key = getListingKey(getListingData(card));
        if (key) streamState.seenKeys.add(key);
    });
}

function ensureStreamStatus() {
    if (streamState.status?.isConnected) return streamState.status;
    const status = document.createElement('div');
    status.className = 'lj-stream-status';
    status.dataset.ljStreamStatus = 'true';
    status.addEventListener('click', () => {
        if (status.dataset.clickable === 'true') {
            loadNextPage();
        }
    });
    streamState.pager.after(status);
    streamState.status = status;
    return status;
}

function setStreamStatus(text, clickable = false) {
    const status = ensureStreamStatus();
    status.textContent = text;
    status.dataset.clickable = clickable ? 'true' : 'false';
}

function updateStreamPager(pager, keepCurrentPager = true) {
    if (keepCurrentPager) {
        streamState.pager = pager;
        pager.classList.add('lj-stream-hidden-pager');
    }
    streamState.pageUrlTemplate = pager.getAttribute('data-url') || streamState.pageUrlTemplate;
    streamState.totalPage = parsePositiveInteger(pager.getAttribute('data-totalpage')) || streamState.totalPage;
    const currentPage = parsePositiveInteger(pager.getAttribute('data-curpage'));
    streamState.nextPage = currentPage && currentPage < streamState.totalPage ? currentPage + 1 : 0;
}

function updateStreamReadyStatus() {
    if (streamState.nextPage) {
        setStreamStatus('向下滚动加载更多房源');
    } else {
        setStreamStatus('已加载全部房源');
    }
}

function getCardsFromDocument(doc) {
    return Array.from(doc.querySelectorAll('.content__list--item'));
}

function appendNewCards(cards, page) {
    let appended = 0;
    cards.forEach((card) => {
        const key = getListingKey(getListingData(card));
        if (!key || streamState.seenKeys.has(key)) return;
        streamState.seenKeys.add(key);
        const imported = document.importNode(card, true);
        imported.dataset.ljStreamPage = String(page);
        streamState.list.append(imported);
        appended += 1;
    });
    return appended;
}

async function loadNextPage() {
    if (streamState.loading || !streamState.nextPage) return;

    const page = streamState.nextPage;
    const nextUrl = buildPageUrl(streamState.pageUrlTemplate, page, window.location.href);
    if (!nextUrl) return;

    streamState.loading = true;
    setStreamStatus(`正在加载第 ${page} 页...`);

    try {
        const response = await fetch(nextUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const cards = getCardsFromDocument(doc);
        const appended = appendNewCards(cards, page);
        const nextPager = doc.querySelector('.content__pg[data-url][data-totalpage][data-curpage]');
        if (nextPager) {
            updateStreamPager(nextPager, false);
        } else {
            streamState.nextPage = page < streamState.totalPage ? page + 1 : 0;
        }
        if (streamState.pager) {
            streamState.pager.setAttribute('data-curpage', String(page));
        }
        applyCurrentFilters();
        updateStreamReadyStatus();
        if (!appended && streamState.nextPage) {
            loadNextPage();
        }
    } catch {
        setStreamStatus('加载失败，点击重试', true);
    } finally {
        streamState.loading = false;
    }
}

function shouldLoadMore() {
    if (!streamState.nextPage || streamState.loading) return false;
    const distanceToBottom = document.documentElement.scrollHeight - window.innerHeight - window.pageYOffset;
    return distanceToBottom <= STREAM_LOAD_THRESHOLD_PX;
}

function onStreamScroll() {
    if (shouldLoadMore()) {
        loadNextPage();
    }
}

function observeStreamStatus() {
    if (streamState.observer || typeof IntersectionObserver !== 'function' || !streamState.status) return;

    streamState.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
            loadNextPage();
        }
    }, { rootMargin: `${STREAM_LOAD_THRESHOLD_PX}px 0px` });
    streamState.observer.observe(streamState.status);
}

function initInfiniteScroll() {
    if (streamState.initialized) return;

    const list = document.querySelector('.content__list');
    const pager = findPagination();
    if (!list || !pager) return;

    streamState.initialized = true;
    streamState.list = list;
    updateStreamPager(pager);
    collectSeenListingKeys();
    ensureStreamStatus();
    updateStreamReadyStatus();
    observeStreamStatus();

    window.addEventListener('scroll', onStreamScroll, { passive: true });
    window.addEventListener('resize', onStreamScroll, { passive: true });
    window.setTimeout(onStreamScroll, 100);
}

function isAssistantOwnedNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!element?.closest?.('.lj-rent-map-panel,.lj-stream-status,[data-lj-content-filter-row="true"]');
}

function startContentObserver() {
    const observer = new MutationObserver((mutations) => {
        const hasRelevantChange = mutations.some((mutation) => {
            const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
            return nodes.some((node) => !isAssistantOwnedNode(node)) && !isAssistantOwnedNode(mutation.target);
        });
        if (hasRelevantChange) {
            scheduleApply();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function init() {
    if (isRentDetailPageUrl(window.location.href)) {
        captureDetailPageCoordinate();
        return;
    }
    if (!isRentListPageUrl(window.location.href)) return;
    installStyles();
    scheduleApply();
    initInfiniteScroll();
    initListingMap();
    startContentObserver();
}

const api = {
    AUTO_FETCH_PAGE_DELAY_MS,
    COORDINATE_SOURCE_OPTIONS,
    buildPageUrl,
    buildGeocodeQuery,
    buildInfoWindowHtml,
    CONTENT_FILTER_HOST_LABEL,
    clearMapOverlaysIfPresent,
    DEFAULT_COORDINATE_SOURCE,
    DEFAULT_FILTER_STATE,
    DEFAULT_TIMING_SETTINGS,
    MAP_DETAIL_FETCH_DELAY_MS,
    classifyListingContent,
    extractMapPointFromDetailHtml,
    extractPreviewImageFromDetailHtml,
    fetchWithTimeout,
    filterMapRecordsByState,
    filterNewListingKeys,
    getAutoFetchNextPage,
    getAutoFetchPageDelay,
    getAutoFetchRetryDelay,
    getAutoFetchRetryStatusText,
    getCoordinateSourceSequence,
    getListingDetailUrl,
    getListingKeyFromDetailUrl,
    getListingKey,
    isSubwaySwitchLinkText,
    getMapQueueWaitMs,
    getSearchCacheRecords,
    hydrateMapRecordsFromCache,
    markAutoFetchCaptchaRetry,
    markAutoFetchPageFetched,
    mergeMapCacheRecords,
    normalizeAutoFetchState,
    normalizeCoordinateSource,
    normalizePreviewImageUrl,
    normalizeSubwayStationLinkHref,
    normalizeTimingSettings,
    normalizeMapPoint,
    normalizeFilterState,
    parseStoredMapCache,
    parseStoredFilterState,
    releaseQueuedMapRecordKeys,
    resetAutoFetchRetry,
    serializeFilterState,
    shouldShowListing
};

if (typeof module === 'object' && module.exports) {
    module.exports = api;
}

if (typeof document === 'object' && document.body) {
    init();
} else if (typeof document === 'object') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
}
})();
