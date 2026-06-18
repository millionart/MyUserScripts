// ==UserScript==
// @name         Lianjia Rent Assistant
// @name:zh-CN   链家租房助手
// @namespace    http://tampermonkey.net/
// @version      0.5.7
// @description  Enhance Lianjia rent pages with helper controls and listing tools.
// @description:zh-CN 增强链家租房列表页，提供筛选辅助和房源工具。
// @author       codex
// @license      MIT
// @match        https://*.lianjia.com/ditiezufang/
// @match        https://*.lianjia.com/ditiezufang/*
// @match        https://*.lianjia.com/zufang/
// @match        https://*.lianjia.com/zufang/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==
(function () {
'use strict';

const SCRIPT_VERSION = '0.5.7';
const STORAGE_KEY = 'LIANJIA_RENT_CONTENT_FILTER_STATE';
const MAP_CACHE_STORAGE_KEY = 'LIANJIA_RENT_MAP_LISTING_CACHE';
const AUTO_FETCH_STORAGE_KEY = 'LIANJIA_RENT_MAP_AUTO_FETCH_STATE';
const MAP_CACHE_VERSION = 1;
const CONTENT_FILTER_HOST_LABEL = '品牌';
const STREAM_LOAD_THRESHOLD_PX = 900;
const BAIDU_MAP_AK = 'djAasQ167kYWRGbjL2az8aGmHBUmXp4V';
const MAP_DETAIL_FETCH_LIMIT = 1;
const MAP_DETAIL_FETCH_DELAY_MS = 900;
const MAP_DETAIL_FETCH_TIMEOUT_MS = 10000;
const AUTO_FETCH_PAGE_DELAY_MS = 2500;
const AUTO_FETCH_RETRY_DELAYS_MS = [20000, 20000, 20000];
const DEFAULT_FILTER_STATE = Object.freeze({
    beikePreferred: true,
    apartment: true
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
    queuedKeys: new Set(),
    fetchedListings: new Map(),
    failedKeys: new Set(),
    activeFetches: 0,
    pendingRecords: [],
    blocked: false,
    cache: null
};

function normalizeFilterState(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        beikePreferred: source.beikePreferred !== false,
        apartment: source.apartment !== false
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
        apartment: /公寓/.test(text) || hrefs.some((href) => /\/apartment\//.test(String(href || '')))
    };
}

function shouldShowListing(kinds, state) {
    const filters = normalizeFilterState(state);
    return (filters.beikePreferred || !kinds.beikePreferred) && (filters.apartment || !kinds.apartment);
}

function normalizeListingKinds(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        beikePreferred: value.beikePreferred === true,
        apartment: value.apartment === true
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

function getAutoFetchRetryDelay(state) {
    const retryCount = Math.max(0, Number.parseInt(state?.retryCount, 10) || 0);
    const index = Math.min(retryCount, AUTO_FETCH_RETRY_DELAYS_MS.length - 1);
    return AUTO_FETCH_RETRY_DELAYS_MS[index];
}

function markAutoFetchCaptchaRetry(state) {
    const normalized = normalizeAutoFetchState(state);
    normalized.retryCount = Math.min((normalized.retryCount || 0) + 1, AUTO_FETCH_RETRY_DELAYS_MS.length);
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

function getListingKey(listing) {
    const houseCode = String(listing?.houseCode || '').trim();
    if (houseCode) return `house:${houseCode}`;

    const hrefs = Array.isArray(listing?.hrefs) ? listing.hrefs : [];
    const href = hrefs.map((value) => String(value || '').trim()).find(Boolean);
    return href ? `href:${href}` : '';
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
    const point = normalizeMapPoint(record?.point);
    if (point) normalized.point = point;
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
        const searchKeys = [
            ...(Array.isArray(existing?.searchKeys) ? existing.searchKeys : []),
            ...(Array.isArray(record?.searchKeys) ? record.searchKeys : []),
            sourceKey
        ].map((value) => String(value || '').trim()).filter(Boolean);
        const normalized = normalizeCachedMapRecord({
            ...existing,
            ...record,
            point: incomingPoint || existingPoint,
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
        return {
            ...record,
            point,
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
        apartment: row.querySelector('[data-lj-content-filter-option="apartment"]')?.checked
    });
}

function getListingData(card) {
    const hrefs = Array.from(card.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') || '');
    return {
        houseCode: card.getAttribute('data-house_code') || '',
        text: (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim(),
        hrefs
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
        '.lj-rent-map-panel__status{color:#888;font-size:12px;}',
        '.lj-rent-map-panel__canvas{height:360px;background:#f7f7f7;}',
        '.lj-rent-map-info{min-width:180px;max-width:260px;color:#394043;line-height:1.5;}',
        '.lj-rent-map-info__title{font-weight:600;margin-bottom:4px;}',
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

function scheduleApply() {
    window.clearTimeout(scheduleApply.timer);
    scheduleApply.timer = window.setTimeout(() => {
        const hostRow = ensureFilterControls();
        applyFilters(hostRow ? getCurrentFilterState(hostRow) : readStoredFilterState());
        refreshListingMap();
    }, 80);
}

function applyCurrentFilters() {
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

function getMapRecordFromCard(card) {
    const listing = getListingData(card);
    const key = getListingKey(listing);
    const detailUrl = getListingDetailUrl(listing, window.location.href);
    if (!key || !detailUrl) return null;
    return {
        key,
        detailUrl,
        title: getListingTitle(card),
        price: getListingPrice(card),
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
    actions.append(buildAutoFetchControl(), status);

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

function saveAutoFetchState(state) {
    mapState.autoFetchState = normalizeAutoFetchState(state);
    writeStoredAutoFetchState(mapState.autoFetchState);
}

function setAutoFetchStatus(text) {
    if (mapState.autoFetchStatus) {
        mapState.autoFetchStatus.textContent = text;
    }
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

function updateMapStatus(records) {
    if (mapState.blocked) {
        setMapStatus('遇到验证，稍后重试');
        return;
    }

    const mapped = records.filter((record) => mapState.fetchedListings.has(record.key)).length;
    const failed = records.filter((record) => mapState.failedKeys.has(record.key)).length;
    const pending = records.length - mapped - failed;

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

function buildInfoWindowHtml(record) {
    const title = escapeHtml(record.title);
    const price = escapeHtml(record.price);
    const detailUrl = escapeHtml(record.detailUrl);
    return [
        '<div class="lj-rent-map-info">',
        `<div class="lj-rent-map-info__title">${title}</div>`,
        price ? `<div class="lj-rent-map-info__price">${price}</div>` : '',
        `<a class="lj-rent-map-info__link" href="${detailUrl}" target="_blank" rel="noopener">查看房源</a>`,
        '</div>'
    ].join('');
}

function renderListingMap() {
    const records = getCurrentMapRecords();
    updateMapStatus(records);

    const mappedRecords = records
        .map((record) => mapState.fetchedListings.get(record.key))
        .filter((record) => record?.point);
    if (!mappedRecords.length) return;

    ensureMapReady().then((map) => {
        const BMap = getPageWindow().BMap;
        if (!BMap) return;

        map.clearOverlays();
        const points = mappedRecords.map((record) => new BMap.Point(record.point.longitude, record.point.latitude));
        mappedRecords.forEach((record, index) => {
            const point = points[index];
            const marker = new BMap.Marker(point);
            const infoWindow = new BMap.InfoWindow(buildInfoWindowHtml(record));
            marker.addEventListener('click', () => {
                map.openInfoWindow(infoWindow, point);
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

async function fetchMapRecord(record) {
    const response = await fetchWithTimeout(record.detailUrl, { credentials: 'same-origin' }, MAP_DETAIL_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (isCaptchaResponse(response, html)) {
        throw new Error('captcha');
    }
    const point = extractMapPointFromDetailHtml(html);
    if (!point) throw new Error('coordinate missing');
    const cachedRecord = { ...record, point };
    mapState.fetchedListings.set(record.key, cachedRecord);
    rememberMapRecords([cachedRecord]);
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

function isCaptchaResponse(response, html) {
    return /\/captcha(?:\?|$)/.test(response?.url || '') || /hip\.lianjia\.com\/captcha|人机验证|CAPTCHA/.test(String(html || ''));
}

function releaseQueuedMapRecordKeys(queuedKeys, records) {
    records.forEach((record) => {
        if (record?.key) queuedKeys.delete(record.key);
    });
    return queuedKeys;
}

function processMapQueue() {
    if (mapState.blocked) return;

    while (mapState.activeFetches < MAP_DETAIL_FETCH_LIMIT && mapState.pendingRecords.length) {
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
                mapState.queuedKeys.delete(record.key);
                renderListingMap();
                if (!mapState.blocked) {
                    window.setTimeout(processMapQueue, MAP_DETAIL_FETCH_DELAY_MS);
                }
            });
    }
}

function enqueueMapRecords(records) {
    if (mapState.blocked) return;

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
    mapState.autoFetchTimer = 0;
    mapState.autoFetchLoading = false;
    setAutoFetchStatus('');
}

function scheduleAutoFetch(delay = AUTO_FETCH_PAGE_DELAY_MS) {
    window.clearTimeout(mapState.autoFetchTimer);
    if (!getAutoFetchState().enabled) return;
    mapState.autoFetchTimer = window.setTimeout(runAutoFetchStep, delay);
}

function startAutoFetch() {
    if (mapState.blocked) {
        setAutoFetchStatus('等待重试');
        scheduleAutoFetch(getAutoFetchRetryDelay(getAutoFetchState()));
        return;
    }
    setAutoFetchStatus('等待中');
    scheduleAutoFetch(0);
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
    const delay = getAutoFetchRetryDelay(currentState);
    const state = markAutoFetchCaptchaRetry(currentState);
    saveAutoFetchState(state);
    setAutoFetchStatus(`遇到验证，${Math.round(delay / 1000)} 秒后重试`);
    setMapStatus('遇到验证，稍后重试');
    scheduleAutoFetch(delay);
}

async function runAutoFetchStep() {
    if (!getAutoFetchState().enabled || mapState.autoFetchLoading) return;
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
        scheduleAutoFetch(AUTO_FETCH_PAGE_DELAY_MS * 2);
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
    if (getAutoFetchState().enabled) {
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
    if (!/^https:\/\/[^/]+\.lianjia\.com\/(?:ditiezufang|zufang)\//.test(window.location.href)) return;
    installStyles();
    scheduleApply();
    initInfiniteScroll();
    initListingMap();
    startContentObserver();
}

const api = {
    buildPageUrl,
    CONTENT_FILTER_HOST_LABEL,
    DEFAULT_FILTER_STATE,
    classifyListingContent,
    extractMapPointFromDetailHtml,
    fetchWithTimeout,
    filterMapRecordsByState,
    filterNewListingKeys,
    getAutoFetchNextPage,
    getAutoFetchRetryDelay,
    getListingDetailUrl,
    getListingKey,
    getSearchCacheRecords,
    hydrateMapRecordsFromCache,
    markAutoFetchCaptchaRetry,
    markAutoFetchPageFetched,
    mergeMapCacheRecords,
    normalizeAutoFetchState,
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
