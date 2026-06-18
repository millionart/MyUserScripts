// ==UserScript==
// @name         Lianjia Rent Assistant
// @name:zh-CN   链家租房助手
// @namespace    http://tampermonkey.net/
// @version      0.1.3
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
// ==/UserScript==
(function () {
'use strict';

const SCRIPT_VERSION = '0.1.3';
const STORAGE_KEY = 'LIANJIA_RENT_CONTENT_FILTER_STATE';
const CONTENT_FILTER_HOST_LABEL = '品牌';
const DEFAULT_FILTER_STATE = Object.freeze({
    beikePreferred: true,
    apartment: true
});

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
        '.lj-content-filter__option span{line-height:27px;}'
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
    }, 80);
}

function startContentObserver() {
    const observer = new MutationObserver((mutations) => {
        if (mutations.some((mutation) => mutation.addedNodes.length || mutation.removedNodes.length)) {
            scheduleApply();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function init() {
    if (!/^https:\/\/[^/]+\.lianjia\.com\/(?:ditiezufang|zufang)\//.test(window.location.href)) return;
    installStyles();
    scheduleApply();
    startContentObserver();
}

const api = {
    CONTENT_FILTER_HOST_LABEL,
    DEFAULT_FILTER_STATE,
    classifyListingContent,
    normalizeFilterState,
    parseStoredFilterState,
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
