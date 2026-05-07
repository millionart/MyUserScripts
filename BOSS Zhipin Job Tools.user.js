// ==UserScript==
// @name         BOSS Zhipin Job Tools
// @name:zh-CN   BOSS直聘职位忽略与活跃排序
// @namespace    https://github.com/milli/youtube-subscription-category-manager
// @version      0.1.11
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
    const SCRIPT_VERSION = '0.1.11';
    const STORAGE_KEY = 'boss-zhipin-job-tools:ignored-jobs';
    const ACTIVE_TIME_CACHE_STORAGE_KEY = 'boss-zhipin-job-tools:active-time-cache';
    const HIDDEN_FILTER_SETTINGS_STORAGE_KEY = 'boss-zhipin-job-tools:hidden-filter-settings';
    const PAGE_SORT_EVENT = `${APP_ID}:sort-job-list`;
    const PAGE_SORT_RESULT_EVENT = `${APP_ID}:sort-job-list-result`;
    const SCAN_DELAY_MS = 650;
    const DETAIL_WAIT_MS = 2500;
    const UNKNOWN_ACTIVE_RANK = Number.MAX_SAFE_INTEGER;

    const state = {
        ignoredJobs: new Map(),
        activeTimeCache: new Map(),
        mutationObserver: null,
        refreshTimer: null,
        scanning: false,
        scanToken: 0,
        showIgnored: false,
        settingsOpen: false,
        hiddenFilters: { keywords: [], minSalaryMaxK: 0 },
        lastSortedCount: 0,
        lastStatusText: ''
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
                gap: 8px;
                min-height: 40px;
                margin: 0;
                padding: 0;
                border: 0;
                border-radius: 0;
                background: transparent;
                color: #4e5969;
                font-size: 13px;
                box-sizing: border-box;
            }
            .${APP_ID}-toolbar button,
            .${APP_ID}-ignore-btn {
                height: 40px;
                border: 1px solid #d8dde6;
                border-radius: 4px;
                background: #fff;
                color: #1f2d3d;
                font-size: 13px;
                line-height: 38px;
                padding: 0 12px;
                cursor: pointer;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .${APP_ID}-toolbar button:hover,
            .${APP_ID}-ignore-btn:hover {
                color: #00a57f;
                border-color: #00bebd;
            }
            .${APP_ID}-ignore-btn {
                border-color: #ffccc7;
                background: #fff1f0;
                color: #cf1322;
            }
            .${APP_ID}-ignore-btn:hover {
                border-color: #ff4d4f;
                background: #fff5f5;
                color: #a8071a;
            }
            .${APP_ID}-toolbar button:disabled,
            .${APP_ID}-ignore-btn:disabled {
                cursor: not-allowed;
                color: #9aa3ad;
                border-color: #e5e8ef;
                background: #f5f7fa;
            }
            .${APP_ID}-status {
                display: inline-flex;
                align-items: center;
                height: 40px;
                min-width: 0;
                max-width: 190px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #6b7785;
            }
            .${APP_ID}-ignore-btn {
                height: 30px;
                line-height: 28px;
                padding: 0 10px;
                margin-left: 8px;
                vertical-align: middle;
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
                color: #4e5969;
                font-size: 13px;
            }
            .${APP_ID}-settings-field textarea {
                width: 100%;
                min-height: 96px;
                resize: vertical;
                border: 1px solid #d8dde6;
                border-radius: 4px;
                padding: 8px;
                color: #1f2d3d;
                font-size: 13px;
                line-height: 1.45;
                box-sizing: border-box;
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
            .${APP_ID}-settings-clear {
                width: 100%;
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
        `);
    }

    function installPageBridge() {
        const source = `
            (() => {
                if (window.__bzjtPageBridgeInstalled) return;
                window.__bzjtPageBridgeInstalled = true;

                const SORT_EVENT = 'bzjt:sort-job-list';
                const SORT_RESULT_EVENT = 'bzjt:sort-job-list-result';

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
            keywordText: getCardKeywordText(card) || getDetailKeywordText(),
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
                ignoreCurrentJob();
            });
            target.appendChild(button);
        }

        const record = getCurrentJobRecord();
        const ignored = Boolean(record && state.ignoredJobs.has(record.id));
        button.textContent = ignored ? '已忽略' : '忽略该职位';
        button.disabled = !record || ignored;
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
                        <span>职位关键词</span>
                        <textarea class="${APP_ID}-keyword-input" placeholder="每行一个关键词"></textarea>
                    </label>
                    <label class="${APP_ID}-settings-field">
                        <span class="${APP_ID}-settings-range-row">
                            <span>最高薪资门槛</span>
                            <span class="${APP_ID}-settings-range-value"></span>
                        </span>
                        <input class="${APP_ID}-salary-range" type="range" min="0" max="100" step="5">
                    </label>
                    <button type="button" class="${APP_ID}-settings-clear">清空设置</button>
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
            panel.querySelector(`.${APP_ID}-settings-clear`).addEventListener('click', () => {
                state.hiddenFilters = { keywords: [], minSalaryMaxK: 0 };
                saveHiddenFilterSettings();
                updateSettingsPanel();
                applyIgnoredJobs();
                void ensureActiveJobIsVisible();
            });
        }
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
            keywordText: getCardKeywordText(card),
            salaryText: getCardSalaryText(card)
        }, state.hiddenFilters);
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
            card.classList.toggle(`${APP_ID}-ignored-job`, isCardHiddenByIgnored(card));
            card.classList.toggle(`${APP_ID}-filtered-job`, isCardHiddenByFilters(card));
        }
        updateIgnoredToggleButton();
        updateSettingsPanel();
        updateToolbarStatus(state.lastStatusText);
    }

    function showToast(message) {
        const oldToast = document.querySelector(`.${APP_ID}-toast`);
        oldToast?.remove();

        const toast = document.createElement('div');
        toast.className = `${APP_ID}-toast`;
        toast.textContent = message;
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 2400);
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

    async function ignoreCurrentJob() {
        const record = getCurrentJobRecord();
        if (!record) {
            showToast('未找到当前职位');
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
        showToast(`已忽略：${record.title || record.id}`);
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
        return {
            id,
            card,
            jobData,
            title: getCardTitle(card),
            keywordText: getCardKeywordText(card),
            salaryText: getCardSalaryText(card),
            originalIndex,
            activeTimeText: cached?.text || getActiveTimeTextFromJobData(jobData),
            activeRank: cached?.rank
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

    async function waitForDetailForCard(record) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < DETAIL_WAIT_MS) {
            const current = getCurrentJobRecord();
            if (current && current.id === record.id) return true;

            const detailText = normalizeSpace(document.querySelector('.job-detail-header')?.textContent || '');
            if (record.title && detailText.includes(record.title)) return true;

            await sleep(100);
        }
        return false;
    }

    async function scanMissingActiveTimes(records, token) {
        for (let index = 0; index < records.length; index += 1) {
            if (token !== state.scanToken) return false;

            const record = records[index];
            if (!record.id || state.activeTimeCache.has(record.id)) continue;

            setSortButtonBusy(true, `${index + 1}/${records.length}`);
            updateToolbarStatus('读取活跃时间');
            await activateJobCard(record.card);
            const detailReady = await waitForDetailForCard(record);
            await sleep(SCAN_DELAY_MS);
            cacheActiveTime(record, detailReady ? getDetailActiveTimeText() : '');
        }
        return true;
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

    async function sortRecordsOnPage(records) {
        const sorted = records
            .slice()
            .sort(compareJobRecordsByActiveTime);

        if (!await sortRecordsInVue(records, sorted)) sortRecordsInDom(records, sorted);
        return sorted;
    }

    async function sortLoadedJobsByActiveTime() {
        if (state.scanning) return;

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

        state.scanning = true;
        const token = state.scanToken + 1;
        state.scanToken = token;
        setSortButtonBusy(true);

        try {
            const completed = await scanMissingActiveTimes(records, token);
            if (!completed) return;

            for (const record of records) {
                const cached = record.id ? state.activeTimeCache.get(record.id) : null;
                if (cached) {
                    record.activeTimeText = cached.text;
                    record.activeRank = cached.rank;
                    renderCardActiveBadge(record.card, cached.text);
                } else if (record.activeTimeText) {
                    record.activeRank = parseBossActiveTimeRank(record.activeTimeText);
                    renderCardActiveBadge(record.card, record.activeTimeText);
                }
            }

            const sorted = await sortRecordsOnPage(records);
            state.lastSortedCount = sorted.length;
            await sleep(250);
            refreshUi();
            updateToolbarStatus('');
            if (sorted[0]) await activateJobCard(findJobCardById(sorted[0].id) || sorted[0].card);
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
        GM_registerMenuCommand('清空 BOSS 直聘活跃时间缓存', () => {
            state.activeTimeCache.clear();
            saveActiveTimeCache();
            document.querySelectorAll(`.${APP_ID}-active-badge`).forEach((badge) => badge.remove());
            updateToolbarStatus('已清空活跃时间缓存');
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
        installStyles();
        registerMenus();
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
