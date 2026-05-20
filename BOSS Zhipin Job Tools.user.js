// ==UserScript==
// @name         BOSS Zhipin Job Tools
// @name:zh-CN   BOSS直聘职位忽略与活跃排序
// @namespace    https://github.com/milli/youtube-subscription-category-manager
// @version      0.1.28
// @description  在 BOSS 直聘职位列表详情区添加忽略、隐藏筛选，并支持按发布者活跃时间排序当前已加载职位。
// @author       Codex
// @license      MIT
// @match        https://www.zhipin.com/web/geek/jobs*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    const APP_ID = 'bzjt';
    const SCRIPT_VERSION = '0.1.28';
    const STORAGE_KEY = 'boss-zhipin-job-tools:ignored-jobs';
    const ACTIVE_TIME_CACHE_STORAGE_KEY = 'boss-zhipin-job-tools:active-time-cache';
    const HIDDEN_FILTER_SETTINGS_STORAGE_KEY = 'boss-zhipin-job-tools:hidden-filter-settings';
    const CUSTOM_TAG_STORAGE_KEY = 'boss-zhipin-job-tools:custom-tags';
    const PAGE_SORT_EVENT = `${APP_ID}:sort-job-list`;
    const PAGE_SORT_RESULT_EVENT = `${APP_ID}:sort-job-list-result`;
    const LOAD_MORE_SCROLL_PASSES = 6;
    const LOAD_MORE_SCROLL_DELAY_MS = 850;
    const LOAD_MORE_MAX_CARDS = 80;
    const UNKNOWN_ACTIVE_RANK = Number.MAX_SAFE_INTEGER;

    const state = {
        ignoredJobs: new Map(),
        activeTimeCache: new Map(),
        customTags: new Map(),
        mutationObserver: null,
        refreshTimer: null,
        scanning: false,
        scanToken: 0,
        filtersSuspendedForLoading: false,
        showIgnored: false,
        settingsOpen: false,
        hiddenFilters: { keywords: [], minSalaryMaxK: 0 },
        lastSortedCount: 0,
        lastStatusText: '',
        chatNewTabHandlerInstalled: false
    };

    function normalizeSpace(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function extractJobIdFromHref(href) {
        const text = String(href || '');
        const match = text.match(/\/job_detail\/([^/?#]+?)\.html(?:[?#]|$)/);
        return match ? match[1] : '';
    }

    function parseBossActiveTimeRank(text) {
        const value = normalizeSpace(text);
        if (!value) return UNKNOWN_ACTIVE_RANK;
        if (/刚刚|在线|当前/.test(value)) return 0;
        if (/今日|今天/.test(value)) return 10;
        if (/昨天/.test(value)) return 24 * 60;
        if (/前天/.test(value)) return 2 * 24 * 60;

        const match = value.match(/(\d+)\s*(分钟|小时|天|日|周|个月|月|年)/);
        if (!match) return UNKNOWN_ACTIVE_RANK;

        const amount = Number(match[1]);
        if (!Number.isFinite(amount)) return UNKNOWN_ACTIVE_RANK;

        const unit = match[2];
        if (unit === '分钟') return amount;
        if (unit === '小时') return amount * 60;
        if (unit === '天' || unit === '日') return amount * 24 * 60;
        if (unit === '周') return amount * 7 * 24 * 60;
        if (unit === '个月' || unit === '月') return amount * 30 * 24 * 60;
        if (unit === '年') return amount * 365 * 24 * 60;
        return UNKNOWN_ACTIVE_RANK;
    }

    function compareJobRecordsByActiveTime(left, right) {
        const rankDiff = getRecordRank(left) - getRecordRank(right);
        if (rankDiff !== 0) return rankDiff;
        return (Number(left && left.originalIndex) || 0) - (Number(right && right.originalIndex) || 0);
    }

    function getRecordRank(record) {
        const explicitRank = Number(record && record.activeRank);
        if (Number.isFinite(explicitRank)) return explicitRank;
        return parseBossActiveTimeRank(record && record.activeTimeText);
    }

    function getActiveTimeTextFromJobData(jobData) {
        if (!jobData || typeof jobData !== 'object') return '';
        return jobData.bossOnline ? '在线' : '';
    }

    function getJobDataId(jobData) {
        if (!jobData || typeof jobData !== 'object') return '';
        return normalizeSpace(jobData.encryptJobId || jobData.jobId || jobData.id || '');
    }

    function normalizeBossSalaryDigits(text) {
        return String(text || '').replace(/[\uE031-\uE03A]/g, (char) => {
            const digit = char.charCodeAt(0) - 0xE031;
            return digit >= 0 && digit <= 9 ? String(digit) : char;
        });
    }

    function parseBossSalaryMaxK(text) {
        const value = normalizeSpace(normalizeBossSalaryDigits(text));
        if (!value) return 0;

        const salaries = [];
        for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*[kKＫｋ]/g)) {
            salaries.push(Number(match[1]));
        }
        for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*千/g)) {
            salaries.push(Number(match[1]));
        }
        for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*万/g)) {
            salaries.push(Number(match[1]) * 10);
        }
        for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(?:元|块)\/\s*(?:时|小时)/g)) {
            salaries.push(Number(match[1]) * 8 * 30 / 1000);
        }
        if (!/[元块]\/\s*(?:天|日)/.test(value)) {
            for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(?:元|块)(?:\/\s*(?:月|每月))?/g)) {
                const amount = Number(match[1]);
                if (amount >= 1000) salaries.push(amount / 1000);
            }
        }

        const finite = salaries.filter(Number.isFinite);
        return finite.length ? Math.max(...finite) : 0;
    }

    function normalizeHiddenFilterKeywords(keywords) {
        const values = Array.isArray(keywords)
            ? keywords
            : String(keywords || '').split(/\r?\n/);
        const seen = new Set();
        return values
            .map((value) => normalizeSpace(value).toLowerCase())
            .filter((value) => {
                if (!value || seen.has(value)) return false;
                seen.add(value);
                return true;
            });
    }

    function normalizeHiddenFilterSettings(settings = {}) {
        const minSalaryMaxK = Number(settings.minSalaryMaxK);
        return {
            keywords: normalizeHiddenFilterKeywords(settings.keywords),
            minSalaryMaxK: Number.isFinite(minSalaryMaxK) && minSalaryMaxK > 0
                ? Math.round(minSalaryMaxK / 5) * 5
                : 0
        };
    }

    function normalizeCustomTagList(tags) {
        const values = Array.isArray(tags)
            ? tags
            : String(tags || '').split(/\r?\n/);
        const seen = new Set();
        return values
            .map(normalizeSpace)
            .filter((value) => {
                const key = value.toLowerCase();
                if (!value || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function normalizeCustomTagRecords(stored) {
        const entries = Array.isArray(stored)
            ? stored.map((record) => [record && record.id, record])
            : Object.entries(stored || {});

        return new Map(
            entries
                .map(([key, record]) => {
                    const id = normalizeSpace(key);
                    if (!id || !record || typeof record !== 'object') return null;

                    const tags = normalizeCustomTagList(record.tags);
                    if (!tags.length) return null;

                    const updatedAt = Number(record.updatedAt);
                    return [id, {
                        id,
                        tags,
                        ...(Number.isFinite(updatedAt) ? { updatedAt } : {})
                    }];
                })
                .filter(Boolean)
        );
    }

    function jobMatchesHiddenFilters(record, settings) {
        const filters = normalizeHiddenFilterSettings(settings);
        const searchableText = normalizeSpace([
            record && record.title,
            record && record.keywordText
        ].filter(Boolean).join(' ')).toLowerCase();
        if (searchableText && filters.keywords.some((keyword) => searchableText.includes(keyword))) return true;

        if (filters.minSalaryMaxK > 0) {
            const salaryMaxK = parseBossSalaryMaxK(record && record.salaryText);
            if (salaryMaxK > 0 && salaryMaxK < filters.minSalaryMaxK) return true;
        }

        return false;
    }

    function findNextVisibleJobIndex(records, currentIndex) {
        const items = Array.isArray(records) ? records : [];
        if (!items.length) return -1;

        for (let offset = 1; offset <= items.length; offset += 1) {
            const index = (currentIndex + offset) % items.length;
            if (items[index] && !items[index].ignored) return index;
        }
        return -1;
    }

    function safeGetValue(key, fallbackValue) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, fallbackValue);
        } catch (error) {
            console.warn(`[${APP_ID}] GM_getValue failed`, error);
        }

        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallbackValue;
        } catch (error) {
            console.warn(`[${APP_ID}] localStorage get failed`, error);
            return fallbackValue;
        }
    }

    function safeSetValue(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
                return;
            }
        } catch (error) {
            console.warn(`[${APP_ID}] GM_setValue failed`, error);
        }

        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`[${APP_ID}] localStorage set failed`, error);
        }
    }

    function normalizeStoredRecordMap(stored, schema = {}) {
        const textFields = Array.isArray(schema.textFields) ? schema.textFields : [];
        const numberFields = Array.isArray(schema.numberFields) ? schema.numberFields : [];
        const entries = Array.isArray(stored)
            ? stored.map((record) => [record && record.id, record])
            : Object.entries(stored || {});

        return new Map(
            entries
                .map(([key, record]) => {
                    const id = normalizeSpace(key);
                    if (!id || !record || typeof record !== 'object') return null;

                    const normalized = { id };
                    for (const field of textFields) {
                        const value = normalizeSpace(record[field]);
                        if (value) normalized[field] = value;
                    }

                    for (const field of numberFields) {
                        const value = Number(record[field]);
                        if (Number.isFinite(value)) normalized[field] = value;
                    }

                    return [id, normalized];
                })
                .filter(Boolean)
        );
    }

    function serializeRecordMap(records) {
        const value = {};
        for (const [id, record] of (records instanceof Map ? records : new Map()).entries()) {
            value[id] = { ...record, id };
        }
        return value;
    }

    function loadIgnoredJobs() {
        state.ignoredJobs = normalizeStoredRecordMap(safeGetValue(STORAGE_KEY, {}), {
            textFields: ['title', 'company', 'href'],
            numberFields: ['ignoredAt']
        });
    }

    function saveIgnoredJobs() {
        safeSetValue(STORAGE_KEY, serializeRecordMap(state.ignoredJobs));
    }

    function loadActiveTimeCache() {
        state.activeTimeCache = normalizeStoredRecordMap(safeGetValue(ACTIVE_TIME_CACHE_STORAGE_KEY, {}), {
            textFields: ['text'],
            numberFields: ['rank', 'seenAt']
        });
    }

    function saveActiveTimeCache() {
        safeSetValue(ACTIVE_TIME_CACHE_STORAGE_KEY, serializeRecordMap(state.activeTimeCache));
    }

    function loadHiddenFilterSettings() {
        state.hiddenFilters = normalizeHiddenFilterSettings(safeGetValue(HIDDEN_FILTER_SETTINGS_STORAGE_KEY, {}));
    }

    function saveHiddenFilterSettings() {
        safeSetValue(HIDDEN_FILTER_SETTINGS_STORAGE_KEY, state.hiddenFilters);
    }

    function loadCustomTags() {
        state.customTags = normalizeCustomTagRecords(safeGetValue(CUSTOM_TAG_STORAGE_KEY, {}));
    }

    function saveCustomTags() {
        safeSetValue(CUSTOM_TAG_STORAGE_KEY, serializeRecordMap(state.customTags));
    }

    function addStyle(css) {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
            return;
        }
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    function installStyles() {
        if (document.getElementById(`${APP_ID}-styles`)) return;
        const marker = document.createElement('meta');
        marker.id = `${APP_ID}-styles`;
        document.head.appendChild(marker);

        addStyle(`
            .${APP_ID}-toolbar {
                position: relative;
                display: inline-flex;
                align-items: center;
                gap: 10px;
                min-height: var(--bzjt-filter-height, 40px);
                margin: 0;
                padding: 0;
                border: 0;
                border-radius: 0;
                background: transparent;
                color: #414a60;
                font-size: 14px;
                box-sizing: border-box;
            }
            .${APP_ID}-toolbar button {
                appearance: none;
                height: var(--bzjt-filter-height, 40px);
                border: var(--bzjt-filter-border, 0);
                border-radius: var(--bzjt-filter-radius, 6px);
                background: var(--bzjt-filter-bg, #fff);
                color: var(--bzjt-filter-color, #414a60);
                font-family: inherit;
                font-size: var(--bzjt-filter-font-size, 14px);
                line-height: var(--bzjt-filter-line-height, 40px);
                min-width: var(--bzjt-filter-min-width, 68px);
                padding: var(--bzjt-filter-padding, 0 16px);
                text-align: center;
                cursor: pointer;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .${APP_ID}-toolbar button:hover {
                color: #00a6a7;
                background: var(--bzjt-filter-hover-bg, var(--bzjt-filter-bg, #fff));
            }
            .${APP_ID}-ignore-btn {
                appearance: none;
                height: var(--bzjt-detail-button-height, 36px);
                border: 1px solid #ff5a5f;
                border-radius: var(--bzjt-detail-button-radius, 8px);
                background: #ff5a5f;
                color: #fff;
                font-family: inherit;
                font-size: var(--bzjt-detail-button-font-size, 14px);
                line-height: var(--bzjt-detail-button-line-height, 34px);
                padding: var(--bzjt-detail-button-padding, 0 16px);
                margin-left: var(--bzjt-detail-button-gap, 12px);
                vertical-align: middle;
                cursor: pointer;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .${APP_ID}-ignore-btn:hover {
                border-color: #f04449;
                background: #f04449;
                color: #fff;
            }
            .${APP_ID}-ignore-btn.${APP_ID}-ignore-btn-active {
                border-color: #00bebd;
                background: #f0fffe;
                color: #00a6a7;
            }
            .${APP_ID}-ignore-btn.${APP_ID}-ignore-btn-active:hover {
                background: #e5fffc;
                color: #00a6a7;
            }
            .${APP_ID}-toolbar button:disabled,
            .${APP_ID}-ignore-btn:disabled {
                cursor: not-allowed;
                color: #b8bdc7;
                border-color: #edf0f5;
                background: #f8f9fb;
            }
            .${APP_ID}-status {
                display: inline-flex;
                align-items: center;
                height: var(--bzjt-filter-height, 40px);
                min-width: 0;
                max-width: 190px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #8d92a1;
            }
            .${APP_ID}-ignored-job {
                display: none !important;
            }
            .${APP_ID}-filtered-job {
                display: none !important;
            }
            .${APP_ID}-settings-panel {
                position: absolute;
                top: 46px;
                right: 0;
                z-index: 2147483646;
                width: 286px;
                padding: 12px;
                border: 1px solid #d8dde6;
                border-radius: 6px;
                background: #fff;
                color: #1f2d3d;
                box-shadow: 0 10px 28px rgba(20, 29, 40, 0.16);
                box-sizing: border-box;
            }
            .${APP_ID}-settings-panel[hidden] {
                display: none;
            }
            .${APP_ID}-settings-field {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin: 0 0 12px;
                color: #414a60;
                font-size: 13px;
            }
            .${APP_ID}-settings-field textarea {
                width: 100%;
                min-height: 96px;
                resize: vertical;
                border: 1px solid #e3e7ed;
                border-radius: 4px;
                padding: 8px;
                color: #414a60;
                font-size: 13px;
                line-height: 1.45;
                box-sizing: border-box;
            }
            .${APP_ID}-settings-field textarea:focus {
                border-color: #00bebd;
                outline: 0;
            }
            .${APP_ID}-settings-range-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .${APP_ID}-settings-range-value {
                color: #00a57f;
                font-weight: 600;
                white-space: nowrap;
            }
            .${APP_ID}-settings-field input[type="range"] {
                width: 100%;
                accent-color: #00bebd;
            }
            .${APP_ID}-active-badge {
                display: inline-flex;
                align-items: center;
                max-width: 118px;
                height: 20px;
                margin-left: 8px;
                padding: 0 6px;
                border-radius: 4px;
                background: #ecfdf7;
                color: #00856f;
                font-size: 12px;
                line-height: 20px;
                vertical-align: middle;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .${APP_ID}-custom-tag-wrap {
                display: inline-flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 12px;
                margin-left: 12px;
                vertical-align: middle;
            }
            .${APP_ID}-custom-tag-row {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 12px;
                min-height: 42px;
                margin: 10px 0 18px;
            }
            .${APP_ID}-custom-tag-row .${APP_ID}-custom-tag-wrap {
                margin-left: 0;
            }
            .${APP_ID}-custom-tag,
            .${APP_ID}-custom-tag-add {
                display: inline-flex;
                align-items: center;
                max-width: 130px;
                height: 42px;
                padding: 0 18px;
                border: 0;
                border-radius: 4px;
                background: #f8f8f8;
                color: #414a60;
                font-size: 16px;
                line-height: 42px;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .${APP_ID}-custom-tag-text {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .${APP_ID}-custom-tag-remove {
                appearance: none;
                border: 0;
                background: transparent;
                color: #8d92a1;
                font-family: inherit;
                cursor: pointer;
                box-sizing: border-box;
                width: 16px;
                height: 16px;
                margin-left: 8px;
                padding: 0;
                font-size: 14px;
                line-height: 14px;
            }
            .${APP_ID}-custom-tag-add {
                appearance: none;
                cursor: pointer;
                font-family: inherit;
            }
            .${APP_ID}-custom-tag-add:hover,
            .${APP_ID}-custom-tag-remove:hover {
                color: #00a6a7;
            }
            .${APP_ID}-toast {
                position: fixed;
                right: 22px;
                bottom: 24px;
                z-index: 2147483647;
                max-width: 320px;
                padding: 10px 12px;
                border-radius: 6px;
                background: rgba(20, 29, 40, 0.92);
                color: #fff;
                font-size: 13px;
                line-height: 1.5;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
            }
            .${APP_ID}-toast-action {
                margin-left: 10px;
                border: 0;
                border-radius: 4px;
                background: #fff;
                color: #00a6a7;
                font-size: 13px;
                line-height: 24px;
                padding: 0 8px;
                cursor: pointer;
            }
            .${APP_ID}-toast-action:hover {
                color: #008f91;
            }
        `);
    }

    function installPageBridge() {
        const source = `
            (() => {
                if (window.__bzjtPageBridgeInstalled) return;
                window.__bzjtPageBridgeInstalled = true;

                const SORT_EVENT = 'bzjt:sort-job-list';
                const SORT_RESULT_EVENT = 'bzjt:sort-job-list-result';
                const CHAT_RESULT_EVENT = 'bzjt:chat-new-tab-result';

                function normalizeSpace(value) {
                    return String(value || '').replace(/\\s+/g, ' ').trim();
                }

                function getJobDataId(jobData) {
                    if (!jobData || typeof jobData !== 'object') return '';
                    return normalizeSpace(jobData.encryptJobId || jobData.jobId || jobData.id || '');
                }

                function getCards() {
                    return Array.from(document.querySelectorAll('.job-list-container .job-card-wrap, .rec-job-list .job-card-wrap'));
                }

                function getListController() {
                    for (const card of getCards()) {
                        let cursor = card && card.__vue__;
                        while (cursor) {
                            if (Array.isArray(cursor.jobList)) return cursor;
                            cursor = cursor.$parent;
                        }
                    }
                    return null;
                }

                function normalizeNavigableUrl(url) {
                    const value = normalizeSpace(url);
                    if (!value || value === '#' || /^javascript:/i.test(value) || /^about:blank$/i.test(value)) return '';

                    try {
                        return new URL(value, location.href).href;
                    } catch (error) {
                        return '';
                    }
                }

                function sendChatResult(ok, url, message) {
                    window.dispatchEvent(new CustomEvent(CHAT_RESULT_EVENT, {
                        detail: JSON.stringify({ ok, url: url || '', message: message || '' })
                    }));
                }

                function getChatActionFromEventTarget(target) {
                    if (!(target instanceof Element)) return null;

                    const element = target.closest('a, button, [role="button"]');
                    if (!element) return null;

                    const detailTarget = element.closest('.job-detail-header, .job-detail-op, .job-detail-container, .job-detail-box, .job-detail-section');
                    if (!detailTarget) return null;

                    return /立即沟通|继续沟通|沟通/.test(normalizeSpace(element.textContent || '')) ? element : null;
                }

                function getDirectChatHref(element) {
                    const anchor = element && element.matches && element.matches('a[href]') ? element : element && element.closest && element.closest('a[href]');
                    return normalizeNavigableUrl(anchor ? anchor.getAttribute('href') : '');
                }

                function openChatTarget(url, popup) {
                    const targetUrl = normalizeNavigableUrl(url);
                    if (!targetUrl || targetUrl === location.href) return false;

                    if (popup && !popup.closed) {
                        try {
                            popup.opener = null;
                        } catch (error) {
                            // Best effort only.
                        }
                        popup.location.href = targetUrl;
                    } else {
                        window.open(targetUrl, '_blank', 'noopener,noreferrer');
                    }
                    sendChatResult(true, targetUrl, '');
                    return true;
                }

                function handleChatActionClick(event) {
                    const action = getChatActionFromEventTarget(event.target);
                    if (!action) return;

                    const directHref = getDirectChatHref(action);
                    if (directHref) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        openChatTarget(directHref);
                        return;
                    }

                    event.preventDefault();
                    const originalPushState = history.pushState;
                    const originalReplaceState = history.replaceState;
                    const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
                    let diverted = false;

                    function restoreHistory() {
                        if (history.pushState === interceptPushState) history.pushState = originalPushState;
                        if (history.replaceState === interceptReplaceState) history.replaceState = originalReplaceState;
                    }

                    function makeHistoryRouteInterceptor(originalMethod) {
                        return function interceptedHistoryRoute(stateValue, title, url) {
                            if (openChatTarget(url, popup)) {
                                diverted = true;
                                window.setTimeout(restoreHistory, 0);
                                return undefined;
                            }
                            return originalMethod.apply(this, arguments);
                        };
                    }

                    const interceptPushState = makeHistoryRouteInterceptor(originalPushState);
                    const interceptReplaceState = makeHistoryRouteInterceptor(originalReplaceState);
                    history.pushState = interceptPushState;
                    history.replaceState = interceptReplaceState;

                    window.setTimeout(() => {
                        restoreHistory();
                        if (!diverted && popup && !popup.closed) {
                            popup.close();
                            sendChatResult(false, '', 'no route captured');
                        }
                    }, 1200);
                }

                function sendResult(requestId, ok, count, message) {
                    window.dispatchEvent(new CustomEvent(SORT_RESULT_EVENT, {
                        detail: JSON.stringify({ requestId, ok, count, message })
                    }));
                }

                window.addEventListener(SORT_EVENT, (event) => {
                    let payload = {};
                    try {
                        payload = JSON.parse(String(event.detail || '{}'));
                    } catch (error) {
                        sendResult('', false, 0, 'bad payload');
                        return;
                    }

                    const requestId = normalizeSpace(payload.requestId);
                    const sortedIds = Array.isArray(payload.sortedIds)
                        ? payload.sortedIds.map(normalizeSpace).filter(Boolean)
                        : [];

                    try {
                        const controller = getListController();
                        if (!controller || !Array.isArray(controller.jobList)) {
                            sendResult(requestId, false, 0, 'jobList not found');
                            return;
                        }

                        const targetIds = new Set(sortedIds);
                        const jobById = new Map();
                        for (const jobData of controller.jobList) {
                            const id = getJobDataId(jobData);
                            if (id && !jobById.has(id)) jobById.set(id, jobData);
                        }

                        const sortedJobData = sortedIds
                            .map((id) => jobById.get(id))
                            .filter(Boolean);
                        if (!sortedJobData.length) {
                            sendResult(requestId, false, 0, 'sorted jobs not found');
                            return;
                        }

                        let cursor = 0;
                        const reordered = controller.jobList.map((jobData) => {
                            const id = getJobDataId(jobData);
                            if (!targetIds.has(id)) return jobData;
                            const replacement = sortedJobData[cursor];
                            cursor += 1;
                            return replacement || jobData;
                        });

                        controller.jobList.splice(0, controller.jobList.length, ...reordered);
                        if (typeof controller.$forceUpdate === 'function') controller.$forceUpdate();
                        sendResult(requestId, cursor > 0, cursor, '');
                    } catch (error) {
                        sendResult(requestId, false, 0, error && error.message ? error.message : String(error));
                    }
                });

                window.addEventListener('click', handleChatActionClick, true);
            })();
        `;

        try {
            if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.eval === 'function') {
                unsafeWindow.eval(source);
                return;
            }
        } catch (error) {
            console.warn(`[${APP_ID}] page bridge eval failed`, error);
        }

        if (document.getElementById(`${APP_ID}-page-bridge`)) return;
        const script = document.createElement('script');
        script.id = `${APP_ID}-page-bridge`;
        script.textContent = source;
        document.documentElement.appendChild(script);
        script.remove();
    }

    function getJobCards() {
        return Array.from(document.querySelectorAll('.job-list-container .job-card-wrap, .rec-job-list .job-card-wrap'))
            .filter((card, index, cards) => cards.indexOf(card) === index);
    }

    function findJobCardById(id) {
        const targetId = normalizeSpace(id);
        if (!targetId) return null;
        return getJobCards().find((card) => getJobIdFromCard(card) === targetId) || null;
    }

    function getPageDocument() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow.document) return unsafeWindow.document;
        } catch (error) {
            // Fall back to the userscript document wrapper.
        }
        return document;
    }

    function getPageCardForCard(card) {
        if (!card) return null;
        const id = getJobIdFromCard(card);
        const pageCards = Array.from(getPageDocument().querySelectorAll('.job-list-container .job-card-wrap, .rec-job-list .job-card-wrap'));
        if (id) {
            const matched = pageCards.find((candidate) => getJobIdFromCard(candidate) === id);
            if (matched) return matched;
        }

        const index = getJobCards().indexOf(card);
        return index >= 0 ? pageCards[index] || card : card;
    }

    function getJobListParent() {
        const firstCard = getJobCards()[0];
        return firstCard ? firstCard.parentElement : document.querySelector('.rec-job-list, .job-list-container');
    }

    function findToolbarAnchor() {
        const exact = Array.from(document.querySelectorAll('.condition-filter-select, .current-select, span, div'))
            .filter((element) => normalizeSpace(element.textContent) === '公司规模')
            .find((element) => element.closest('.filter-condition-inner'));
        if (!exact) return null;
        return exact.classList.contains('condition-filter-select')
            ? exact
            : exact.closest('.condition-filter-select') || exact;
    }

    function findToolbarHost() {
        return document.querySelector('.filter-condition-inner') || findToolbarAnchor()?.parentElement || null;
    }

    function getCardAnchor(card) {
        return card ? card.querySelector('a.job-name[href], a[href*="/job_detail/"]') : null;
    }

    function getJobIdFromCard(card) {
        return extractJobIdFromHref(getCardAnchor(card)?.getAttribute('href') || getCardAnchor(card)?.href || '');
    }

    function getJobHrefFromCard(card) {
        const anchor = getCardAnchor(card);
        if (!anchor) return '';
        try {
            return new URL(anchor.getAttribute('href') || anchor.href, location.origin).href;
        } catch (error) {
            return anchor.href || '';
        }
    }

    function getCardTitle(card) {
        return normalizeSpace(card?.querySelector('.job-name')?.textContent || '');
    }

    function getCardCompany(card) {
        return normalizeSpace(card?.querySelector('.boss-name')?.textContent || '');
    }

    function getCardSalaryText(card) {
        return normalizeSpace(card?.querySelector('.salary, .job-salary, [class*="salary"]')?.textContent || '');
    }

    function getTextFromElements(elements) {
        return normalizeSpace(Array.from(elements || [])
            .map((element) => normalizeSpace(element.textContent))
            .filter(Boolean)
            .join(' '));
    }

    function getCardKeywordText(card) {
        if (!card) return '';

        const containers = card.querySelectorAll([
            '.tag-list',
            '.job-tag-list',
            '.job-card-tag-list',
            '.job-card-tags',
            '.job-tags',
            '[class*="tag-list"]',
            '[class*="job-tags"]'
        ].join(','));
        const containerText = getTextFromElements(containers);
        if (containerText) return containerText;

        return getTextFromElements(card.querySelectorAll([
            '.job-info .tag',
            '.job-info .label',
            '.job-info li',
            '.job-card-body .tag',
            '.job-card-body .label',
            '.job-card-body li'
        ].join(',')));
    }

    function getCardActiveTimeText(card) {
        if (!card) return '';

        const preferredText = getTextFromElements(card.querySelectorAll([
            `.${APP_ID}-active-badge`,
            '.boss-active-time',
            '[class*="active-time"]',
            '[class*="activeTime"]',
            '[class*="online"]',
            '.job-card-footer',
            '.job-info',
            '.info-public'
        ].join(',')));
        return extractBossActiveTimeText(preferredText) || extractBossActiveTimeText(card.textContent || '');
    }

    function getDetailKeywordText() {
        return getTextFromElements(document.querySelectorAll([
            '.job-keyword-list',
            '.job-tags',
            '.job-labels',
            '.job-detail-tags',
            '.job-detail-section .tag-list',
            '.job-detail-section [class*="tag-list"]',
            '.job-detail-container [class*="keyword"]',
            '.job-detail-container [class*="tag-list"]'
        ].join(',')));
    }

    function getCustomTagsForJob(id) {
        return normalizeCustomTagList(state.customTags.get(normalizeSpace(id))?.tags || []);
    }

    function getCustomTagTextForJob(id) {
        return getCustomTagsForJob(id).join(' ');
    }

    function getCardFilterKeywordText(card) {
        const id = getJobIdFromCard(card);
        return normalizeSpace([getCardKeywordText(card), getCustomTagTextForJob(id)].filter(Boolean).join(' '));
    }

    function findJobDescriptionHeading() {
        return Array.from(document.querySelectorAll([
            '.job-detail-section h2',
            '.job-detail-section h3',
            '.job-detail-box h2',
            '.job-detail-box h3',
            '.job-detail-container h2',
            '.job-detail-container h3',
            '[class*="title"]'
        ].join(','))).find((element) => normalizeSpace(element.textContent) === '职位描述') || null;
    }

    function isElementAfter(element, anchor) {
        return Boolean(element && anchor && (anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
    }

    function findDetailTagHost() {
        const selectors = [
            '.job-keyword-list',
            '.job-tags',
            '.job-labels',
            '.job-detail-tags',
            '.tag-list',
            '[class*="tag-list"]'
        ].join(',');
        const heading = findJobDescriptionHeading();

        if (heading) {
            const scope = heading.closest('.job-detail-section, .job-detail-box, .job-detail-container, .detail-section, .job-sec')
                || heading.parentElement
                || document;
            const candidates = Array.from(scope.querySelectorAll(selectors))
                .filter((candidate) => isVisibleElement(candidate) && isElementAfter(candidate, heading));
            if (candidates.length) {
                return candidates.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
            }
        }

        return Array.from(document.querySelectorAll([
            '.job-detail-section .tag-list',
            '.job-detail-section [class*="tag-list"]',
            '.job-detail-container .job-keyword-list',
            '.job-detail-container .job-detail-tags'
        ].join(','))).find(isVisibleElement) || null;
    }

    function ensureDetailTagHost() {
        const existing = findDetailTagHost();
        if (existing) return existing;

        const heading = findJobDescriptionHeading();
        if (!heading || !heading.parentElement) return null;

        let host = heading.parentElement.querySelector(`.${APP_ID}-custom-tag-row`);
        if (!host) {
            const container = heading.parentElement;
            host = document.createElement('div');
            host.className = `${APP_ID}-custom-tag-row`;
            container.insertBefore(host, heading.nextSibling);
        }
        return host;
    }

    function getActiveJobCard() {
        const activeCard = document.querySelector('.job-card-wrap.active');
        if (activeCard && getJobIdFromCard(activeCard)) return activeCard;
        return null;
    }

    function findCardByDetailTitle() {
        const title = normalizeSpace(document.querySelector('.job-detail-header .job-name, .job-detail-header h1, .job-detail-header .name')?.textContent || '');
        if (!title) return null;
        return getJobCards().find((card) => getCardTitle(card) === title) || null;
    }

    function getCurrentJobCard() {
        return getActiveJobCard() || findCardByDetailTitle();
    }

    function getCurrentJobRecord() {
        const card = getCurrentJobCard();
        if (!card) return null;

        const id = getJobIdFromCard(card);
        if (!id) return null;

        return {
            id,
            title: getCardTitle(card),
            company: getCardCompany(card),
            salaryText: getCardSalaryText(card),
            keywordText: normalizeSpace([
                getCardKeywordText(card) || getDetailKeywordText(),
                getCustomTagTextForJob(id)
            ].filter(Boolean).join(' ')),
            href: getJobHrefFromCard(card),
            card
        };
    }

    function getDetailActiveTimeText() {
        return normalizeSpace(document.querySelector('.job-detail-container .boss-active-time, .job-detail-box .boss-active-time')?.textContent || '');
    }

    function findDetailButtonTarget() {
        return document.querySelector('.job-detail-header .job-detail-op, .job-detail-op, .job-detail-header');
    }

    function extractBossActiveTimeText(text) {
        const value = normalizeSpace(text);
        if (!value) return '';

        const match = value.match(/((?:刚刚|当前|今日|今天|昨天|前天)活跃|在线|(?:\d+\s*(?:分钟|小时|天|日|周|个月|月|年)(?:内|前)?活跃))/);
        return match ? normalizeSpace(match[1]) : '';
    }

    function isVisibleElement(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function getReadableBorder(style) {
        return style.borderTopWidth === '0px' || style.borderTopStyle === 'none'
            ? '0'
            : style.borderTop;
    }

    function syncToolbarButtonStyle(toolbar, anchor) {
        if (!toolbar || !anchor || !isVisibleElement(anchor)) return;

        const style = getComputedStyle(anchor);
        const rect = anchor.getBoundingClientRect();
        toolbar.style.setProperty('--bzjt-filter-height', `${Math.round(rect.height)}px`);
        toolbar.style.setProperty('--bzjt-filter-border', getReadableBorder(style));
        toolbar.style.setProperty('--bzjt-filter-radius', style.borderRadius);
        toolbar.style.setProperty('--bzjt-filter-bg', style.backgroundColor);
        toolbar.style.setProperty('--bzjt-filter-hover-bg', style.backgroundColor);
        toolbar.style.setProperty('--bzjt-filter-color', style.color);
        toolbar.style.setProperty('--bzjt-filter-font-size', style.fontSize);
        toolbar.style.setProperty('--bzjt-filter-line-height', style.lineHeight);
        toolbar.style.setProperty('--bzjt-filter-padding', `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`);
    }

    function findDetailButtonPeer(target) {
        const peers = Array.from(target.querySelectorAll('a, button'))
            .filter((element) => !element.classList.contains(`${APP_ID}-ignore-btn`) && isVisibleElement(element));
        return peers.find((element) => /立即沟通|沟通/.test(normalizeSpace(element.textContent || ''))) || peers[0] || null;
    }

    function findChatActionElements() {
        const target = findDetailButtonTarget();
        if (!target) return [];

        return Array.from(target.querySelectorAll('a, button, [role="button"]'))
            .filter((element) => {
                if (element.classList.contains(`${APP_ID}-ignore-btn`)) return false;
                if (!isVisibleElement(element)) return false;
                return /立即沟通|沟通/.test(normalizeSpace(element.textContent || ''));
            });
    }

    function getPageWindow() {
        return typeof unsafeWindow === 'object' && unsafeWindow ? unsafeWindow : window;
    }

    function getChatActionFromEventTarget(target) {
        const detailTarget = findDetailButtonTarget();
        if (!detailTarget || !(target instanceof Element)) return null;

        const element = target.closest('a, button, [role="button"]');
        if (!element || !detailTarget.contains(element)) return null;
        if (element.classList.contains(`${APP_ID}-ignore-btn`)) return null;
        return /立即沟通|沟通/.test(normalizeSpace(element.textContent || '')) ? element : null;
    }

    function normalizeNavigableUrl(url) {
        const value = normalizeSpace(url);
        if (!value || value === '#' || /^javascript:/i.test(value) || /^about:blank$/i.test(value)) return '';

        try {
            return new URL(value, location.href).href;
        } catch (error) {
            return '';
        }
    }

    function getDirectChatHref(element) {
        const anchor = element?.matches?.('a[href]') ? element : element?.closest?.('a[href]');
        return normalizeNavigableUrl(anchor?.getAttribute('href') || '');
    }

    function openChatUrlInNewTab(url) {
        const targetUrl = normalizeNavigableUrl(url);
        if (!targetUrl || targetUrl === location.href) return false;

        const opened = window.open(targetUrl, '_blank', 'noopener,noreferrer');
        return Boolean(opened);
    }

    function handleChatActionClick(event) {
        const action = getChatActionFromEventTarget(event.target);
        if (!action) return;

        event.preventDefault();

        const directHref = getDirectChatHref(action);
        if (directHref) {
            event.stopImmediatePropagation();
            openChatUrlInNewTab(directHref);
            return;
        }

        const pageWindow = getPageWindow();
        const pageHistory = pageWindow.history;
        const originalPushState = pageHistory.pushState;
        const originalReplaceState = pageHistory.replaceState;
        let diverted = false;

        const restoreHistory = () => {
            if (pageHistory.pushState === makeHistoryRouteInterceptor.currentPushState) pageHistory.pushState = originalPushState;
            if (pageHistory.replaceState === makeHistoryRouteInterceptor.currentReplaceState) pageHistory.replaceState = originalReplaceState;
        };

        function makeHistoryRouteInterceptor(originalMethod) {
            return function interceptedHistoryRoute(stateValue, title, url) {
                const targetUrl = normalizeNavigableUrl(url);
                if (targetUrl && targetUrl !== location.href && openChatUrlInNewTab(targetUrl)) {
                    diverted = true;
                    window.setTimeout(restoreHistory, 0);
                    return undefined;
                }
                return originalMethod.apply(this, arguments);
            };
        }

        pageHistory.pushState = makeHistoryRouteInterceptor(originalPushState);
        makeHistoryRouteInterceptor.currentPushState = pageHistory.pushState;
        pageHistory.replaceState = makeHistoryRouteInterceptor(originalReplaceState);
        makeHistoryRouteInterceptor.currentReplaceState = pageHistory.replaceState;

        window.setTimeout(() => {
            restoreHistory();
            if (diverted) showToast('已在新标签打开沟通页');
        }, 1000);
    }

    function installChatNewTabClickHandler() {
        if (state.chatNewTabHandlerInstalled) return;
        document.addEventListener('click', handleChatActionClick, true);
        state.chatNewTabHandlerInstalled = true;
    }

    function ensureChatButtonsOpenInNewTabs() {
        for (const element of findChatActionElements()) {
            const anchor = element.matches('a[href]') ? element : element.closest('a[href]');
            if (!anchor) continue;

            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
        }
    }

    function syncIgnoreButtonStyle(button, target) {
        const peer = findDetailButtonPeer(target);
        if (!button || !peer) return;

        const style = getComputedStyle(peer);
        const rect = peer.getBoundingClientRect();
        button.style.setProperty('--bzjt-detail-button-height', `${Math.round(rect.height)}px`);
        button.style.setProperty('--bzjt-detail-button-radius', style.borderRadius);
        button.style.setProperty('--bzjt-detail-button-font-size', style.fontSize);
        button.style.setProperty('--bzjt-detail-button-line-height', style.lineHeight);
        button.style.setProperty('--bzjt-detail-button-padding', `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`);
        button.style.setProperty('--bzjt-detail-button-gap', style.marginLeft && style.marginLeft !== '0px' ? style.marginLeft : '12px');
    }

    function ensureIgnoreButton() {
        const target = findDetailButtonTarget();
        if (!target) return;

        let button = target.querySelector(`.${APP_ID}-ignore-btn`);
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = `${APP_ID}-ignore-btn`;
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleCurrentJobIgnored();
            });
            target.appendChild(button);
        }

        const record = getCurrentJobRecord();
        const ignored = Boolean(record && state.ignoredJobs.has(record.id));
        button.textContent = ignored ? '取消忽略' : '忽略该职位';
        button.classList.toggle(`${APP_ID}-ignore-btn-active`, ignored);
        button.disabled = !record;
        syncIgnoreButtonStyle(button, target);
    }

    function mountToolbar() {
        const host = findToolbarHost();
        const anchor = findToolbarAnchor();
        if (!host || !anchor) return;

        let toolbar = document.querySelector(`.${APP_ID}-toolbar`);
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.className = `${APP_ID}-toolbar`;
            toolbar.innerHTML = `
                <button type="button" class="${APP_ID}-sort-btn">按活跃排序</button>
                <button type="button" class="${APP_ID}-show-all-btn">显示已忽略</button>
                <button type="button" class="${APP_ID}-settings-btn" aria-expanded="false">设置</button>
                <span class="${APP_ID}-status"></span>
                <div class="${APP_ID}-settings-panel" hidden>
                    <label class="${APP_ID}-settings-field">
                        <span>职位忽略关键词</span>
                        <textarea class="${APP_ID}-keyword-input" placeholder="每行一个关键词"></textarea>
                    </label>
                    <label class="${APP_ID}-settings-field">
                        <span class="${APP_ID}-settings-range-row">
                            <span>最高薪资门槛</span>
                            <span class="${APP_ID}-settings-range-value"></span>
                        </span>
                        <input class="${APP_ID}-salary-range" type="range" min="0" max="100" step="5">
                    </label>
                </div>
            `;

            toolbar.querySelector(`.${APP_ID}-sort-btn`).addEventListener('click', () => {
                sortLoadedJobsByActiveTime();
            });
            toolbar.querySelector(`.${APP_ID}-show-all-btn`).addEventListener('click', () => {
                toggleIgnoredVisibility();
            });
            toolbar.querySelector(`.${APP_ID}-settings-btn`).addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                state.settingsOpen = !state.settingsOpen;
                updateSettingsPanel();
            });

            const panel = toolbar.querySelector(`.${APP_ID}-settings-panel`);
            panel.addEventListener('click', (event) => event.stopPropagation());
            panel.querySelector(`.${APP_ID}-keyword-input`).addEventListener('input', () => {
                commitSettingsFromPanel(panel);
            });
            panel.querySelector(`.${APP_ID}-salary-range`).addEventListener('input', () => {
                commitSettingsFromPanel(panel);
            });
        }
        syncToolbarButtonStyle(toolbar, anchor);
        toolbar.dataset.version = SCRIPT_VERSION;

        const next = anchor.nextSibling;
        if (toolbar.parentElement !== host || toolbar.previousSibling !== anchor) {
            host.insertBefore(toolbar, next);
        }
        updateSortButtonLabel();
        updateIgnoredToggleButton();
        updateSettingsPanel();
        updateToolbarStatus(state.lastStatusText);
    }

    function updateToolbarStatus(text) {
        state.lastStatusText = normalizeSpace(text);
        const status = document.querySelector(`.${APP_ID}-status`);
        if (!status) return;

        status.textContent = state.lastStatusText;
    }

    function formatButtonCount(value, showZero = false) {
        return showZero || value ? ` (${value})` : '';
    }

    function updateSortButtonLabel() {
        const button = document.querySelector(`.${APP_ID}-sort-btn`);
        if (!button || button.disabled) return;
        button.textContent = `按活跃排序${formatButtonCount(state.lastSortedCount)}`;
    }

    function updateIgnoredToggleButton() {
        const button = document.querySelector(`.${APP_ID}-show-all-btn`);
        if (!button) return;
        const label = state.showIgnored ? '隐藏已忽略' : '显示已忽略';
        button.textContent = `${label}${formatButtonCount(state.ignoredJobs.size, true)}`;
    }

    function updateSettingsPanel() {
        const button = document.querySelector(`.${APP_ID}-settings-btn`);
        const panel = document.querySelector(`.${APP_ID}-settings-panel`);
        if (!button || !panel) return;

        button.setAttribute('aria-expanded', String(state.settingsOpen));
        panel.hidden = !state.settingsOpen;

        const keywordsInput = panel.querySelector(`.${APP_ID}-keyword-input`);
        const salaryRange = panel.querySelector(`.${APP_ID}-salary-range`);
        const salaryValue = panel.querySelector(`.${APP_ID}-settings-range-value`);

        if (keywordsInput && document.activeElement !== keywordsInput) {
            keywordsInput.value = state.hiddenFilters.keywords.join('\n');
        }
        if (salaryRange && document.activeElement !== salaryRange) {
            salaryRange.value = String(state.hiddenFilters.minSalaryMaxK);
        }
        if (salaryValue) {
            salaryValue.textContent = state.hiddenFilters.minSalaryMaxK > 0
                ? `${state.hiddenFilters.minSalaryMaxK}K 以下隐藏`
                : '不限';
        }
    }

    function commitSettingsFromPanel(panel) {
        const keywordsInput = panel.querySelector(`.${APP_ID}-keyword-input`);
        const salaryRange = panel.querySelector(`.${APP_ID}-salary-range`);
        state.hiddenFilters = normalizeHiddenFilterSettings({
            keywords: keywordsInput ? keywordsInput.value : '',
            minSalaryMaxK: salaryRange ? salaryRange.value : 0
        });
        saveHiddenFilterSettings();
        updateSettingsPanel();
        applyIgnoredJobs();
        void ensureActiveJobIsVisible();
    }

    function setSortButtonBusy(busy, label = '') {
        const button = document.querySelector(`.${APP_ID}-sort-btn`);
        if (!button) return;
        button.disabled = Boolean(busy);
        if (busy) {
            button.textContent = label ? `按活跃排序 (${label})` : '排序中';
        } else {
            updateSortButtonLabel();
        }
    }

    function renderCardActiveBadge(card, activeTimeText) {
        if (!card) return;
        const footer = card.querySelector('.job-card-footer') || card.querySelector('.job-info') || card;
        let badge = card.querySelector(`.${APP_ID}-active-badge`);
        const text = normalizeSpace(activeTimeText);
        if (!text) {
            badge?.remove();
            return;
        }

        if (!badge) {
            badge = document.createElement('span');
            badge.className = `${APP_ID}-active-badge`;
            footer.appendChild(badge);
        }
        badge.textContent = text;
    }

    function isCardHiddenByFilters(card) {
        return jobMatchesHiddenFilters({
            title: getCardTitle(card),
            keywordText: getCardFilterKeywordText(card),
            salaryText: getCardSalaryText(card)
        }, state.hiddenFilters);
    }

    function isFilterHidingSuspended() {
        return Boolean(state.filtersSuspendedForLoading);
    }

    function setFiltersSuspendedForLoading(suspended) {
        state.filtersSuspendedForLoading = Boolean(suspended);
        applyIgnoredJobs();
    }

    function isCardHiddenByIgnored(card, extraIgnoredId = '') {
        const id = getJobIdFromCard(card);
        return Boolean(id && ((extraIgnoredId && id === extraIgnoredId) || (!state.showIgnored && state.ignoredJobs.has(id))));
    }

    function isCardVisibleByRules(card, extraIgnoredId = '') {
        const id = getJobIdFromCard(card);
        return Boolean(id && !isCardHiddenByIgnored(card, extraIgnoredId) && !isCardHiddenByFilters(card));
    }

    function applyIgnoredJobs() {
        for (const card of getJobCards()) {
            card.classList.toggle(`${APP_ID}-ignored-job`, !isFilterHidingSuspended() && isCardHiddenByIgnored(card));
            card.classList.toggle(`${APP_ID}-filtered-job`, !isFilterHidingSuspended() && isCardHiddenByFilters(card));
        }
        updateIgnoredToggleButton();
        updateSettingsPanel();
        updateToolbarStatus(state.lastStatusText);
    }

    function showToast(message, action = null) {
        const oldToast = document.querySelector(`.${APP_ID}-toast`);
        oldToast?.remove();

        const toast = document.createElement('div');
        toast.className = `${APP_ID}-toast`;
        const text = document.createElement('span');
        text.textContent = message;
        toast.appendChild(text);

        if (action && typeof action.onClick === 'function') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `${APP_ID}-toast-action`;
            button.textContent = action.label || '撤销';
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toast.remove();
                action.onClick();
            });
            toast.appendChild(button);
        }

        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 2400);
    }

    function setCustomTagsForJob(id, tags) {
        const normalizedId = normalizeSpace(id);
        if (!normalizedId) return;

        const normalizedTags = normalizeCustomTagList(tags);
        if (normalizedTags.length) {
            state.customTags.set(normalizedId, {
                id: normalizedId,
                tags: normalizedTags,
                updatedAt: Date.now()
            });
        } else {
            state.customTags.delete(normalizedId);
        }
        saveCustomTags();
    }

    function addCustomTagForCurrentJob() {
        const record = getCurrentJobRecord();
        if (!record) {
            showToast('未找到当前职位');
            return;
        }

        const tag = normalizeSpace(window.prompt('添加自定义标签', '') || '');
        if (!tag) return;

        const tags = normalizeCustomTagList([...getCustomTagsForJob(record.id), tag]);
        setCustomTagsForJob(record.id, tags);
        renderDetailCustomTags();
        applyIgnoredJobs();
        void ensureActiveJobIsVisible();
        showToast(`已添加标签：${tag}`);
    }

    function removeCustomTagForCurrentJob(tag) {
        const record = getCurrentJobRecord();
        if (!record) return;

        const removeKey = normalizeSpace(tag).toLowerCase();
        const tags = getCustomTagsForJob(record.id).filter((value) => value.toLowerCase() !== removeKey);
        setCustomTagsForJob(record.id, tags);
        renderDetailCustomTags();
        applyIgnoredJobs();
        void ensureActiveJobIsVisible();
        showToast(`已移除标签：${tag}`);
    }

    function renderDetailCustomTags() {
        const host = ensureDetailTagHost();
        if (!host) return;

        const record = getCurrentJobRecord();
        let wrap = host.querySelector(`.${APP_ID}-custom-tag-wrap`);
        if (!record) {
            wrap?.remove();
            return;
        }

        if (!wrap) {
            wrap = document.createElement('span');
            wrap.className = `${APP_ID}-custom-tag-wrap`;
            host.appendChild(wrap);
        }

        const tags = getCustomTagsForJob(record.id);
        const signature = JSON.stringify({ id: record.id, tags });
        if (wrap.dataset.signature === signature) return;
        wrap.dataset.signature = signature;
        wrap.textContent = '';
        for (const tag of tags) {
            const item = document.createElement('span');
            item.className = `${APP_ID}-custom-tag`;

            const label = document.createElement('span');
            label.className = `${APP_ID}-custom-tag-text`;
            label.textContent = tag;
            item.appendChild(label);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = `${APP_ID}-custom-tag-remove`;
            remove.textContent = '×';
            remove.title = `移除标签 ${tag}`;
            remove.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                removeCustomTagForCurrentJob(tag);
            });
            item.appendChild(remove);
            wrap.appendChild(item);
        }

        const add = document.createElement('button');
        add.type = 'button';
        add.className = `${APP_ID}-custom-tag-add`;
        add.textContent = '+ 标签';
        add.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            addCustomTagForCurrentJob();
        });
        wrap.appendChild(add);
    }

    function clickCard(card) {
        return activateJobCard(card);
    }

    function getCardVue(card) {
        const pageCard = getPageCardForCard(card);
        return pageCard && pageCard.__vue__ ? pageCard.__vue__ : null;
    }

    function getCardJobData(card) {
        return getCardVue(card)?._props?.data || null;
    }

    function getCardController(card) {
        const vue = getCardVue(card);
        let cursor = vue;
        while (cursor) {
            if (typeof cursor.clickJobCardAction === 'function') return cursor;
            if (typeof cursor.clickJobCard === 'function') return cursor;
            if (typeof cursor.loadJobDetail === 'function') return cursor;
            cursor = cursor.$parent;
        }
        return null;
    }

    async function activateJobCard(card) {
        if (!card) return false;
        const controller = getCardController(card);
        const jobData = getCardJobData(card);
        card.scrollIntoView({ block: 'nearest' });

        try {
            if (controller && jobData && typeof controller.clickJobCardAction === 'function') {
                const result = controller.clickJobCardAction(jobData);
                if (result && typeof result.then === 'function') await result;
                return true;
            }
            if (controller && jobData && typeof controller.clickJobCard === 'function') {
                const result = controller.clickJobCard(jobData);
                if (result && typeof result.then === 'function') await result;
                return true;
            }
            if (controller && jobData && typeof controller.loadJobDetail === 'function') {
                const result = controller.loadJobDetail(jobData);
                if (result && typeof result.then === 'function') await result;
                return true;
            }
        } catch (error) {
            console.warn(`[${APP_ID}] failed to activate job through Vue`, error);
        }

        return false;
    }

    function getNextVisibleJobAfterIgnore(fromCard, ignoredId) {
        const allCards = getJobCards();
        const fromIndex = allCards.indexOf(fromCard);
        if (fromIndex < 0) return null;

        const nextIndex = findNextVisibleJobIndex(
            allCards.map((card) => {
                return {
                    id: getJobIdFromCard(card),
                    ignored: !isCardVisibleByRules(card, ignoredId)
                };
            }),
            fromIndex
        );
        return nextIndex >= 0 ? allCards[nextIndex] : null;
    }

    function getFirstNonIgnoredJobCard() {
        return getJobCards().find((card) => isCardVisibleByRules(card)) || null;
    }

    async function ensureActiveJobIsVisible() {
        const current = getCurrentJobCard();
        if (!current) return;

        const currentId = getJobIdFromCard(current);
        if (isCardVisibleByRules(current)) return;

        const nextCard = getNextVisibleJobAfterIgnore(current, currentId) || getFirstNonIgnoredJobCard();
        if (nextCard) await activateJobCard(nextCard);
    }

    async function toggleCurrentJobIgnored() {
        const record = getCurrentJobRecord();
        if (!record) {
            showToast('未找到当前职位');
            return;
        }

        if (state.ignoredJobs.has(record.id)) {
            state.ignoredJobs.delete(record.id);
            saveIgnoredJobs();
            applyIgnoredJobs();
            ensureIgnoreButton();
            updateToolbarStatus('');
            showToast(`已取消忽略：${record.title || record.id}`);
            return;
        }

        const nextCard = getNextVisibleJobAfterIgnore(record.card, record.id);
        state.ignoredJobs.set(record.id, {
            id: record.id,
            title: record.title,
            company: record.company,
            href: record.href,
            ignoredAt: Date.now()
        });
        saveIgnoredJobs();

        if (nextCard) await activateJobCard(nextCard);
        applyIgnoredJobs();
        ensureIgnoreButton();
        updateToolbarStatus('');
        showToast(`已忽略：${record.title || record.id}`, {
            label: '撤销',
            onClick: async () => {
                state.ignoredJobs.delete(record.id);
                saveIgnoredJobs();
                applyIgnoredJobs();
                const restoredCard = findJobCardById(record.id);
                if (restoredCard && isCardVisibleByRules(restoredCard)) await activateJobCard(restoredCard);
                ensureIgnoreButton();
                updateToolbarStatus('');
                showToast(`已取消忽略：${record.title || record.id}`);
            }
        });
    }

    function toggleIgnoredVisibility() {
        if (!state.ignoredJobs.size && !state.showIgnored) {
            showToast('没有已忽略职位');
            return;
        }

        state.showIgnored = !state.showIgnored;
        applyIgnoredJobs();
        ensureIgnoreButton();
        updateToolbarStatus('');
        showToast(state.showIgnored ? '已显示忽略职位' : '已隐藏忽略职位');
    }

    function makeJobRecord(card, originalIndex) {
        const id = getJobIdFromCard(card);
        const cached = id ? state.activeTimeCache.get(id) : null;
        const jobData = getCardJobData(card);
        const cardActiveTimeText = getCardActiveTimeText(card);
        return {
            id,
            card,
            jobData,
            title: getCardTitle(card),
            keywordText: getCardFilterKeywordText(card),
            salaryText: getCardSalaryText(card),
            originalIndex,
            activeTimeText: cardActiveTimeText || cached?.text || getActiveTimeTextFromJobData(jobData),
            activeRank: cardActiveTimeText ? parseBossActiveTimeRank(cardActiveTimeText) : cached?.rank
        };
    }

    function cacheActiveTime(record, text) {
        if (!record.id) return;
        const activeTimeText = normalizeSpace(text);
        if (!activeTimeText) {
            const fallbackText = getActiveTimeTextFromJobData(record.jobData || getCardJobData(record.card));
            if (fallbackText) {
                cacheActiveTime(record, fallbackText);
            } else {
                record.activeTimeText = '';
                record.activeRank = UNKNOWN_ACTIVE_RANK;
                renderCardActiveBadge(record.card, '');
            }
            return;
        }

        const activeRank = parseBossActiveTimeRank(activeTimeText);
        state.activeTimeCache.set(record.id, {
            id: record.id,
            text: activeTimeText,
            rank: activeRank,
            seenAt: Date.now()
        });
        saveActiveTimeCache();
        record.activeTimeText = activeTimeText;
        record.activeRank = activeRank;
        renderCardActiveBadge(record.card, activeTimeText);
    }

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function getJobListScrollTarget() {
        const parent = getJobListParent();
        const candidates = [
            parent,
            parent?.parentElement,
            document.querySelector('.job-list-container'),
            document.querySelector('.rec-job-list')
        ].filter(Boolean);

        return candidates.find((element) => element.scrollHeight > element.clientHeight + 20) || document.scrollingElement || document.documentElement;
    }

    async function loadMoreVisibleJobCardsBeforeSort() {
        setFiltersSuspendedForLoading(true);
        try {
            await sleep(180);
            const target = getJobListScrollTarget();
            if (!target) return;

            let previousCount = getJobCards().length;
            for (let pass = 0; pass < LOAD_MORE_SCROLL_PASSES; pass += 1) {
                if (previousCount >= LOAD_MORE_MAX_CARDS) return;

                setSortButtonBusy(true, `加载 ${previousCount}`);
                updateToolbarStatus('加载更多职位');
                target.scrollBy({
                    top: Math.max(360, Math.round((target.clientHeight || window.innerHeight || 720) * 0.85)),
                    left: 0,
                    behavior: 'smooth'
                });
                await sleep(LOAD_MORE_SCROLL_DELAY_MS);

                const nextCount = getJobCards().length;
                if (nextCount <= previousCount && target.scrollTop + target.clientHeight >= target.scrollHeight - 20) return;
                previousCount = nextCount;
            }
        } finally {
            setFiltersSuspendedForLoading(false);
        }
    }

    function getListController(records = []) {
        for (const record of records) {
            const controller = getCardController(record.card);
            if (controller && Array.isArray(controller.jobList)) return controller;
        }

        const firstCard = getJobCards()[0];
        const controller = getCardController(firstCard);
        return controller && Array.isArray(controller.jobList) ? controller : null;
    }

    function reorderJobListBySortedRecords(jobList, sortedRecords) {
        const targetIds = new Set(sortedRecords.map((record) => record.id).filter(Boolean));
        const sortedJobData = sortedRecords
            .map((record) => record.jobData || getCardJobData(record.card))
            .filter((jobData) => targetIds.has(getJobDataId(jobData)));

        let cursor = 0;
        return jobList.map((jobData) => {
            const id = getJobDataId(jobData);
            if (!targetIds.has(id)) return jobData;
            const replacement = sortedJobData[cursor];
            cursor += 1;
            return replacement || jobData;
        });
    }

    function sortRecordsInPageWorld(sorted) {
        installPageBridge();

        return new Promise((resolve) => {
            const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timer = window.setTimeout(() => {
                window.removeEventListener(PAGE_SORT_RESULT_EVENT, onResult);
                resolve(false);
            }, 1200);

            function onResult(event) {
                let payload = {};
                try {
                    payload = JSON.parse(String(event.detail || '{}'));
                } catch (error) {
                    return;
                }

                if (payload.requestId !== requestId) return;
                window.clearTimeout(timer);
                window.removeEventListener(PAGE_SORT_RESULT_EVENT, onResult);
                resolve(Boolean(payload.ok));
            }

            window.addEventListener(PAGE_SORT_RESULT_EVENT, onResult);
            window.dispatchEvent(new CustomEvent(PAGE_SORT_EVENT, {
                detail: JSON.stringify({
                    requestId,
                    sortedIds: sorted.map((record) => record.id).filter(Boolean)
                })
            }));
        });
    }

    function sortRecordsInVueDirect(records, sorted) {
        const controller = getListController(records);
        if (!controller || !Array.isArray(controller.jobList)) return false;

        const reordered = reorderJobListBySortedRecords(controller.jobList, sorted);
        controller.jobList.splice(0, controller.jobList.length, ...reordered);
        if (typeof controller.$forceUpdate === 'function') controller.$forceUpdate();
        return true;
    }

    async function sortRecordsInVue(records, sorted) {
        return await sortRecordsInPageWorld(sorted) || sortRecordsInVueDirect(records, sorted);
    }

    function sortRecordsInDom(records, sorted) {
        const parent = getJobListParent();
        if (!parent) return [];

        for (const record of sorted) {
            if (record.card.parentElement === parent) parent.appendChild(record.card);
        }

        return sorted;
    }

    function scrollJobListToTopAfterSort(sortedRecords) {
        const target = getJobListScrollTarget();
        if (target && typeof target.scrollTo === 'function') {
            target.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
        } else if (target) {
            target.scrollTop = 0;
        }

        const firstCard = Array.isArray(sortedRecords) && sortedRecords[0] ? sortedRecords[0].card : null;
        firstCard?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'smooth' });
    }

    async function sortRecordsOnPage(records) {
        const sorted = records
            .slice()
            .sort(compareJobRecordsByActiveTime);

        const vueSorted = await sortRecordsInVue(records, sorted);
        sortRecordsInDom(records, sorted);
        if (!vueSorted) updateToolbarStatus('已按当前可见职位排序');
        return sorted;
    }

    async function sortLoadedJobsByActiveTime() {
        if (state.scanning) return;

        state.scanning = true;
        const token = state.scanToken + 1;
        state.scanToken = token;
        setSortButtonBusy(true);

        try {
            await loadMoreVisibleJobCardsBeforeSort();
            if (token !== state.scanToken) return;

            const records = getJobCards()
                .filter((card) => {
                    const id = getJobIdFromCard(card);
                    return Boolean(id && !state.ignoredJobs.has(id) && !isCardHiddenByFilters(card));
                })
                .map(makeJobRecord);

            if (!records.length) {
                showToast('没有可排序职位');
                return;
            }

            for (const record of records) {
                const cardActiveTimeText = getCardActiveTimeText(record.card);
                if (cardActiveTimeText) cacheActiveTime(record, cardActiveTimeText);
                if (record.activeTimeText) renderCardActiveBadge(record.card, record.activeTimeText);
            }

            const sorted = await sortRecordsOnPage(records);
            state.lastSortedCount = sorted.length;
            scrollJobListToTopAfterSort(sorted);
            await sleep(250);
            mountToolbar();
            applyIgnoredJobs();
            ensureIgnoreButton();
            updateToolbarStatus(`已排序 ${sorted.length} 个职位`);
        } finally {
            if (token === state.scanToken) {
                state.scanning = false;
                setSortButtonBusy(false);
            }
        }
    }

    function refreshUi() {
        state.refreshTimer = null;
        installStyles();
        mountToolbar();
        applyIgnoredJobs();
        ensureIgnoreButton();
        ensureChatButtonsOpenInNewTabs();
        renderDetailCustomTags();
        void ensureActiveJobIsVisible();

        for (const card of getJobCards()) {
            const id = getJobIdFromCard(card);
            const cached = id ? state.activeTimeCache.get(id) : null;
            if (cached) renderCardActiveBadge(card, cached.text);
        }
    }

    function scheduleRefresh() {
        if (state.refreshTimer) return;
        state.refreshTimer = window.setTimeout(refreshUi, 120);
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand('显示 BOSS 直聘已忽略职位', () => {
            state.showIgnored = true;
            applyIgnoredJobs();
        });
    }

    function startObserver() {
        if (state.mutationObserver) return;
        state.mutationObserver = new MutationObserver(scheduleRefresh);
        state.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        loadIgnoredJobs();
        loadActiveTimeCache();
        loadHiddenFilterSettings();
        loadCustomTags();
        installStyles();
        registerMenus();
        installPageBridge();
        refreshUi();
        startObserver();
        window.setInterval(scheduleRefresh, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
