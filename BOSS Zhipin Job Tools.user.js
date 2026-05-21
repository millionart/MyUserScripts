// ==UserScript==
// @name         BOSS Zhipin Job Tools
// @name:zh-CN   BOSS直聘职位忽略与活跃排序
// @namespace    https://github.com/milli/youtube-subscription-category-manager
// @version      0.1.69
// @description  在 BOSS 直聘职位列表详情区添加忽略、隐藏筛选，并支持按发布者活跃时间排序当前已加载职位。
// @author       Codex
// @license      MIT
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/job_detail/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    const APP_ID = 'bzjt';
    const SCRIPT_VERSION = '0.1.69';
    const STORAGE_KEY = 'boss-zhipin-job-tools:ignored-jobs';
    const ACTIVE_TIME_CACHE_STORAGE_KEY = 'boss-zhipin-job-tools:active-time-cache';
    const HIDDEN_FILTER_SETTINGS_STORAGE_KEY = 'boss-zhipin-job-tools:hidden-filter-settings';
    const CUSTOM_TAG_STORAGE_KEY = 'boss-zhipin-job-tools:custom-tags';
    const JOB_CACHE_STORAGE_KEY = 'boss-zhipin-job-tools:job-cache';
    const JOB_CACHE_SETTINGS_STORAGE_KEY = 'boss-zhipin-job-tools:job-cache-settings';
    const JOB_DETAIL_RECOVERY_STORAGE_KEY = 'boss-zhipin-job-tools:detail-recovery-map';
    const PAGE_SORT_EVENT = `${APP_ID}:sort-job-list`;
    const PAGE_SORT_RESULT_EVENT = `${APP_ID}:sort-job-list-result`;
    const LOAD_MORE_SCROLL_PASSES = 6;
    const LOAD_MORE_SCROLL_DELAY_MS = 850;
    const LOAD_MORE_MAX_CARDS = 80;
    const UNKNOWN_ACTIVE_RANK = Number.MAX_SAFE_INTEGER;
    const DEFAULT_JOB_CACHE_TTL_DAYS = 30;
    const MIN_JOB_CACHE_TTL_DAYS = 1;
    const MAX_JOB_CACHE_TTL_DAYS = 365;
    const JOB_CACHE_SCHEMA_VERSION = 6;
    const DETAIL_CACHE_SCHEMA_VERSION = 4;
    const DETAIL_RECOVERY_TTL_MS = 6 * 60 * 60 * 1000;
    const EXPECTATION_CACHE_SETTLE_MS = 2500;
    const USER_SCROLL_RENDER_DEFER_MS = 700;
    const DETAIL_PREFETCH_IDLE_MS = 900;
    const DETAIL_PREFETCH_STEP_DELAY_MS = 220;
    const DETAIL_PREFETCH_MAX_PER_PASS = 6;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const DETAIL_ROOT_CONTAINER_SELECTOR = [
        '.job-detail-container',
        '.job-detail-box',
        '.job-detail-main',
        '.job-detail',
        '.detail-content'
    ].join(',');
    const DETAIL_SCAN_SELECTOR = `${DETAIL_ROOT_CONTAINER_SELECTOR}, .job-sec`;

    const state = {
        ignoredJobs: new Map(),
        activeTimeCache: new Map(),
        customTags: new Map(),
        jobCache: new Map(),
        jobCacheSettings: { ttlDays: DEFAULT_JOB_CACHE_TTL_DAYS },
        mutationObserver: null,
        refreshTimer: null,
        scanning: false,
        scanToken: 0,
        filtersSuspendedForLoading: false,
        showIgnored: false,
        settingsOpen: false,
        hiddenFilters: { keywords: [], minSalaryMaxK: 0 },
        jobExpectationSelectedByUser: false,
        jobExpectationTouchedByUser: false,
        selectedExpectationText: '',
        expectationSelectedAt: 0,
        lastSortedCount: 0,
        lastStatusText: '',
        lastCacheSignature: '',
        lastJobListUserScrollAt: 0,
        cachedRenderTimer: null,
        currentCachedDetailId: '',
        lastCachedDetailId: '',
        lastCachedDetailSignature: '',
        chatNewTabHandlerInstalled: false,
        detailPrefetchTimer: null,
        detailPrefetchRunning: false,
        detailPrefetchSignature: '',
        detailDebugPickerActive: false,
        detailDebugPickerTarget: null,
        detailDebugPickerOverlay: null,
        jobCacheChangeListenerId: null
    };

    function normalizeSpace(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isRealJobExpectationText(text) {
        const value = normalizeSpace(text);
        return Boolean(value && value !== '推荐' && !/添加求职期望/.test(value));
    }

    function findAutoJobExpectationIndex(labels) {
        const items = (Array.isArray(labels) ? labels : []).map(normalizeSpace);
        const recommendationIndex = items.findIndex((text) => text === '推荐');
        const addIndex = items.findIndex((text) => /添加求职期望/.test(text));
        const start = recommendationIndex >= 0 ? recommendationIndex + 1 : 0;
        const end = addIndex >= 0 ? addIndex : items.length;

        for (let index = start; index < end; index += 1) {
            if (isRealJobExpectationText(items[index])) return index;
        }
        return items.findIndex(isRealJobExpectationText);
    }

    function extractJobIdFromHref(href) {
        const text = String(href || '');
        const match = text.match(/\/job_detail\/([^/?#]+?)\.html(?:[?#]|$)/);
        return match ? match[1] : '';
    }

    function extractSecurityIdFromHref(href) {
        const text = normalizeSpace(href);
        if (!text) return '';
        try {
            return normalizeSpace(new URL(text, location.origin).searchParams.get('securityId'));
        } catch (error) {
            const match = text.match(/[?&]securityId=([^&#]+)/i);
            return match ? normalizeSpace(decodeURIComponent(match[1])) : '';
        }
    }

    function isStandaloneJobDetailPage() {
        return /\/job_detail\/[^/?#]+\.html$/i.test(normalizeSpace(location.pathname));
    }

    function extractRecoverySourceJobIdFromLocation() {
        const hash = normalizeSpace(location.hash).replace(/^#/, '');
        if (!hash) return '';
        const params = new URLSearchParams(hash);
        return normalizeSpace(params.get(`${APP_ID}-source-id`));
    }

    function normalizeDetailRecoveryMap(stored, now = Date.now()) {
        const source = stored && typeof stored === 'object' ? stored : {};
        const entries = Object.entries(source)
            .map(([key, value]) => {
                const detailId = normalizeSpace(key);
                const sourceId = normalizeSpace(value && value.sourceId);
                const updatedAt = Number(value && value.updatedAt);
                if (!detailId || !sourceId || !Number.isFinite(updatedAt)) return null;
                if (updatedAt + DETAIL_RECOVERY_TTL_MS < now) return null;
                return [detailId, { sourceId, updatedAt }];
            })
            .filter(Boolean);
        return Object.fromEntries(entries);
    }

    function loadDetailRecoveryMap() {
        return normalizeDetailRecoveryMap(safeGetValue(JOB_DETAIL_RECOVERY_STORAGE_KEY, {}));
    }

    function saveDetailRecoveryMap(map) {
        safeSetValue(JOB_DETAIL_RECOVERY_STORAGE_KEY, normalizeDetailRecoveryMap(map));
    }

    function rememberDetailRecoverySource(record) {
        const sourceId = normalizeSpace(record && record.id);
        const detailId = extractJobIdFromHref(getCachedJobHref(record));
        if (!sourceId || !detailId) return;

        const recoveryMap = loadDetailRecoveryMap();
        recoveryMap[detailId] = {
            sourceId,
            updatedAt: Date.now()
        };
        saveDetailRecoveryMap(recoveryMap);
    }

    function resolveStoredRecoverySourceJobId(detailId) {
        const normalizedDetailId = normalizeSpace(detailId);
        if (!normalizedDetailId) return '';
        const recoveryMap = loadDetailRecoveryMap();
        return normalizeSpace(recoveryMap[normalizedDetailId] && recoveryMap[normalizedDetailId].sourceId);
    }

    function resolveStandaloneRecoverySourceJobId(detailId) {
        return extractRecoverySourceJobIdFromLocation()
            || resolveStoredRecoverySourceJobId(detailId);
    }

    function getStandaloneDetailDebugInfo() {
        const detailId = extractJobIdFromHref(location.href);
        const recoverySourceIdFromHash = extractRecoverySourceJobIdFromLocation();
        const recoverySourceIdFromStore = resolveStoredRecoverySourceJobId(detailId);
        const resolvedSourceId = resolveStandaloneRecoverySourceJobId(detailId);
        const matchedRecord = state.jobCache.get(resolvedSourceId || detailId) || null;
        const root = findDetailRoot();
        const detailHtmlText = normalizeSpace(matchedRecord && matchedRecord.detailHtml);

        return {
            scriptVersion: SCRIPT_VERSION,
            cacheStorageKey: JOB_CACHE_STORAGE_KEY,
            pageHref: location.href,
            detailId,
            recoverySourceIdFromHash,
            recoverySourceIdFromStore,
            resolvedSourceId,
            hasDetailRoot: Boolean(root),
            detailRootTextLength: normalizeSpace(root?.textContent || '').length,
            matchedRecord: matchedRecord ? {
                id: matchedRecord.id,
                title: matchedRecord.title || '',
                company: matchedRecord.company || '',
                href: matchedRecord.href || '',
                securityId: matchedRecord.securityId || '',
                detailJobId: matchedRecord.detailJobId || '',
                detailSchemaVersion: Number(matchedRecord.detailSchemaVersion) || 0,
                hasDetailHtml: Boolean(detailHtmlText),
                detailHtmlLength: detailHtmlText.length,
                detailTextPreview: detailHtmlText.slice(0, 600),
                hasDetailSnapshot: Boolean(matchedRecord.detailSnapshot),
                detailSnapshot: matchedRecord.detailSnapshot || null,
                lastSeenAt: Number(matchedRecord.lastSeenAt) || 0
            } : null
        };
    }

    async function copyTextToClipboard(text) {
        const value = String(text || '');
        if (!value) return false;

        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(value);
                return true;
            }
        } catch (error) {
            // Fall through to legacy copy path.
        }

        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);

        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch (error) {
            copied = false;
        } finally {
            textarea.remove();
        }
        return copied;
    }

    function ensureDetailDebugPickerOverlay() {
        let overlay = state.detailDebugPickerOverlay;
        if (overlay && overlay.isConnected) return overlay;

        overlay = document.createElement('div');
        overlay.className = `${APP_ID}-detail-debug-picker-overlay`;
        overlay.hidden = true;
        document.body.appendChild(overlay);
        state.detailDebugPickerOverlay = overlay;
        return overlay;
    }

    function updateDetailDebugPickerOverlay(target) {
        const overlay = ensureDetailDebugPickerOverlay();
        if (!(target instanceof Element)) {
            overlay.hidden = true;
            return;
        }

        const rect = target.getBoundingClientRect();
        overlay.hidden = false;
        overlay.style.left = `${Math.max(0, rect.left)}px`;
        overlay.style.top = `${Math.max(0, rect.top)}px`;
        overlay.style.width = `${Math.max(0, rect.width)}px`;
        overlay.style.height = `${Math.max(0, rect.height)}px`;
    }

    function updateStandaloneDetailDebugPanel() {
        renderStandaloneDetailDebugPanel();
        renderGlobalPickerButton();
    }

    function stopStandaloneDetailElementPicker(showCancelledToast = false) {
        if (!state.detailDebugPickerActive) {
            updateDetailDebugPickerOverlay(null);
            updateStandaloneDetailDebugPanel();
            return;
        }

        state.detailDebugPickerActive = false;
        state.detailDebugPickerTarget = null;
        updateDetailDebugPickerOverlay(null);
        document.removeEventListener('mousemove', handleStandaloneDetailPickerMove, true);
        document.removeEventListener('click', handleStandaloneDetailPickerClick, true);
        document.removeEventListener('keydown', handleStandaloneDetailPickerKeydown, true);
        updateStandaloneDetailDebugPanel();
        if (showCancelledToast) showToast('已退出元素拾取');
    }

    function getStandaloneDetailPickerTarget(event) {
        const candidate = event.target instanceof Element ? event.target : null;
        if (!candidate) return null;
        if (candidate.closest(`.${APP_ID}-detail-debug-panel`)) return null;
        if (candidate.closest(`.${APP_ID}-toast-host`)) return null;
        return candidate;
    }

    function handleStandaloneDetailPickerMove(event) {
        if (!state.detailDebugPickerActive) return;
        const target = getStandaloneDetailPickerTarget(event);
        state.detailDebugPickerTarget = target;
        updateDetailDebugPickerOverlay(target);
    }

    async function handleStandaloneDetailPickerClick(event) {
        if (!state.detailDebugPickerActive) return;
        const target = getStandaloneDetailPickerTarget(event);
        if (!target) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const copied = await copyTextToClipboard(target.outerHTML || '');
        stopStandaloneDetailElementPicker(false);
        showToast(copied ? '已复制所选元素 HTML' : '复制 HTML 失败');
    }

    function handleStandaloneDetailPickerKeydown(event) {
        if (!state.detailDebugPickerActive) return;
        if (event.key !== 'Escape') return;
        event.preventDefault();
        stopStandaloneDetailElementPicker(true);
    }

    function startStandaloneDetailElementPicker() {
        if (state.detailDebugPickerActive) {
            stopStandaloneDetailElementPicker(true);
            return;
        }

        state.detailDebugPickerActive = true;
        state.detailDebugPickerTarget = null;
        ensureDetailDebugPickerOverlay();
        document.addEventListener('mousemove', handleStandaloneDetailPickerMove, true);
        document.addEventListener('click', handleStandaloneDetailPickerClick, true);
        document.addEventListener('keydown', handleStandaloneDetailPickerKeydown, true);
        updateStandaloneDetailDebugPanel();
        showToast('已进入元素拾取模式，左键点击复制 HTML，Esc 取消');
    }

    function renderGlobalPickerButton() {
        let button = document.querySelector(`.${APP_ID}-picker-fab`);
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = `${APP_ID}-picker-fab`;
            button.title = '选择元素复制 HTML';
            button.setAttribute('aria-label', '选择元素复制 HTML');
            const label = document.createElement('span');
            label.className = `${APP_ID}-picker-fab-label`;
            label.textContent = '</>';
            button.appendChild(label);
            button.addEventListener('click', startStandaloneDetailElementPicker);
            document.body.appendChild(button);
        }

        button.classList.toggle(`${APP_ID}-picker-fab-active`, state.detailDebugPickerActive);
        button.title = state.detailDebugPickerActive ? '退出元素拾取' : '选择元素复制 HTML';
        button.setAttribute('aria-label', state.detailDebugPickerActive ? '退出元素拾取' : '选择元素复制 HTML');
    }

    function renderStandaloneDetailDebugPanel() {
        const info = getStandaloneDetailDebugInfo();
        let panel = document.querySelector(`.${APP_ID}-detail-debug-panel`);
        if (!panel) {
            panel = document.createElement('aside');
            panel.className = `${APP_ID}-detail-debug-panel`;
            document.body.appendChild(panel);
        }

        panel.textContent = '';
        appendTextElement(panel, 'h3', `${APP_ID}-detail-debug-title`, '职位缓存调试');
        const actions = document.createElement('div');
        actions.className = `${APP_ID}-detail-debug-actions`;
        panel.appendChild(actions);
        const pickerButton = document.createElement('button');
        pickerButton.type = 'button';
        pickerButton.className = `${APP_ID}-detail-debug-button`;
        if (state.detailDebugPickerActive) pickerButton.classList.add(`${APP_ID}-detail-debug-button-active`);
        pickerButton.textContent = state.detailDebugPickerActive ? '退出拾取' : '选择元素复制 HTML';
        pickerButton.addEventListener('click', startStandaloneDetailElementPicker);
        actions.appendChild(pickerButton);
        appendTextElement(panel, 'div', `${APP_ID}-detail-debug-meta`, `v${SCRIPT_VERSION}`);
        const pre = document.createElement('pre');
        pre.className = `${APP_ID}-detail-debug-pre`;
        pre.textContent = JSON.stringify(info, null, 2);
        panel.appendChild(pre);
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

    function getJobDataSecurityId(jobData) {
        if (!jobData || typeof jobData !== 'object') return '';
        return normalizeSpace(jobData.securityId || jobData.encryptId || '');
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

    function normalizeJobCacheSettings(settings = {}) {
        const ttlDays = Number(settings && settings.ttlDays);
        const rounded = Number.isFinite(ttlDays)
            ? Math.round(ttlDays)
            : DEFAULT_JOB_CACHE_TTL_DAYS;
        return {
            ttlDays: Math.min(MAX_JOB_CACHE_TTL_DAYS, Math.max(MIN_JOB_CACHE_TTL_DAYS, rounded))
        };
    }

    function getOptionNow(options = {}) {
        const now = Number(options && options.now);
        return Number.isFinite(now) ? now : Date.now();
    }

    function getCachedRenderDeferDelay(options = {}) {
        const lastUserScrollAt = Number(options && options.lastUserScrollAt);
        if (!Number.isFinite(lastUserScrollAt) || lastUserScrollAt <= 0) return 0;

        const idleMs = Number(options && options.idleMs);
        const requiredIdleMs = Number.isFinite(idleMs) && idleMs > 0
            ? idleMs
            : USER_SCROLL_RENDER_DEFER_MS;
        const elapsedMs = Math.max(0, getOptionNow(options) - lastUserScrollAt);
        return elapsedMs >= requiredIdleMs ? 0 : Math.ceil(requiredIdleMs - elapsedMs);
    }

    function getRequiredJobCacheSchemaVersion(options = {}) {
        const version = Number(options && options.requiredSchemaVersion);
        return Number.isFinite(version) ? Math.trunc(version) : 0;
    }

    function getStoredEntries(stored) {
        if (stored instanceof Map) return Array.from(stored.entries());
        return Array.isArray(stored)
            ? stored.map((record) => [record && record.id, record])
            : Object.entries(stored || {});
    }

    function normalizeCachedJobTagTexts(value) {
        const rawValues = Array.isArray(value) ? value : [];
        const seen = new Set();
        return rawValues
            .map(normalizeSpace)
            .filter((text) => {
                const key = text.toLowerCase();
                if (!text || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function normalizeCachedDetailHtmlFragment(html) {
        const sanitized = sanitizeCachedDetailHtml(html);
        return sanitized
            ? sanitized.replace(/\s*(<br\s*\/?>\s*){2,}/gi, '<br>')
            : '';
    }

    function buildJobLabelListHtmlFromKeywordTexts(values) {
        const keywords = normalizeCachedJobTagTexts(values);
        if (!keywords.length) return '';

        const list = document.createElement('ul');
        list.className = 'job-label-list';
        for (const value of keywords) {
            appendTextElement(list, 'li', '', value);
        }
        return sanitizeCachedDetailHtml(list.outerHTML);
    }

    function replaceListItemsPreservingAttributes(list, values, itemSelector = ':scope > li') {
        if (!(list instanceof Element)) return false;

        const texts = normalizeCachedJobTagTexts(values);
        const templateItem = list.querySelector(itemSelector) || list.firstElementChild;
        list.textContent = '';

        for (const text of texts) {
            let item = null;
            if (templateItem instanceof Element) {
                item = templateItem.cloneNode(true);
                item.textContent = '';
            } else {
                item = document.createElement('li');
            }

            const textHost = item.querySelector('a, span') || item;
            textHost.textContent = text;
            list.appendChild(item);
        }
        return texts.length > 0;
    }

    function normalizeCachedDetailSnapshot(snapshot, fallbackRecord = null) {
        if (!snapshot || typeof snapshot !== 'object') return null;

        const normalized = {};
        for (const field of [
            'title',
            'salaryText',
            'company',
            'locationText',
            'cityText',
            'experienceText',
            'degreeText',
            'recruiterName',
            'recruiterTitle',
            'recruiterActiveTimeText',
            'recruiterStatusText',
            'addressText',
            'moreInfoHref',
            'addressMapImageSrc',
            'addressMapButtonText',
            'recruiterAvatarSrc'
        ]) {
            const value = normalizeSpace(snapshot[field]);
            if (value) normalized[field] = value;
        }

        const tagTexts = normalizeCachedJobTagTexts(snapshot.tagTexts);
        if (tagTexts.length) normalized.tagTexts = tagTexts;

        const keywordTexts = normalizeCachedJobTagTexts(snapshot.keywordTexts);
        if (keywordTexts.length) normalized.keywordTexts = keywordTexts;

        const descriptionHtml = normalizeCachedDetailHtmlFragment(snapshot.descriptionHtml);
        if (descriptionHtml) normalized.descriptionHtml = descriptionHtml;

        const companyDescriptionHtml = normalizeCachedDetailHtmlFragment(snapshot.companyDescriptionHtml);
        if (companyDescriptionHtml) normalized.companyDescriptionHtml = companyDescriptionHtml;

        const headerTagListHtml = normalizeCachedDetailHtmlFragment(snapshot.headerTagListHtml);
        if (headerTagListHtml) normalized.headerTagListHtml = headerTagListHtml;

        const jobLabelListHtml = normalizeCachedDetailHtmlFragment(snapshot.jobLabelListHtml);
        if (jobLabelListHtml) {
            normalized.jobLabelListHtml = jobLabelListHtml;
        } else if (keywordTexts.length) {
            const derivedJobLabelListHtml = buildJobLabelListHtmlFromKeywordTexts(keywordTexts);
            if (derivedJobLabelListHtml) normalized.jobLabelListHtml = derivedJobLabelListHtml;
        }

        const keywordListHtml = normalizeCachedDetailHtmlFragment(snapshot.keywordListHtml);
        if (keywordListHtml) normalized.keywordListHtml = keywordListHtml;

        if (!normalized.title && fallbackRecord) normalized.title = normalizeSpace(fallbackRecord.title);
        if (!normalized.salaryText && fallbackRecord) normalized.salaryText = normalizeSpace(fallbackRecord.salaryText);
        if (!normalized.company && fallbackRecord) normalized.company = normalizeSpace(fallbackRecord.company);
        if (!normalized.locationText && fallbackRecord) normalized.locationText = normalizeSpace(fallbackRecord.locationText);
        if ((!normalized.tagTexts || !normalized.tagTexts.length) && fallbackRecord) {
            const fallbackTags = normalizeCachedJobTagTexts(fallbackRecord.tagTexts);
            if (fallbackTags.length) normalized.tagTexts = fallbackTags;
        }

        if (!normalized.descriptionHtml && !normalized.companyDescriptionHtml && !normalized.addressText && !normalized.recruiterName) {
            return null;
        }

        return normalized;
    }

    function normalizeCachedJobRecord(key, record, now) {
        const id = normalizeSpace(key || (record && record.id));
        if (!id || !record || typeof record !== 'object') return null;

        const normalized = { id };
        const schemaVersion = Number(record.schemaVersion);
        if (Number.isFinite(schemaVersion)) normalized.schemaVersion = Math.trunc(schemaVersion);

        for (const field of ['title', 'company', 'salaryText', 'keywordText', 'logoSrc', 'locationText', 'expectationText', 'href', 'securityId', 'detailHtml', 'detailJobId', 'activeTimeText']) {
            const value = normalizeSpace(record[field]);
            if (value) normalized[field] = value;
        }

        const detailSnapshot = normalizeCachedDetailSnapshot(record.detailSnapshot, normalized);
        if (detailSnapshot) normalized.detailSnapshot = detailSnapshot;

        const tagTexts = normalizeCachedJobTagTexts(record.tagTexts);
        if (tagTexts.length) normalized.tagTexts = tagTexts;

        if (!normalized.title && !normalized.href) return null;

        const activeRank = Number(record.activeRank);
        if (Number.isFinite(activeRank)) normalized.activeRank = activeRank;

        const detailSchemaVersion = Number(record.detailSchemaVersion);
        if (Number.isFinite(detailSchemaVersion)) normalized.detailSchemaVersion = Math.trunc(detailSchemaVersion);

        const detailFetchedAt = Number(record.detailFetchedAt);
        if (Number.isFinite(detailFetchedAt)) normalized.detailFetchedAt = detailFetchedAt;

        const firstSeenAt = Number(record.firstSeenAt);
        const lastSeenAt = Number(record.lastSeenAt ?? record.seenAt ?? record.firstSeenAt);
        const resolvedLastSeenAt = Number.isFinite(lastSeenAt)
            ? lastSeenAt
            : (Number.isFinite(firstSeenAt) ? firstSeenAt : now);
        normalized.firstSeenAt = Number.isFinite(firstSeenAt) ? firstSeenAt : resolvedLastSeenAt;
        normalized.lastSeenAt = resolvedLastSeenAt;

        return normalized;
    }

    function normalizeCachedJobRecords(stored, options = {}) {
        const settings = normalizeJobCacheSettings(options);
        const now = getOptionNow(options);
        const requiredSchemaVersion = getRequiredJobCacheSchemaVersion(options);
        const cutoff = now - settings.ttlDays * DAY_MS;

        return new Map(
            getStoredEntries(stored)
                .map(([key, record]) => normalizeCachedJobRecord(key, record, now))
                .filter((record) => record
                    && (!requiredSchemaVersion || record.schemaVersion === requiredSchemaVersion)
                    && record.lastSeenAt >= cutoff)
                .map((record) => [record.id, record])
        );
    }

    function mergeCachedJobRecords(cached, currentRecords, options = {}) {
        const settings = normalizeJobCacheSettings(options);
        const now = getOptionNow(options);
        const merged = normalizeCachedJobRecords(cached, { ...options, ...settings, now });

        for (const record of Array.isArray(currentRecords) ? currentRecords : []) {
            const id = normalizeSpace(record && record.id);
            if (!id) continue;

            const existing = merged.get(id) || {};
            const next = {
                id,
                schemaVersion: JOB_CACHE_SCHEMA_VERSION,
                firstSeenAt: Number.isFinite(Number(existing.firstSeenAt)) ? Number(existing.firstSeenAt) : now,
                lastSeenAt: now
            };

        for (const field of ['title', 'company', 'salaryText', 'keywordText', 'logoSrc', 'locationText', 'expectationText', 'href', 'securityId', 'detailHtml', 'detailJobId', 'activeTimeText']) {
            const value = normalizeSpace(record && record[field]) || normalizeSpace(existing[field]);
            if (value) next[field] = value;
        }

            const detailSnapshot = normalizeCachedDetailSnapshot(record && record.detailSnapshot, next)
                || normalizeCachedDetailSnapshot(existing.detailSnapshot, next);
            if (detailSnapshot) next.detailSnapshot = detailSnapshot;

            const tagTexts = normalizeCachedJobTagTexts(record && record.tagTexts);
            const existingTagTexts = normalizeCachedJobTagTexts(existing.tagTexts);
            if (tagTexts.length || existingTagTexts.length) next.tagTexts = tagTexts.length ? tagTexts : existingTagTexts;

        const activeRank = Number(record && record.activeRank);
        const existingActiveRank = Number(existing.activeRank);
        if (Number.isFinite(activeRank)) {
            next.activeRank = activeRank;
        } else if (Number.isFinite(existingActiveRank)) {
            next.activeRank = existingActiveRank;
        }

        const detailSchemaVersion = Number(record && record.detailSchemaVersion);
        const existingDetailSchemaVersion = Number(existing.detailSchemaVersion);
        if (Number.isFinite(detailSchemaVersion)) {
            next.detailSchemaVersion = Math.trunc(detailSchemaVersion);
        } else if (Number.isFinite(existingDetailSchemaVersion) && (normalizeSpace(next.detailHtml) || next.detailSnapshot)) {
            next.detailSchemaVersion = Math.trunc(existingDetailSchemaVersion);
        }

        const detailFetchedAt = Number(record && record.detailFetchedAt);
        const existingDetailFetchedAt = Number(existing.detailFetchedAt);
        if (Number.isFinite(detailFetchedAt)) {
            next.detailFetchedAt = detailFetchedAt;
        } else if (Number.isFinite(existingDetailFetchedAt) && (normalizeSpace(next.detailHtml) || next.detailSnapshot)) {
            next.detailFetchedAt = existingDetailFetchedAt;
        }

        const normalized = normalizeCachedJobRecord(id, next, now);
        if (normalized) merged.set(id, normalized);
        }

        return normalizeCachedJobRecords(merged, { ...options, ...settings, now });
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

    function loadJobCacheSettings() {
        state.jobCacheSettings = normalizeJobCacheSettings(safeGetValue(JOB_CACHE_SETTINGS_STORAGE_KEY, {}));
    }

    function saveJobCacheSettings() {
        safeSetValue(JOB_CACHE_SETTINGS_STORAGE_KEY, state.jobCacheSettings);
    }

    function loadJobCache() {
        state.jobCache = normalizeCachedJobRecords(safeGetValue(JOB_CACHE_STORAGE_KEY, {}), {
            ...state.jobCacheSettings,
            requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION
        });
    }

    function getJobCacheStateSignature(cache = state.jobCache) {
        return Array.from((cache instanceof Map ? cache : new Map()).entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, record]) => [
                id,
                normalizeSpace(record && record.href),
                normalizeSpace(record && record.securityId),
                normalizeSpace(record && record.detailHtml),
                JSON.stringify(record && record.detailSnapshot || null),
                Number(record && record.detailSchemaVersion) || 0,
                Number(record && record.lastSeenAt) || 0
            ].join('|'))
            .join('\n');
    }

    function syncJobCacheFromStorage() {
        const before = getJobCacheStateSignature(state.jobCache);
        loadJobCache();
        const after = getJobCacheStateSignature(state.jobCache);
        return after !== before;
    }

    function saveJobCache() {
        safeSetValue(JOB_CACHE_STORAGE_KEY, serializeRecordMap(state.jobCache));
    }

    function updateCachedJobRecordPreservingListOrder(record) {
        const id = normalizeSpace(record && record.id);
        if (!id) return false;

        const now = Date.now();
        const existing = state.jobCache.get(id) || null;
        const normalizedIncoming = normalizeCachedJobRecord(id, {
            ...existing,
            ...record,
            id,
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            firstSeenAt: Number.isFinite(Number(existing && existing.firstSeenAt))
                ? Number(existing.firstSeenAt)
                : Number(record && record.firstSeenAt),
            lastSeenAt: Number.isFinite(Number(existing && existing.lastSeenAt))
                ? Number(existing.lastSeenAt)
                : Number(record && record.lastSeenAt)
        }, now);
        if (!normalizedIncoming) return false;

        const before = existing ? JSON.stringify(existing) : '';
        const after = JSON.stringify(normalizedIncoming);
        if (before === after) return false;

        state.jobCache.set(id, normalizedIncoming);
        return true;
    }

    function watchJobCacheStorage() {
        if (state.jobCacheChangeListenerId || typeof GM_addValueChangeListener !== 'function') return;
        try {
            state.jobCacheChangeListenerId = GM_addValueChangeListener(JOB_CACHE_STORAGE_KEY, (_key, _oldValue, _newValue, remote) => {
                if (!remote) return;
                if (syncJobCacheFromStorage()) scheduleRefresh();
            });
        } catch (error) {
            console.warn(`[${APP_ID}] GM_addValueChangeListener failed`, error);
            state.jobCacheChangeListenerId = null;
        }
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
            .${APP_ID}-version {
                display: inline-flex;
                align-items: center;
                height: var(--bzjt-filter-height, 40px);
                color: #b8bdc7;
                font-size: 12px;
                line-height: 1;
                white-space: nowrap;
            }
            .${APP_ID}-ignored-job {
                display: none !important;
            }
            .${APP_ID}-filtered-job {
                display: none !important;
            }
            .${APP_ID}-cached-card {
                cursor: pointer;
            }
            .${APP_ID}-cached-list-host {
                min-height: max-content;
                padding-bottom: 16px !important;
            }
            .${APP_ID}-cached-scroll-host {
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch;
            }
            .${APP_ID}-cached-scroll-host .${APP_ID}-cached-card {
                scroll-margin-bottom: 16px;
            }
            .${APP_ID}-logo-placeholder {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                height: 100%;
                min-width: 40px;
                min-height: 40px;
                border-radius: 4px;
                background: #f2f5f9;
                color: #8d92a1;
                font-size: 14px;
                font-weight: 600;
                line-height: 1;
                box-sizing: border-box;
            }
            .${APP_ID}-logo-placeholder::before {
                content: attr(data-initial);
            }
            .${APP_ID}-cache-tag {
                color: #00a6a7;
            }
            .${APP_ID}-cached-meta {
                display: inline-flex;
                align-items: center;
                max-width: 130px;
                color: #8d92a1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .${APP_ID}-cached-detail > :not(.${APP_ID}-cached-detail-overlay) {
                display: none !important;
            }
            .${APP_ID}-cached-detail-overlay {
                display: block;
            }
            .${APP_ID}-cached-detail .${APP_ID}-cached-detail-fallback {
                color: #414a60;
            }
            .${APP_ID}-cached-detail-link {
                display: inline-block;
                margin-top: 10px;
                color: #00a6a7;
            }
            .${APP_ID}-detail-debug-panel {
                position: fixed;
                top: 88px;
                right: 24px;
                z-index: 2147483645;
                width: min(420px, calc(100vw - 32px));
                max-height: calc(100vh - 120px);
                overflow: auto;
                padding: 14px 16px;
                border: 1px solid rgba(65, 74, 96, 0.12);
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.96);
                color: #1f2d3d;
                box-shadow: 0 18px 40px rgba(20, 29, 40, 0.18);
                backdrop-filter: blur(8px);
                box-sizing: border-box;
            }
            .${APP_ID}-detail-debug-title {
                margin: 0 0 10px;
                color: #1f2d3d;
                font-size: 15px;
                font-weight: 600;
                line-height: 1.4;
            }
            .${APP_ID}-detail-debug-actions {
                display: none;
                gap: 8px;
                margin: 0 0 10px;
            }
            .${APP_ID}-picker-fab {
                position: fixed;
                left: 18px;
                bottom: 18px;
                z-index: 2147483645;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 46px;
                height: 46px;
                border: 0;
                border-radius: 999px;
                background: #00bebd;
                color: #fff;
                box-shadow: 0 10px 28px rgba(20, 29, 40, 0.22);
                cursor: pointer;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 14px;
                line-height: 1;
            }
            .${APP_ID}-picker-fab:hover {
                background: #00a6a7;
            }
            .${APP_ID}-picker-fab.${APP_ID}-picker-fab-active {
                background: #f97316;
            }
            .${APP_ID}-picker-fab-label {
                pointer-events: none;
                transform: translateY(-1px);
            }
            .${APP_ID}-detail-debug-button {
                appearance: none;
                border: 0;
                border-radius: 8px;
                background: #00bebd;
                color: #fff;
                font: inherit;
                font-size: 12px;
                line-height: 1;
                padding: 10px 12px;
                cursor: pointer;
            }
            .${APP_ID}-detail-debug-button:hover {
                background: #00a6a7;
            }
            .${APP_ID}-detail-debug-button.${APP_ID}-detail-debug-button-active {
                background: #f97316;
            }
            .${APP_ID}-detail-debug-meta {
                margin: 0 0 10px;
                color: #6b7280;
                font-size: 12px;
                line-height: 1.5;
            }
            .${APP_ID}-detail-debug-pre {
                margin: 0;
                padding: 12px;
                border-radius: 10px;
                background: #f5f7fb;
                color: #334155;
                font-size: 12px;
                line-height: 1.55;
                white-space: pre-wrap;
                word-break: break-word;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            }
            .${APP_ID}-detail-debug-picker-overlay {
                position: fixed;
                z-index: 2147483644;
                border: 2px solid #f97316;
                background: rgba(249, 115, 22, 0.08);
                pointer-events: none;
                box-sizing: border-box;
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
            .${APP_ID}-settings-field input[type="number"] {
                width: 100%;
                height: 34px;
                border: 1px solid #e3e7ed;
                border-radius: 4px;
                padding: 0 8px;
                color: #414a60;
                font-size: 13px;
                box-sizing: border-box;
            }
            .${APP_ID}-settings-field input[type="number"]:focus {
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

    function isCachedJobCard(card) {
        return Boolean(card?.classList?.contains(`${APP_ID}-cached-card`));
    }

    function getLiveJobCards() {
        return getJobCards().filter((card) => !isCachedJobCard(card));
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
        const firstCard = getLiveJobCards()[0] || getJobCards()[0];
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

    function getActiveJobExpectationText() {
        return normalizeSpace(document.querySelector('.expect-item.active')?.textContent || '');
    }

    function hasActiveJobExpectation() {
        const activeText = getActiveJobExpectationText();
        if (!activeText || !isRealJobExpectationText(activeText)) return false;
        return Boolean(state.jobExpectationSelectedByUser
            && state.selectedExpectationText === activeText
            && Date.now() - state.expectationSelectedAt >= EXPECTATION_CACHE_SETTLE_MS);
    }

    function getJobExpectationItems() {
        return Array.from(document.querySelectorAll('.expect-item'))
            .filter((element) => element instanceof HTMLElement && normalizeSpace(element.textContent));
    }

    function markJobExpectationSelected(target) {
        if (!target || !isRealJobExpectationText(normalizeSpace(target.textContent))) return false;
        state.jobExpectationSelectedByUser = true;
        state.selectedExpectationText = normalizeSpace(target.textContent);
        state.expectationSelectedAt = Date.now();
        state.lastCacheSignature = '';
        return true;
    }

    function findDefaultJobExpectationItem() {
        const items = getJobExpectationItems();
        const index = findAutoJobExpectationIndex(items.map((item) => normalizeSpace(item.textContent)));
        return index >= 0 ? items[index] : null;
    }

    function autoSelectDefaultJobExpectation() {
        if (state.jobExpectationTouchedByUser) return false;

        const activeItem = document.querySelector('.expect-item.active');
        const activeText = normalizeSpace(activeItem?.textContent || '');
        if (activeText && isRealJobExpectationText(activeText)) {
            return markJobExpectationSelected(activeItem);
        }

        const target = findDefaultJobExpectationItem();
        if (!target || !markJobExpectationSelected(target)) return false;
        target.click();
        scheduleRefresh();
        return true;
    }

    function handleJobExpectationClick(event) {
        const target = event.target instanceof Element ? event.target.closest('.expect-item') : null;
        if (!target) return;

        state.jobExpectationTouchedByUser = true;
        if (!isRealJobExpectationText(normalizeSpace(target.textContent))) return;
        markJobExpectationSelected(target);
        scheduleRefresh();
    }

    function getCardAnchor(card) {
        return card ? card.querySelector('a.job-name[href], a[href*="/job_detail/"]') : null;
    }

    function getJobIdFromCard(card) {
        if (isCachedJobCard(card)) return normalizeSpace(card.dataset.bzjtCachedId);
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

    function normalizeImageSrc(src) {
        const value = normalizeSpace(src);
        if (!value || /^data:image\/gif;base64,R0lGODlhAQABA/i.test(value)) return '';

        try {
            return new URL(value, location.href).href;
        } catch (error) {
            return value;
        }
    }

    function getElementImageSrc(element) {
        if (!element) return '';

        const attributeSrc = element.currentSrc
            || element.getAttribute?.('src')
            || element.getAttribute?.('data-src')
            || element.getAttribute?.('data-original')
            || element.getAttribute?.('data-url')
            || '';
        const normalizedAttributeSrc = normalizeImageSrc(attributeSrc);
        if (normalizedAttributeSrc) return normalizedAttributeSrc;

        const backgroundImage = getComputedStyle(element).backgroundImage;
        const match = backgroundImage && backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
        return normalizeImageSrc(match?.[1] || '');
    }

    function getCardLogoSrc(card) {
        if (!card) return '';

        const candidates = Array.from(card.querySelectorAll([
            '.company-logo img',
            '.company-img img',
            '.company-info img',
            '.boss-avatar img',
            '.job-card-right img',
            '.company-logo',
            '.company-img',
            '.boss-avatar',
            '[class*="logo"]',
            'img'
        ].join(',')));
        for (const candidate of candidates) {
            const src = getElementImageSrc(candidate);
            if (src) return src;
        }
        return '';
    }

    function getTextFromElements(elements) {
        return normalizeSpace(Array.from(elements || [])
            .map((element) => normalizeSpace(element.textContent))
            .filter(Boolean)
            .join(' '));
    }

    function getTextListFromElements(elements) {
        const seen = new Set();
        return Array.from(elements || [])
            .map((element) => normalizeSpace(element.textContent))
            .filter((text) => {
                const key = text.toLowerCase();
                if (!text || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
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

    function getCardTagTexts(card) {
        if (!card) return [];

        const directTags = getTextListFromElements(card.querySelectorAll([
            '.tag-list li',
            '.job-tag-list li',
            '.job-card-tag-list li',
            '.job-card-tags li',
            '.job-tags li',
            '.job-info .tag',
            '.job-info .label',
            '.job-card-body .tag',
            '.job-card-body .label'
        ].join(',')));
        if (directTags.length) return directTags;

        const keywordText = getCardKeywordText(card);
        return keywordText ? [keywordText] : [];
    }

    function getCardLocationText(card) {
        if (!card) return '';

        const location = Array.from(card.querySelectorAll([
            '.job-area',
            '.job-location',
            '.company-location',
            '[class*="job-area"]',
            '[class*="location"]'
        ].join(',')))
            .map((element) => normalizeSpace(element.textContent))
            .find((text) => text && text.length <= 40);
        return location || '';
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

    function formatCachedJobAge(lastSeenAt) {
        const seenAt = Number(lastSeenAt);
        if (!Number.isFinite(seenAt)) return '缓存';

        const elapsedMs = Math.max(0, Date.now() - seenAt);
        const minutes = Math.floor(elapsedMs / 60000);
        if (minutes < 1) return '刚刚缓存';
        if (minutes < 60) return `${minutes}分钟前缓存`;

        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}小时前缓存`;

        const days = Math.floor(hours / 24);
        return `${days}天前缓存`;
    }

    function appendTextElement(parent, tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        element.textContent = normalizeSpace(text);
        parent.appendChild(element);
        return element;
    }

    function getCachedJobHref(record) {
        const href = normalizeSpace(record && record.href);
        if (href) return href;

        try {
            return new URL(`/job_detail/${encodeURIComponent(record.id)}.html`, location.origin).href;
        } catch (error) {
            return '';
        }
    }

    function getCachedJobRecoveryHref(record) {
        const href = getCachedJobHref(record);
        const sourceId = normalizeSpace(record && record.id);
        if (!href || !sourceId) return href;

        try {
            const url = new URL(href, location.origin);
            const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
            hashParams.set(`${APP_ID}-source-id`, sourceId);
            url.hash = hashParams.toString();
            return url.href;
        } catch (error) {
            return href;
        }
    }

    function resolveDetailRootContainer(candidate) {
        if (!(candidate instanceof Element)) return null;
        return candidate.closest(DETAIL_ROOT_CONTAINER_SELECTOR) || candidate;
    }

    function getDetailRootCandidates(scope) {
        const root = scope || document;
        const elements = [];
        if (root instanceof Element && root.matches(DETAIL_SCAN_SELECTOR)) elements.push(root);
        elements.push(...Array.from(root.querySelectorAll(DETAIL_SCAN_SELECTOR)));

        const seen = new Set();
        return elements
            .map((element) => resolveDetailRootContainer(element))
            .filter((element) => {
                if (!element || seen.has(element)) return false;
                seen.add(element);
                return true;
            });
    }

    function findBestDetailRoot(candidates, requireVisible = false) {
        const roots = (Array.isArray(candidates) ? candidates : [])
            .filter((candidate) => candidate && (!requireVisible || isVisibleElement(candidate)));
        const hasDescription = (candidate) => normalizeSpace(candidate.textContent).includes('职位描述');
        const hasHeader = (candidate) => Boolean(candidate.querySelector('.job-detail-header, .job-name, h1'));

        return roots.find((candidate) => hasHeader(candidate) && hasDescription(candidate))
            || roots.find(hasHeader)
            || roots.find(hasDescription)
            || roots[0]
            || null;
    }

    function findDetailRootInDocument(root) {
        const candidates = getDetailRootCandidates(root);
        return findBestDetailRoot(candidates);
    }

    function findDetailRoot() {
        const candidates = getDetailRootCandidates(document);
        return findBestDetailRoot(candidates, true);
    }

    function sanitizeCachedDetailHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        template.content.querySelectorAll('script, iframe, object, embed, link[rel="preload"]').forEach((element) => element.remove());
        template.content.querySelectorAll('*').forEach((element) => {
            for (const attribute of Array.from(element.attributes)) {
                if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
            }
        });
        return template.innerHTML;
    }

    function getCurrentDetailHtmlForCard(card) {
        const id = getJobIdFromCard(card);
        const currentCard = getCurrentJobCard();
        if (!id || !currentCard || getJobIdFromCard(currentCard) !== id) return '';

        const root = findDetailRoot();
        return root ? sanitizeCachedDetailHtml(root.innerHTML) : '';
    }

    function getCurrentDetailSnapshotForCard(card) {
        const id = getJobIdFromCard(card);
        const currentCard = getCurrentJobCard();
        if (!id || !currentCard || getJobIdFromCard(currentCard) !== id) return null;

        const root = findDetailRoot();
        return root ? buildDetailSnapshotFromRoot(root, {
            id,
            title: getCardTitle(card),
            company: getCardCompany(card),
            salaryText: getCardSalaryText(card),
            locationText: getCardLocationText(card),
            tagTexts: getCardTagTexts(card)
        }) : null;
    }

    function getCurrentDetailSecurityIdForCard(card) {
        const id = getJobIdFromCard(card);
        const currentCard = getCurrentJobCard();
        if (!id || !currentCard || getJobIdFromCard(currentCard) !== id) return '';

        const root = findDetailRoot();
        const detailLink = root?.querySelector('a.more-job-btn[href*="securityId="], a[href*="/job_detail/"][href*="securityId="]');
        return extractSecurityIdFromHref(detailLink?.getAttribute('href') || detailLink?.href || '');
    }

    function findLiveJobCardById(id) {
        const targetId = normalizeSpace(id);
        if (!targetId) return null;
        return getLiveJobCards().find((card) => getJobIdFromCard(card) === targetId) || null;
    }

    function resolveLiveSecurityIdForRecord(record) {
        const id = normalizeSpace(record && record.id);
        if (!id) return '';
        const liveCard = findLiveJobCardById(id);
        if (!liveCard) return '';
        const jobData = getCardJobData(liveCard);
        return getJobDataSecurityId(jobData) || getCurrentDetailSecurityIdForCard(liveCard);
    }

    function ensureRecordSecurityId(record) {
        const currentSecurityId = normalizeSpace(record && record.securityId);
        if (currentSecurityId) return currentSecurityId;

        const resolvedSecurityId = resolveLiveSecurityIdForRecord(record);
        const id = normalizeSpace(record && record.id);
        if (id && resolvedSecurityId) {
            const latestRecord = state.jobCache.get(id) || record;
            state.jobCache.set(id, {
                ...latestRecord,
                securityId: resolvedSecurityId
            });
            saveJobCache();
        }
        return resolvedSecurityId;
    }

    function getStandaloneDetailTagTexts(root) {
        const scope = root || document;
        return getTextListFromElements(scope.querySelectorAll([
            '.job-detail-header .tag-list li',
            '.job-detail-header .job-tags li',
            '.job-detail-header .job-tags span',
            '.job-detail-header .labels li',
            '.job-detail-header .tag',
            '.job-detail-header .label',
            '.job-banner .tag-list li',
            '.job-banner .job-tags span',
            '.job-banner .tag',
            '.job-card-left .tag-list li',
            '.job-keyword-list li'
        ].join(',')));
    }

    function getStandaloneDetailKeywordTexts(root) {
        const scope = root || document;
        return getTextListFromElements(scope.querySelectorAll('.job-keyword-list li'));
    }

    function cloneStandaloneBannerTags(root) {
        const scope = root || document;
        const nativeTags = scope.querySelector('.job-banner .job-tags');
        if (nativeTags instanceof Element) return nativeTags.cloneNode(true);

        const tagTexts = getStandaloneDetailTagTexts(scope);
        if (!tagTexts.length) return null;

        const tags = document.createElement('div');
        tags.className = 'job-tags';
        for (const value of tagTexts) {
            appendTextElement(tags, 'span', '', value);
        }
        return tags;
    }

    function getStandaloneDetailLocationText(root) {
        const scope = root || document;
        const companyText = normalizeSpace(scope.querySelector('.job-detail-company .company-name, .sider-company .company-info a[title], .company-name')?.textContent || '');
        return Array.from(scope.querySelectorAll([
            '.job-banner .text-city',
            '.job-detail-company .job-area',
            '.job-detail-company [class*="location"]',
            '.job-detail-header .job-area',
            '.job-detail-header [class*="location"]',
            '.location-address',
            '.basic-infor .location'
        ].join(',')) || [])
            .map((element) => normalizeSpace(element.textContent))
            .find((text) => text && text !== companyText && text.length <= 40) || '';
    }

    function findStandaloneDetailDescriptionSection(root) {
        const sections = Array.from(root?.querySelectorAll('.job-detail-section') || []);
        return sections.find((section) => normalizeSpace(section.textContent).includes('职位描述'))
            || sections.find((section) => section.querySelector('.job-sec-text'))
            || null;
    }

    function getStandaloneDetailDescriptionHtml(root) {
        const descriptionSection = findStandaloneDetailDescriptionSection(root);
        const content = descriptionSection?.querySelector('.job-sec-text') || descriptionSection;
        return normalizeCachedDetailHtmlFragment(content?.innerHTML || '');
    }

    function getStandaloneRecruiterSnapshot(root) {
        const scope = root || document;
        return {
            recruiterAvatarSrc: normalizeSpace(scope.querySelector('.job-boss-info .detail-figure img[src]')?.getAttribute('src') || scope.querySelector('.job-boss-info .detail-figure img[src]')?.src || ''),
            recruiterName: normalizeSpace(scope.querySelector('.job-boss-info .name')?.childNodes?.[0]?.textContent || scope.querySelector('.job-boss-info .name')?.textContent || ''),
            recruiterTitle: normalizeSpace(scope.querySelector('.job-boss-info .boss-info-attr')?.textContent || ''),
            recruiterActiveTimeText: normalizeSpace(scope.querySelector('.job-boss-info .boss-active-time')?.textContent || ''),
            recruiterStatusText: normalizeSpace(scope.querySelector('.job-boss-info .boss-online-tag, .job-boss-info .boss-active-time')?.textContent || '')
        };
    }

    function getStandaloneCompanyDescriptionHtml(root) {
        const scope = root || document;
        const companyDescription = scope.querySelector('.company-info-box .job-sec-text, .company-info-box .fold-text');
        return normalizeCachedDetailHtmlFragment(companyDescription?.innerHTML || '');
    }

    function getStandaloneDetailAddressText(root) {
        const scope = root || document;
        return normalizeSpace(scope.querySelector('.company-address .location-address, .job-location .location-address, .job-address .location-address')?.textContent || '');
    }

    function getStandaloneHeaderMetaTexts(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.job-detail-header .tag-list li'));
        return items.map((item) => normalizeSpace(item.textContent)).filter(Boolean);
    }

    function buildDetailSnapshotFromRoot(root, fallbackRecord = {}) {
        if (!(root instanceof Element || root instanceof DocumentFragment || root instanceof Document)) return null;

        const title = normalizeSpace(root.querySelector('.job-banner .name h1, .job-primary .name h1, .job-detail-header .job-name, .job-detail-header h1, .job-name, h1')?.textContent || fallbackRecord.title || document.title);
        const salaryText = normalizeSpace(root.querySelector('.job-banner .salary, .job-primary .salary, .job-detail-header .salary, .job-detail-header .job-salary, .salary, .job-salary, [class*="salary"]')?.textContent || fallbackRecord.salaryText || '');
        const company = normalizeSpace(root.querySelector('.sider-company .company-info a[title], .job-detail-company .company-name, .company-info .company-name, .company-name, [class*="company-name"]')?.textContent || fallbackRecord.company || '');
        const locationText = getStandaloneDetailLocationText(root) || normalizeSpace(fallbackRecord.locationText);
        const [cityText = '', experienceText = '', degreeText = ''] = getStandaloneHeaderMetaTexts(root);
        const tagTexts = getStandaloneDetailTagTexts(root);
        const keywordTexts = getStandaloneDetailKeywordTexts(root);
        const descriptionHtml = getStandaloneDetailDescriptionHtml(root);
        const { recruiterAvatarSrc, recruiterName, recruiterTitle, recruiterActiveTimeText, recruiterStatusText } = getStandaloneRecruiterSnapshot(root);
        const companyDescriptionHtml = getStandaloneCompanyDescriptionHtml(root);
        const addressText = getStandaloneDetailAddressText(root);
        const headerTagListHtml = sanitizeCachedDetailHtml(root.querySelector('.job-detail-header .tag-list')?.outerHTML || '');
        const jobLabelListHtml = sanitizeCachedDetailHtml(root.querySelector('.job-label-list')?.outerHTML || '');
        const keywordListHtml = sanitizeCachedDetailHtml(root.querySelector('.job-keyword-list')?.outerHTML || '');
        const addressMapImageSrc = normalizeSpace(root.querySelector('.company-address .job-location img[src], .job-location img[src], .job-location-map img[src], .map-box-wrapper img[src]')?.getAttribute('src') || root.querySelector('.company-address .job-location img[src], .job-location img[src], .job-location-map img[src], .map-box-wrapper img[src]')?.src || '');
        const addressMapButtonText = normalizeSpace(root.querySelector('.company-address .job-location p, .job-location-map p, .map-box-wrapper p, .address-map-btn')?.textContent || '');
        const moreInfoHref = normalizeSpace(root.querySelector('.more-job-btn')?.getAttribute('href') || root.querySelector('.more-job-btn')?.href || '');

        return normalizeCachedDetailSnapshot({
            title,
            salaryText,
            company,
            locationText,
            cityText,
            experienceText,
            degreeText,
            tagTexts,
            keywordTexts,
            descriptionHtml,
            recruiterAvatarSrc,
            recruiterName,
            recruiterTitle,
            recruiterActiveTimeText,
            recruiterStatusText,
            companyDescriptionHtml,
            addressText,
            headerTagListHtml,
            jobLabelListHtml,
            keywordListHtml,
            moreInfoHref
            ,
            addressMapImageSrc,
            addressMapButtonText
        }, fallbackRecord);
    }

    function appendSnapshotTagSpans(parent, values) {
        for (const value of normalizeCachedJobTagTexts(values)) {
            appendTextElement(parent, 'span', '', value);
        }
    }

    function appendSnapshotKeywordItems(parent, values) {
        for (const value of normalizeCachedJobTagTexts(values)) {
            appendTextElement(parent, 'li', '', value);
        }
    }

    function buildCachedJobDetailHtmlFromSnapshot(snapshot, record = null) {
        const normalized = normalizeCachedDetailSnapshot(snapshot, record);
        if (!normalized) return '';

        const wrapper = document.createElement('div');
        const header = appendTextElement(wrapper, 'div', 'job-detail-header', '');
        appendTextElement(header, 'div', 'job-name', normalized.title || '缓存职位');
        if (normalized.salaryText) appendTextElement(header, 'span', 'salary', normalized.salaryText);

        if (normalized.company || normalized.locationText) {
            const company = appendTextElement(wrapper, 'div', 'job-detail-company', '');
            if (normalized.company) appendTextElement(company, 'span', 'company-name', normalized.company);
            if (normalized.locationText) appendTextElement(company, 'span', 'job-area', normalized.locationText);
        }

        if (normalized.tagTexts && normalized.tagTexts.length) {
            const tags = document.createElement('div');
            tags.className = 'job-tags';
            appendSnapshotTagSpans(tags, normalized.tagTexts);
            wrapper.appendChild(tags);
        }

        const section = appendTextElement(wrapper, 'div', 'job-detail-section', '');
        const sectionHeader = appendTextElement(section, 'div', 'detail-content-header', '');
        appendTextElement(sectionHeader, 'h3', '', '职位描述');
        if (normalized.keywordTexts && normalized.keywordTexts.length) {
            const keywordList = appendTextElement(section, 'ul', 'job-keyword-list', '');
            appendSnapshotKeywordItems(keywordList, normalized.keywordTexts);
        }
        if (normalized.descriptionHtml) {
            const description = document.createElement('div');
            description.className = 'job-sec-text';
            description.innerHTML = normalized.descriptionHtml;
            section.appendChild(description);
        }
        if (normalized.recruiterName || normalized.recruiterTitle || normalized.recruiterActiveTimeText) {
            const bossInfo = appendTextElement(section, 'div', 'job-boss-info', '');
            const bossName = appendTextElement(bossInfo, 'h2', 'name', normalized.recruiterName || '');
            if (normalized.recruiterActiveTimeText) appendTextElement(bossName, 'span', 'boss-active-time', normalized.recruiterActiveTimeText);
            if (normalized.recruiterTitle) appendTextElement(bossInfo, 'div', 'boss-info-attr', normalized.recruiterTitle);
        }

        if (normalized.companyDescriptionHtml || normalized.addressText) {
            const companySection = appendTextElement(wrapper, 'div', 'job-detail-section job-detail-company', '');
            if (normalized.companyDescriptionHtml) {
                const companyInfo = appendTextElement(companySection, 'div', 'detail-section-item company-info-box', '');
                appendTextElement(companyInfo, 'h3', '', '公司介绍');
                const description = document.createElement('div');
                description.className = 'job-sec-text fold-text';
                description.innerHTML = normalized.companyDescriptionHtml;
                companyInfo.appendChild(description);
            }
            if (normalized.addressText) {
                const address = appendTextElement(companySection, 'div', 'detail-section-item company-address', '');
                appendTextElement(address, 'h3', '', '工作地址');
                const location = appendTextElement(address, 'div', 'job-location', '');
                appendTextElement(location, 'div', 'location-address', normalized.addressText);
            }
        }

        return sanitizeCachedDetailHtml(wrapper.innerHTML);
    }

    function replaceElementFromHtml(root, selector, html, options = {}) {
        const target = root?.querySelector(selector);
        if (!target) return false;

        const normalizedHtml = normalizeCachedDetailHtmlFragment(html);
        if (!normalizedHtml) {
            if (options.removeWhenEmpty) target.remove();
            return false;
        }

        const template = document.createElement('template');
        template.innerHTML = normalizedHtml;
        const replacement = template.content.firstElementChild;
        if (!replacement) {
            if (options.removeWhenEmpty) target.remove();
            return false;
        }
        target.replaceWith(replacement);
        return true;
    }

    function buildCachedJobDetailHtmlFromNativeShellSnapshot(snapshot, record, root) {
        if (!(root instanceof Element)) return '';
        const normalized = normalizeCachedDetailSnapshot(snapshot, record);
        if (!normalized) return '';

        const clone = root.cloneNode(true);
        clone.classList.remove(`${APP_ID}-cached-detail`);
        clone.classList.add(`${APP_ID}-cached-detail-fallback`);
        clone.querySelectorAll(`.${APP_ID}-cached-detail-overlay`).forEach((element) => element.remove());
        clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));

        replaceElementText(clone.querySelector('.job-detail-header .job-name, .job-detail-header h1, h1, .job-name'), normalized.title || record.title || '缓存职位');
        replaceElementText(clone.querySelector('.job-detail-header .job-salary, .job-detail-header .salary, .salary, .job-salary, [class*="salary"]'), normalized.salaryText || record.salaryText);

        if (!replaceElementFromHtml(clone, '.job-detail-header .tag-list', normalized.headerTagListHtml)) {
            const tagList = clone.querySelector('.job-detail-header .tag-list');
            if (tagList) {
                tagList.textContent = '';
                for (const text of [normalized.cityText, normalized.experienceText, normalized.degreeText].filter(Boolean)) {
                    const item = document.createElement('li');
                    const span = document.createElement('span');
                    span.textContent = text;
                    item.appendChild(span);
                    tagList.appendChild(item);
                }
            }
        }

        const bodyTitle = clone.querySelector('.job-detail-body > .title, .job-detail-body .title');
        if (bodyTitle) bodyTitle.textContent = '职位描述';

        replaceElementFromHtml(clone, '.job-detail-body .job-label-list', normalized.jobLabelListHtml, { removeWhenEmpty: true });

        const desc = clone.querySelector('.job-detail-body .desc, .job-detail-body .job-sec-text, .job-detail-body p.desc');
        if (desc) {
            if (normalized.descriptionHtml) {
                desc.innerHTML = normalized.descriptionHtml;
            } else {
                desc.textContent = '';
            }
        }

        replaceElementFromHtml(clone, '.job-detail-body .job-boss-info', normalized.bossInfoHtml, { removeWhenEmpty: true });
        replaceElementFromHtml(clone, '.job-detail-body .job-address', normalized.jobAddressHtml, { removeWhenEmpty: true });

        const moreInfoLink = clone.querySelector('.job-detail-body .more-job-btn');
        const moreInfoHref = normalizeSpace(normalized.moreInfoHref) || getCachedJobRecoveryHref(record);
        if (moreInfoLink && moreInfoHref) {
            moreInfoLink.setAttribute('href', moreInfoHref);
            moreInfoLink.href = moreInfoHref;
        }

        return sanitizeCachedDetailHtml(clone.outerHTML);
    }

    function buildCachedJobDetailHtmlFromJobsRightShellSnapshot(snapshot, record, root) {
        if (!(root instanceof Element)) return '';
        const normalized = normalizeCachedDetailSnapshot(snapshot, record);
        if (!normalized) return '';

        const clone = root.cloneNode(true);
        clone.classList.remove(`${APP_ID}-cached-detail`);
        clone.classList.add(`${APP_ID}-cached-detail-fallback`);
        clone.querySelectorAll(`.${APP_ID}-cached-detail-overlay`).forEach((element) => element.remove());
        clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));

        replaceElementText(clone.querySelector('.job-detail-header .job-name, .job-detail-header h1, h1, .job-name'), normalized.title || record.title || '缓存职位');
        replaceElementText(clone.querySelector('.job-detail-header .job-salary, .job-detail-header .salary, .salary, .job-salary, [class*="salary"]'), normalized.salaryText || record.salaryText);

        const tagList = clone.querySelector('.job-detail-header .tag-list');
        if (tagList) {
            replaceListItemsPreservingAttributes(tagList, [normalized.cityText, normalized.experienceText, normalized.degreeText].filter(Boolean));
        }

        const bodyTitle = clone.querySelector('.job-detail-body > .title, .job-detail-body .title');
        if (bodyTitle) bodyTitle.textContent = '职位描述';

        const labelList = clone.querySelector('.job-detail-body .job-label-list');
        if (labelList) {
            replaceListItemsPreservingAttributes(labelList, normalized.keywordTexts);
        }

        const desc = clone.querySelector('.job-detail-body .desc, .job-detail-body .job-sec-text, .job-detail-body p.desc');
        if (desc) {
            if (normalized.descriptionHtml) {
                desc.innerHTML = normalized.descriptionHtml;
            } else {
                desc.textContent = '';
            }
        }

        const bossInfo = clone.querySelector('.job-detail-body .job-boss-info');
        if (bossInfo) {
            const bossAvatar = bossInfo.querySelector('.detail-figure img[src], .detail-figure img');
            if (bossAvatar && normalized.recruiterAvatarSrc) {
                bossAvatar.setAttribute('src', normalized.recruiterAvatarSrc);
                bossAvatar.src = normalized.recruiterAvatarSrc;
            }
            const bossName = bossInfo.querySelector('.name');
            if (bossName) {
                const vipIcon = bossName.querySelector('.icon-vip');
                const activeTag = bossName.querySelector('.boss-online-tag, .boss-active-time');
                bossName.childNodes.forEach((node) => {
                    if (node.nodeType === Node.TEXT_NODE) node.textContent = '';
                });
                bossName.insertBefore(document.createTextNode(` ${normalized.recruiterName || ''}`), vipIcon || activeTag || null);
                if (activeTag) activeTag.textContent = normalized.recruiterStatusText || normalized.recruiterActiveTimeText || '';
            }
            replaceElementText(bossInfo.querySelector('.boss-info-attr'), normalized.recruiterTitle);
        }

        const jobAddress = clone.querySelector('.job-detail-body .job-address');
        if (jobAddress) {
            const addressTitle = jobAddress.querySelector('.job-address-title');
            if (addressTitle) addressTitle.textContent = '工作地址';
            const addressDesc = jobAddress.querySelector('.job-address-desc, .location-address');
            replaceElementText(addressDesc, normalized.addressText);
            const mapImage = jobAddress.querySelector('img[src]');
            if (mapImage && normalized.addressMapImageSrc) {
                mapImage.setAttribute('src', normalized.addressMapImageSrc);
                mapImage.src = normalized.addressMapImageSrc;
            }
            const mapButton = jobAddress.querySelector('.address-map-btn, .map-box-wrapper p, .job-location-map p');
            if (mapButton && normalized.addressMapButtonText) mapButton.textContent = normalized.addressMapButtonText;
        }

        const moreInfoLink = clone.querySelector('.job-detail-body .more-job-btn');
        const moreInfoHref = normalizeSpace(normalized.moreInfoHref) || getCachedJobRecoveryHref(record);
        if (moreInfoLink && moreInfoHref) {
            moreInfoLink.setAttribute('href', moreInfoHref);
            moreInfoLink.href = moreInfoHref;
        }

        return sanitizeCachedDetailHtml(clone.outerHTML);
    }

    function buildStandaloneDetailCaptureHtml(root, record) {
        const wrapper = document.createElement('div');
        const header = appendTextElement(wrapper, 'div', 'job-detail-header', '');
        appendTextElement(header, 'div', 'job-name', record.title || '缓存职位');
        if (record.salaryText) appendTextElement(header, 'span', 'salary', record.salaryText);

        const company = appendTextElement(wrapper, 'div', 'job-detail-company', '');
        if (record.company) appendTextElement(company, 'span', 'company-name', record.company);
        if (record.locationText) appendTextElement(company, 'span', 'job-area', record.locationText);

        const nativeTags = cloneStandaloneBannerTags();
        if (nativeTags) wrapper.appendChild(nativeTags);

        const descriptionSection = findStandaloneDetailDescriptionSection(root);
        if (descriptionSection) {
            wrapper.appendChild(descriptionSection.cloneNode(true));
        } else {
            const section = appendTextElement(wrapper, 'div', 'job-detail-section', '');
            appendTextElement(section, 'h3', '', '职位描述');
            appendTextElement(section, 'div', 'text', normalizeSpace(root?.textContent || ''));
        }

        const companyDetailSection = document.querySelector('.job-detail-company');
        if (companyDetailSection) wrapper.appendChild(companyDetailSection.cloneNode(true));

        return sanitizeCachedDetailHtml(wrapper.innerHTML);
    }

    function buildStandaloneJobDetailCacheRecord(root) {
        const detailId = extractJobIdFromHref(location.href);
        const recoverySourceId = resolveStandaloneRecoverySourceJobId(detailId);
        const id = recoverySourceId || detailId;
        const title = normalizeSpace(document.querySelector('.job-banner .name h1, .job-primary .name h1, .job-detail-header .job-name, .job-detail-header h1, .job-name, h1')?.textContent || document.title);
        const salaryText = normalizeSpace(document.querySelector('.job-banner .salary, .job-primary .salary, .job-detail-header .salary, .job-detail-header .job-salary, .salary, .job-salary, [class*="salary"]')?.textContent || '');
        const company = normalizeSpace(document.querySelector('.sider-company .company-info a[title], .job-detail-company .company-name, .company-info .company-name, .company-name, [class*="company-name"]')?.textContent || '');
        const locationText = getStandaloneDetailLocationText(root);
        const tagTexts = getStandaloneDetailTagTexts(root);
        const detailHtml = buildStandaloneDetailCaptureHtml(root, {
            title,
            salaryText,
            company,
            locationText,
            tagTexts
        });
        if (!id || !detailHtml) return null;
        const securityId = extractSecurityIdFromHref(location.href)
            || extractSecurityIdFromHref(root.querySelector('a.more-job-btn[href*="securityId="], a[href*="/job_detail/"][href*="securityId="]')?.href || '');

        return {
            id,
            title,
            company,
            salaryText,
            locationText,
            tagTexts,
            href: location.href,
            securityId,
            detailHtml,
            detailJobId: id,
            detailSchemaVersion: DETAIL_CACHE_SCHEMA_VERSION
        };
    }

    function getCachedDetailCaptureSignature(record) {
        if (!record) return '';
        return [
            normalizeSpace(record.id),
            normalizeSpace(record.href),
            normalizeSpace(record.securityId),
            normalizeSpace(record.title),
            normalizeSpace(record.company),
            normalizeSpace(record.salaryText),
            normalizeSpace(record.locationText),
            JSON.stringify(normalizeCachedJobTagTexts(record.tagTexts)),
            normalizeSpace(record.detailHtml),
            Number(record.detailSchemaVersion) || 0
        ].join('|');
    }

    function buildStandaloneDetailCaptureHtml(root, record) {
        const snapshot = buildDetailSnapshotFromRoot(root, record);
        return buildCachedJobDetailHtmlFromSnapshot(snapshot, record);
    }

    function buildStandaloneJobDetailCacheRecord(root) {
        const detailId = extractJobIdFromHref(location.href);
        const recoverySourceId = resolveStandaloneRecoverySourceJobId(detailId);
        const id = recoverySourceId || detailId;
        const detailSnapshot = buildDetailSnapshotFromRoot(root, {}) || null;
        const title = normalizeSpace(detailSnapshot && detailSnapshot.title);
        const salaryText = normalizeSpace(detailSnapshot && detailSnapshot.salaryText);
        const company = normalizeSpace(detailSnapshot && detailSnapshot.company);
        const locationText = normalizeSpace(detailSnapshot && detailSnapshot.locationText);
        const tagTexts = normalizeCachedJobTagTexts(detailSnapshot && detailSnapshot.tagTexts);
        const detailHtml = buildCachedJobDetailHtmlFromSnapshot(detailSnapshot, {
            title,
            salaryText,
            company,
            locationText,
            tagTexts
        });
        if (!id || !detailHtml) return null;
        const securityId = extractSecurityIdFromHref(location.href)
            || extractSecurityIdFromHref(root.querySelector('a.more-job-btn[href*="securityId="], a[href*="/job_detail/"][href*="securityId="]')?.href || '');

        return {
            id,
            title,
            company,
            salaryText,
            locationText,
            tagTexts,
            href: location.href,
            securityId,
            detailHtml,
            detailSnapshot,
            detailJobId: id,
            detailSchemaVersion: DETAIL_CACHE_SCHEMA_VERSION
        };
    }

    function getCachedDetailCaptureSignature(record) {
        if (!record) return '';
        return [
            normalizeSpace(record.id),
            normalizeSpace(record.href),
            normalizeSpace(record.securityId),
            normalizeSpace(record.title),
            normalizeSpace(record.company),
            normalizeSpace(record.salaryText),
            normalizeSpace(record.locationText),
            JSON.stringify(normalizeCachedJobTagTexts(record.tagTexts)),
            JSON.stringify(normalizeCachedDetailSnapshot(record.detailSnapshot, record) || null),
            normalizeSpace(record.detailHtml),
            Number(record.detailSchemaVersion) || 0
        ].join('|');
    }

    function captureStandaloneJobDetail() {
        const root = findDetailRoot();
        if (!root) return false;

        const record = buildStandaloneJobDetailCacheRecord(root);
        if (!record) return false;

        const before = getCachedDetailCaptureSignature(state.jobCache.get(record.id));
        updateCachedJobRecordPreservingListOrder(record);
        const afterRecord = state.jobCache.get(record.id);
        const after = getCachedDetailCaptureSignature(afterRecord);
        if (!after || after === before) return false;
        saveJobCache();
        renderStandaloneDetailDebugPanel();
        return true;
    }

    function captureStandaloneJobDetailWhenReady() {
        let resolved = false;
        let observer = null;

        const stop = () => {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        };

        const tryCapture = () => {
            if (resolved) return true;
            renderStandaloneDetailDebugPanel();
            if (!captureStandaloneJobDetail()) return false;
            resolved = true;
            stop();
            return true;
        };

        if (tryCapture()) return;

        observer = new MutationObserver(() => {
            if (tryCapture()) return;
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        for (const delay of [400, 1200, 2600, 5000]) {
            window.setTimeout(() => {
                if (!resolved) tryCapture();
            }, delay);
        }

        window.setTimeout(stop, 12000);
    }

    function appendTagItems(list, values) {
        for (const value of normalizeCachedJobTagTexts(values)) {
            appendTextElement(list, 'li', '', value);
        }
    }

    function replaceElementText(element, text) {
        if (!element) return false;
        element.textContent = normalizeSpace(text);
        return true;
    }

    function ensureCacheTag(list) {
        if (!list) return null;

        const existing = Array.from(list.children || [])
            .find((element) => normalizeSpace(element.textContent) === '缓存');
        if (existing) {
            existing.classList.add(`${APP_ID}-cache-tag`);
            return existing;
        }

        return appendTextElement(list, list.matches('ul, ol') ? 'li' : 'span', `${APP_ID}-cache-tag`, '缓存');
    }

    function replaceTagList(list, values) {
        if (!list) return false;
        list.textContent = '';
        appendTagItems(list, values);
        ensureCacheTag(list);
        return true;
    }

    function ensureCachedTagList(card) {
        if (!card) return null;

        let list = card.querySelector('.tag-list, .job-tag-list, .job-card-tag-list, .job-card-tags, .job-tags');
        if (list) return list;

        const host = card.querySelector('.job-info, .job-title, .job-card-left, .job-card-body') || card;
        list = document.createElement('ul');
        list.className = 'tag-list';
        host.appendChild(list);
        return list;
    }

    function getNativeJobCardTemplate() {
        return getLiveJobCards()
            .filter((card) => !card.classList.contains(`${APP_ID}-ignored-job`) && !card.classList.contains(`${APP_ID}-filtered-job`))
            .find((card) => card.querySelector('.job-name') && card.querySelector('.salary, .job-salary, [class*="salary"]'))
            || getLiveJobCards().find((card) => card.querySelector('.job-name'))
            || null;
    }

    function stripCloneOnlyAttributes(root) {
        root.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        root.querySelectorAll('img').forEach((image) => {
            image.removeAttribute('srcset');
            image.alt = '';
        });
    }

    function cloneNativeJobCardTemplate() {
        const template = getNativeJobCardTemplate();
        if (!template) return null;

        const card = template.cloneNode(true);
        stripCloneOnlyAttributes(card);
        card.classList.remove('active', `${APP_ID}-ignored-job`, `${APP_ID}-filtered-job`);
        card.classList.add(`${APP_ID}-cached-card`);
        card.dataset.bzjtNativeTemplate = '1';
        return card;
    }

    function getNativeDetailClassName(root) {
        const classNames = Array.from(root?.classList || [])
            .filter((className) => className !== `${APP_ID}-cached-detail`
                && className !== `${APP_ID}-cached-detail-overlay`
                && !className.startsWith(`${APP_ID}-`));
        return classNames.join(' ');
    }

    function detailHtmlHasNativeHeader(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        return Boolean(template.content.querySelector('.job-detail-header, .job-name, h1'));
    }

    function getPlainTextFromHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        return normalizeSpace(template.content.textContent || '');
    }

    function cachedDetailContentMatchesRecord(record, detailHtml) {
        const html = normalizeSpace(detailHtml);
        if (!record || !html) return false;
        if ([
            `${APP_ID}-cached-detail`,
            `${APP_ID}-cache-tag`,
            `${APP_ID}-cached-meta`,
            `${APP_ID}-cached-detail-link`
        ].some((marker) => String(detailHtml).includes(marker))) return false;
        if (!detailHtmlHasNativeHeader(detailHtml)) return false;

        const id = normalizeSpace(record.id);
        const detailJobId = normalizeSpace(record.detailJobId);
        if (detailJobId && (!id || detailJobId !== id)) return false;

        const text = getPlainTextFromHtml(detailHtml);
        const title = normalizeSpace(record.title);
        const salary = normalizeSpace(record.salaryText);
        if (title) return text.includes(title);
        return Boolean(salary && text.includes(salary));
    }

    function cachedDetailHtmlMatchesRecord(record, detailHtml) {
        const schemaVersion = Number(record && record.detailSchemaVersion);
        if (!Number.isFinite(schemaVersion) || schemaVersion < DETAIL_CACHE_SCHEMA_VERSION) return false;
        return cachedDetailContentMatchesRecord(record, detailHtml);
    }

    function getTrustedCachedDetailHtml(record) {
        return cachedDetailHtmlMatchesRecord(record, record && record.detailHtml) ? record.detailHtml : '';
    }

    function cachedDetailSnapshotMatchesRecord(record, snapshot) {
        const normalized = normalizeCachedDetailSnapshot(snapshot, record);
        if (!record || !normalized) return false;

        const id = normalizeSpace(record.id);
        const detailJobId = normalizeSpace(record.detailJobId);
        if (detailJobId && (!id || detailJobId !== id)) return false;

        const title = normalizeSpace(record.title);
        const salary = normalizeSpace(record.salaryText);
        if (title && normalized.title && normalized.title !== title) return false;
        if (salary && normalized.salaryText && normalized.salaryText !== salary) return false;
        return Boolean(normalized.descriptionHtml || normalized.companyDescriptionHtml || normalized.addressText || normalized.recruiterName);
    }

    function cachedDetailContentMatchesRecord(record, detailHtml) {
        const html = normalizeSpace(detailHtml);
        if (!record || !html) return false;
        if ([
            `${APP_ID}-cached-detail`,
            `${APP_ID}-cache-tag`,
            `${APP_ID}-cached-meta`,
            `${APP_ID}-cached-detail-link`
        ].some((marker) => String(detailHtml).includes(marker))) return false;
        if (!detailHtmlHasNativeHeader(detailHtml)) return false;

        const snapshot = normalizeCachedDetailSnapshot(record.detailSnapshot, record);
        if (snapshot) {
            const rebuilt = buildCachedJobDetailHtmlFromSnapshot(snapshot, record);
            const rebuiltText = getPlainTextFromHtml(rebuilt);
            const currentText = getPlainTextFromHtml(detailHtml);
            if (rebuiltText && currentText && currentText.includes(snapshot.title || '') && currentText.includes(snapshot.company || '')) {
                return true;
            }
        }

        const id = normalizeSpace(record.id);
        const detailJobId = normalizeSpace(record.detailJobId);
        if (detailJobId && (!id || detailJobId !== id)) return false;

        const text = getPlainTextFromHtml(detailHtml);
        const title = normalizeSpace(record.title);
        const salary = normalizeSpace(record.salaryText);
        if (title) return text.includes(title);
        return Boolean(salary && text.includes(salary));
    }

    function cachedDetailHtmlMatchesRecord(record, detailHtml) {
        const schemaVersion = Number(record && record.detailSchemaVersion);
        if (!Number.isFinite(schemaVersion) || schemaVersion < DETAIL_CACHE_SCHEMA_VERSION) return false;
        return cachedDetailContentMatchesRecord(record, detailHtml)
            || cachedDetailSnapshotMatchesRecord(record, record && record.detailSnapshot);
    }

    function getTrustedCachedDetailHtml(record) {
        const snapshot = normalizeCachedDetailSnapshot(record && record.detailSnapshot, record);
        if (cachedDetailSnapshotMatchesRecord(record, snapshot)) {
            const rebuilt = buildCachedJobDetailHtmlFromSnapshot(snapshot, record);
            if (rebuilt) return rebuilt;
        }
        return cachedDetailHtmlMatchesRecord(record, record && record.detailHtml) ? record.detailHtml : '';
    }

    function getCachedDetailDescriptionSignature(detailHtml) {
        const template = document.createElement('template');
        template.innerHTML = String(detailHtml || '');
        const description = findDetailDescriptionSection(template.content) || template.content;
        return normalizeSpace(description.textContent).slice(0, 2400);
    }

    function isDuplicateDetailForDifferentCachedJob(id, detailHtml) {
        const signature = getCachedDetailDescriptionSignature(detailHtml);
        return Boolean(signature
            && state.lastCachedDetailSignature
            && state.lastCachedDetailId
            && state.lastCachedDetailId !== id
            && state.lastCachedDetailSignature === signature);
    }

    function rememberCachedDetailSignature(id, detailHtml) {
        const signature = getCachedDetailDescriptionSignature(detailHtml);
        if (!signature) return;
        state.lastCachedDetailId = id;
        state.lastCachedDetailSignature = signature;
    }

    function findDetailDescriptionSection(root) {
        if (!root) return null;

        const sections = Array.from(root.querySelectorAll('.job-detail-section, .job-sec, .detail-section, [class*="job-sec"]'));
        return sections.find((section) => normalizeSpace(section.textContent).includes('职位描述'))
            || sections[0]
            || null;
    }

    function appendCachedDetailRecoveryLink(section, record, contentHtml = '') {
        const href = getCachedJobRecoveryHref(record);
        if (!href) return;
        if (!contentHtml) {
            appendTextElement(section, 'div', `${APP_ID}-cached-detail-hint`, '可先打开原职位页面查看；页面加载出职位详情后，脚本会自动缓存，下次可直接在右侧显示。');
        }
        const link = appendTextElement(section, 'a', `${APP_ID}-cached-detail-link`, '打开原职位页面');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.addEventListener('click', () => {
            rememberDetailRecoverySource(record);
        }, { capture: true });
    }

    function createCachedDetailDescriptionSection(record, message = '', contentHtml = '') {
        const section = document.createElement('div');
        section.className = 'job-detail-section';
        if (contentHtml) {
            section.innerHTML = sanitizeCachedDetailHtml(contentHtml);
            return section;
        }

        appendTextElement(section, 'h3', '', '职位描述');
        appendTextElement(section, 'div', 'text', message || '正在加载缓存职位详情...');
        appendCachedDetailRecoveryLink(section, record, contentHtml);
        return section;
    }

    function removeStaleCachedDetailSections(root) {
        if (!root) return;

        const sections = new Set();
        const header = root.querySelector('.job-detail-header, .job-name, h1');
        const headerContainer = header?.closest('.job-detail-header') || header;
        if (headerContainer) {
            for (let sibling = headerContainer.nextElementSibling; sibling; ) {
                const next = sibling.nextElementSibling;
                sections.add(sibling);
                sibling = next;
            }

            for (const child of Array.from(root.children || [])) {
                if (child === headerContainer || child.contains(headerContainer)) continue;
                sections.add(child);
            }
        }

        const descriptionSection = findDetailDescriptionSection(root);
        if (descriptionSection) sections.add(descriptionSection);

        root.querySelectorAll([
            '.job-detail-section',
            '.job-sec',
            '.detail-section',
            '.job-detail-company',
            '.job-address',
            '.job-detail-address',
            '[class*="job-sec"]',
            '[class*="job-desc"]',
            '[class*="detail-desc"]',
            '[class*="address"]',
            '[class*="boss-info"]',
            '[class*="recruiter"]'
        ].join(',')).forEach((section) => {
            if (!section.closest('.job-detail-header')) sections.add(section);
        });

        root.querySelectorAll('div, section, article').forEach((section) => {
            if (section === root || section.closest('.job-detail-header') || section.querySelector('.job-detail-header')) return;
            const text = normalizeSpace(section.textContent);
            if (/职位描述|岗位职责|岗位要求|任职要求|工作地址|求职工具|升级VIP/.test(text)) sections.add(section);
        });

        for (const section of sections) {
            section.remove();
        }
    }

    function appendCachedDetailDescription(root, record, message = '', contentHtml = '') {
        const section = createCachedDetailDescriptionSection(record, message, contentHtml);
        root.appendChild(section);
        return section;
    }

    function replaceCachedDetailDescription(root, record, message = '', contentHtml = '') {
        removeStaleCachedDetailSections(root);
        appendCachedDetailDescription(root, record, message, contentHtml);
    }

    function buildCachedJobDetailNativeShell(record, message = '', root = null, contentHtml = '') {
        if (!(root instanceof Element)) return null;

        const clone = root.cloneNode(true);
        clone.classList.remove(`${APP_ID}-cached-detail`);
        clone.classList.add(`${APP_ID}-cached-detail-fallback`);
        clone.querySelectorAll(`.${APP_ID}-cached-detail-overlay`).forEach((element) => element.remove());
        clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        replaceElementText(clone.querySelector('.job-detail-header .job-name, .job-detail-header h1, h1, .job-name'), record.title || '缓存职位');
        replaceElementText(clone.querySelector('.job-detail-header .salary, .job-detail-header .job-salary, .salary, .job-salary, [class*="salary"]'), record.salaryText);
        replaceCachedDetailDescription(clone, record, message, contentHtml);
        return clone;
    }

    function buildCachedJobDetailFallback(record, message = '', root = null, contentHtml = '') {
        const nativeShell = buildCachedJobDetailNativeShell(record, message, root, contentHtml);
        if (nativeShell) return nativeShell.outerHTML;

        const wrapper = document.createElement('div');
        wrapper.className = normalizeSpace(`${APP_ID}-cached-detail-fallback ${getNativeDetailClassName(root)}`);

        const header = appendTextElement(wrapper, 'div', 'job-detail-header', '');
        const title = appendTextElement(header, 'div', 'job-name', record.title || '缓存职位');
        title.setAttribute('title', record.title || '缓存职位');
        if (record.salaryText) appendTextElement(header, 'span', 'salary', record.salaryText);

        const info = appendTextElement(wrapper, 'div', 'job-info', '');
        const tags = appendTextElement(info, 'ul', 'tag-list', '');
        appendTagItems(tags, record.tagTexts);
        appendTextElement(tags, 'li', `${APP_ID}-cache-tag`, '缓存');
        appendTextElement(info, 'span', `${APP_ID}-cached-meta`, formatCachedJobAge(record.lastSeenAt));

        const company = appendTextElement(wrapper, 'div', 'job-detail-company', '');
        if (record.company) appendTextElement(company, 'span', 'company-name', record.company);
        if (record.locationText) appendTextElement(company, 'span', 'job-area', record.locationText);

        const section = appendTextElement(wrapper, 'div', 'job-detail-section', '');
        appendTextElement(section, 'h3', '', '职位描述');
        const content = appendTextElement(section, 'div', 'text', '');
        if (contentHtml) {
            content.innerHTML = sanitizeCachedDetailHtml(contentHtml);
        } else {
            content.textContent = message || '正在加载缓存职位详情...';
        }

        const href = getCachedJobHref(record);
        if (href) {
            if (!contentHtml) {
                appendTextElement(section, 'div', `${APP_ID}-cached-detail-hint`, '可先打开真实职位链接查看；页面加载出职位详情后，脚本会自动缓存，下次可直接在右侧显示。');
            }
            const link = appendTextElement(section, 'a', `${APP_ID}-cached-detail-link`, '打开原职位页面');
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }

        return wrapper.innerHTML;
    }

    function buildCachedJobDetailHtmlFromApiData(data) {
        const jobInfo = data && data.zpData && data.zpData.jobInfo;
        const brandComInfo = data && data.zpData && data.zpData.brandComInfo;
        const description = String(jobInfo && jobInfo.postDescription || '').trim();
        const skills = normalizeCachedJobTagTexts(jobInfo && jobInfo.showSkills);
        const welfare = normalizeCachedJobTagTexts(brandComInfo && brandComInfo.labels);
        if (!description && !skills.length && !welfare.length) return '';

        const wrapper = document.createElement('div');
        wrapper.className = `${APP_ID}-api-detail`;
        const fragment = document.createDocumentFragment();

        if (description) {
            const section = document.createElement('section');
            section.className = `${APP_ID}-api-detail-section`;
            appendTextElement(section, 'h3', `${APP_ID}-api-detail-title`, '职位描述');
            const content = document.createElement('div');
            content.className = `${APP_ID}-api-detail-content`;
            description.split(/\r?\n+/).map(normalizeSpace).filter(Boolean).forEach((line) => {
                appendTextElement(content, 'p', '', line);
            });
            section.appendChild(content);
            fragment.appendChild(section);
        }

        if (skills.length) {
            const section = document.createElement('section');
            section.className = `${APP_ID}-api-detail-section`;
            appendTextElement(section, 'h3', `${APP_ID}-api-detail-title`, '技能要求');
            const list = document.createElement('ul');
            list.className = 'tag-list';
            appendTagItems(list, skills);
            section.appendChild(list);
            fragment.appendChild(section);
        }

        if (welfare.length) {
            const section = document.createElement('section');
            section.className = `${APP_ID}-api-detail-section`;
            appendTextElement(section, 'h3', `${APP_ID}-api-detail-title`, '职位亮点');
            const list = document.createElement('ul');
            list.className = 'tag-list';
            appendTagItems(list, welfare);
            section.appendChild(list);
            fragment.appendChild(section);
        }

        wrapper.appendChild(fragment);
        return sanitizeCachedDetailHtml(wrapper.innerHTML);
    }

    async function fetchCachedJobDetailHtmlViaApi(record) {
        const securityId = ensureRecordSecurityId(record) || extractSecurityIdFromHref(getCachedJobHref(record));
        if (!securityId) return '';

        const apiUrl = new URL('/wapi/zpgeek/job/detail.json', location.origin);
        apiUrl.searchParams.set('securityId', securityId);

        const response = await fetch(apiUrl.toString(), {
            credentials: 'include',
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (/security-check\.html/i.test(String(response.url || ''))) throw new Error('security check redirect');

        const data = await response.json();
        if (!data || typeof data !== 'object') throw new Error('invalid boss detail response');
        if (Number(data.code) !== 0) {
            throw new Error(normalizeSpace(data.message) || `boss api ${data.code}`);
        }

        const detailHtml = buildCachedJobDetailHtmlFromApiData(data);
        return cachedDetailContentMatchesRecord(record, detailHtml) ? detailHtml : '';
    }

    async function fetchCachedJobDetailHtml(record, options = {}) {
        const trustedDetailHtml = getTrustedCachedDetailHtml(record);
        if (!options.forceNetwork && trustedDetailHtml) return trustedDetailHtml;

        let apiError = null;
        try {
            const apiDetailHtml = await fetchCachedJobDetailHtmlViaApi(record);
            if (apiDetailHtml) return apiDetailHtml;
        } catch (error) {
            apiError = error;
            if (/security check redirect/i.test(String(error && error.message || error))) throw error;
        }

        const href = getCachedJobHref(record);
        if (!href) {
            if (apiError) throw apiError;
            return '';
        }

        const response = await fetch(href, {
            credentials: 'include',
            cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (/security-check\.html/i.test(String(response.url || ''))) throw new Error('security check redirect');

        const text = await response.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const detailRoot = findDetailRootInDocument(doc);
        const detailHtml = detailRoot ? sanitizeCachedDetailHtml(detailRoot.innerHTML) : '';
        return cachedDetailContentMatchesRecord(record, detailHtml) ? detailHtml : '';
    }

    function setCachedJobActive(id) {
        const targetId = normalizeSpace(id);
        for (const card of getJobCards()) {
            card.classList.toggle('active', Boolean(targetId && getJobIdFromCard(card) === targetId));
        }
    }

    function getCachedDetailOverlay(root) {
        let overlay = root.querySelector(`:scope > .${APP_ID}-cached-detail-overlay`);
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = `${APP_ID}-cached-detail-overlay`;
            root.appendChild(overlay);
        }
        return overlay;
    }

    function syncCachedDetailOverlayClass(root, overlay) {
        if (!root || !overlay) return;

        const inheritedClasses = Array.from(root.classList || [])
            .filter((className) => className !== `${APP_ID}-cached-detail`);
        overlay.className = [`${APP_ID}-cached-detail-overlay`, ...inheritedClasses].join(' ');
    }

    function clearCachedJobDetail() {
        state.currentCachedDetailId = '';
        for (const root of Array.from(document.querySelectorAll(`.${APP_ID}-cached-detail`))) {
            root.querySelector(`:scope > .${APP_ID}-cached-detail-overlay`)?.remove();
            root.classList.remove(`${APP_ID}-cached-detail`);
        }

        for (const card of getJobCards().filter(isCachedJobCard)) {
            card.classList.remove('active');
        }
    }

    function handleLiveJobCardClick(event) {
        const card = event.target instanceof Element ? event.target.closest('.job-card-wrap') : null;
        if (!card || isCachedJobCard(card)) return;
        clearCachedJobDetail();
    }

    function renderCachedJobDetail(record, detailHtml, message = '') {
        const root = findDetailRoot();
        if (!root) {
            showToast('没有找到右侧职位详情区');
            return false;
        }

        root.classList.add(`${APP_ID}-cached-detail`);
        const overlay = getCachedDetailOverlay(root);
        syncCachedDetailOverlayClass(root, overlay);
        const nativeSnapshotHtml = buildCachedJobDetailHtmlFromJobsRightShellSnapshot(record && record.detailSnapshot, record, root)
            || buildCachedJobDetailHtmlFromNativeShellSnapshot(record && record.detailSnapshot, record, root);
        overlay.innerHTML = nativeSnapshotHtml
            || (detailHtml && detailHtmlHasNativeHeader(detailHtml)
                ? sanitizeCachedDetailHtml(detailHtml)
                : buildCachedJobDetailFallback(record, message, root, detailHtml));
        ensureIgnoreButton();
        renderDetailCustomTags();
        return true;
    }

    async function showCachedJobDetail(record) {
        const id = normalizeSpace(record && record.id);
        if (!id) return;

        syncJobCacheFromStorage();
        const latestRecord = state.jobCache.get(id) || record;
        state.currentCachedDetailId = id;
        setCachedJobActive(id);
        let trustedDetailHtml = getTrustedCachedDetailHtml(latestRecord);
        if (trustedDetailHtml && isDuplicateDetailForDifferentCachedJob(id, trustedDetailHtml)) {
            trustedDetailHtml = '';
        }
        renderCachedJobDetail(latestRecord, trustedDetailHtml, trustedDetailHtml ? '' : '正在加载缓存职位详情...');
        if (trustedDetailHtml) rememberCachedDetailSignature(id, trustedDetailHtml);

        try {
            const detailHtml = await fetchCachedJobDetailHtml(latestRecord, { forceNetwork: true });
            if (!detailHtml) throw new Error('detail not found');
            if (state.currentCachedDetailId !== id) return;
            if (isDuplicateDetailForDifferentCachedJob(id, detailHtml)) throw new Error('duplicate stale detail');

            const currentRecord = state.jobCache.get(id) || latestRecord;
            state.jobCache.set(id, {
                ...currentRecord,
                detailHtml,
                detailJobId: id,
                detailSchemaVersion: DETAIL_CACHE_SCHEMA_VERSION,
                detailFetchedAt: Date.now()
            });
            saveJobCache();
            renderCachedJobDetail(state.jobCache.get(id), detailHtml);
            rememberCachedDetailSignature(id, detailHtml);
        } catch (error) {
            if (state.currentCachedDetailId === id && !trustedDetailHtml) {
                renderCachedJobDetail(latestRecord, '', '缓存中没有完整职位详情，且原职位详情暂时无法加载。');
            }
        }
    }

    function renderFallbackCachedJobCard(card, record) {
        card.textContent = '';

        const body = appendTextElement(card, 'div', 'job-card-body clearfix', '');
        const left = appendTextElement(body, 'a', 'job-card-left', '');
        left.href = getCachedJobHref(record);

        const titleRow = appendTextElement(left, 'div', 'job-title clearfix', '');
        appendTextElement(titleRow, 'span', 'job-name', record.title || '缓存职位');
        if (record.locationText) {
            const areaWrapper = appendTextElement(titleRow, 'span', 'job-area-wrapper', '');
            appendTextElement(areaWrapper, 'span', 'job-area', record.locationText);
        }

        const info = appendTextElement(left, 'div', 'job-info clearfix', '');
        if (record.salaryText) appendTextElement(info, 'span', 'salary', record.salaryText);
        const tags = appendTextElement(info, 'ul', 'tag-list', '');
        replaceTagList(tags, record.tagTexts);

        const right = appendTextElement(body, 'div', 'job-card-right', '');
        const companyInfo = appendTextElement(right, 'div', 'company-info', '');
        const companyName = appendTextElement(companyInfo, 'h3', 'company-name', '');
        appendTextElement(companyName, 'span', '', record.company || '公司信息已缓存');
        const meta = appendTextElement(companyInfo, 'ul', 'company-tag-list', '');
        appendTextElement(meta, 'li', `${APP_ID}-cached-meta`, formatCachedJobAge(record.lastSeenAt));
        if (record.activeTimeText) appendTextElement(meta, 'li', `${APP_ID}-active-badge`, record.activeTimeText);
    }

    function updateCachedCardLogo(card, record) {
        const image = card.querySelector([
            '.company-logo img',
            '.company-img img',
            '.company-info img',
            '.boss-avatar img',
            '.job-card-right img',
            'img'
        ].join(','));
        if (!image) return false;

        const logoSrc = normalizeSpace(record && record.logoSrc);
        const logoHost = image.closest('.company-logo, .company-img, .boss-avatar') || image.parentElement;
        let placeholder = logoHost?.querySelector(`.${APP_ID}-logo-placeholder`);
        image.removeAttribute('srcset');
        image.alt = normalizeSpace(record && record.company) || '公司 logo';
        if (logoSrc) {
            placeholder?.remove();
            image.src = logoSrc;
            image.setAttribute('data-src', logoSrc);
            image.style.removeProperty('display');
            image.style.removeProperty('visibility');
            logoHost?.classList.remove(`${APP_ID}-empty-logo`);
            return true;
        }

        image.removeAttribute('src');
        image.removeAttribute('data-src');
        image.style.display = 'none';
        if (logoHost) {
            if (!placeholder) {
                placeholder = document.createElement('span');
                placeholder.className = `${APP_ID}-logo-placeholder`;
                placeholder.setAttribute('aria-hidden', 'true');
                logoHost.appendChild(placeholder);
            }
            placeholder.textContent = '';
            placeholder.dataset.initial = normalizeSpace(record && record.company).slice(0, 1) || '缓';
            logoHost.classList.add(`${APP_ID}-empty-logo`);
        }
        return false;
    }

    function ensureCachedCardTemplate(card) {
        if (card.dataset.bzjtNativeTemplate === '1') return;

        const nativeCard = cloneNativeJobCardTemplate();
        if (!nativeCard) return;

        card.className = nativeCard.className;
        card.innerHTML = nativeCard.innerHTML;
        card.dataset.bzjtNativeTemplate = '1';
    }

    function updateNativeCachedJobCard(card, record) {
        const href = getCachedJobHref(record);
        card.querySelectorAll('a[href]').forEach((anchor) => {
            anchor.href = href;
            anchor.removeAttribute('target');
            anchor.removeAttribute('rel');
        });

        replaceElementText(card.querySelector('.job-name'), record.title || '缓存职位');
        replaceElementText(card.querySelector('.salary, .job-salary, [class*="salary"]'), record.salaryText);

        const tagList = ensureCachedTagList(card);
        replaceTagList(tagList, record.tagTexts);

        const companyElement = card.querySelector('.boss-name, .company-name span, .company-name, [class*="company-name"]');
        replaceElementText(companyElement, record.company || '公司信息已缓存');
        updateCachedCardLogo(card, record);

        const locationElement = card.querySelector('.job-area, .job-location, .company-location, [class*="job-area"], [class*="location"]');
        replaceElementText(locationElement, record.locationText);

        const metaHost = card.querySelector('.company-tag-list, .job-card-footer, .job-info') || card;
        metaHost.querySelectorAll(`.${APP_ID}-cached-meta, .${APP_ID}-active-badge`).forEach((element) => element.remove());
        const metaTagName = metaHost.matches('ul, ol') ? 'li' : 'span';
        appendTextElement(metaHost, metaTagName, `${APP_ID}-cached-meta`, formatCachedJobAge(record.lastSeenAt));
        if (record.activeTimeText) appendTextElement(metaHost, metaTagName, `${APP_ID}-active-badge`, record.activeTimeText);
    }

    function updateCachedJobCard(card, record) {
        const signature = JSON.stringify({ render: 'native-card-v1', record });
        if (card.dataset.cacheSignature === signature) return;

        ensureCachedCardTemplate(card);
        card.dataset.bzjtCachedId = record.id;
        card.dataset.cacheSignature = signature;

        if (card.dataset.bzjtNativeTemplate === '1') {
            updateNativeCachedJobCard(card, record);
        } else {
            renderFallbackCachedJobCard(card, record);
        }
    }

    function createCachedJobCard(record) {
        const card = cloneNativeJobCardTemplate() || document.createElement('div');
        if (!card.classList.contains(`${APP_ID}-cached-card`)) {
            card.className = `job-card-wrap ${APP_ID}-cached-card`;
        }
        card.addEventListener('click', (event) => {
            if (event.target instanceof Element && event.target.closest('button')) return;
            event.preventDefault();
            event.stopPropagation();
            const latestRecord = state.jobCache.get(card.dataset.bzjtCachedId) || record;
            void showCachedJobDetail(latestRecord);
        });
        updateCachedJobCard(card, record);
        return card;
    }

    function makeCacheableJobRecordFromCard(card) {
        if (!card || isCachedJobCard(card)) return null;

        const id = getJobIdFromCard(card);
        if (!id) return null;

        const jobData = getCardJobData(card);
        const cachedActiveTime = state.activeTimeCache.get(id);
        const activeTimeText = getCardActiveTimeText(card) || cachedActiveTime?.text || '';
        const activeRank = activeTimeText ? parseBossActiveTimeRank(activeTimeText) : cachedActiveTime?.rank;
        const detailHtml = getCurrentDetailHtmlForCard(card);
        const detailSnapshot = getCurrentDetailSnapshotForCard(card);
        const securityId = getJobDataSecurityId(jobData) || getCurrentDetailSecurityIdForCard(card);
        return {
            id,
            title: getCardTitle(card),
            company: getCardCompany(card),
            salaryText: getCardSalaryText(card),
            keywordText: getCardFilterKeywordText(card),
            logoSrc: getCardLogoSrc(card),
            tagTexts: getCardTagTexts(card),
            locationText: getCardLocationText(card),
            href: getJobHrefFromCard(card),
            securityId,
            detailHtml,
            ...(detailSnapshot ? { detailSnapshot } : {}),
            ...(detailHtml ? { detailJobId: id } : {}),
            ...((detailHtml || detailSnapshot) ? { detailSchemaVersion: DETAIL_CACHE_SCHEMA_VERSION } : {}),
            activeTimeText,
            ...(Number.isFinite(activeRank) ? { activeRank } : {})
        };
    }

    function getJobCacheSignature(records) {
        return JSON.stringify((Array.isArray(records) ? records : []).map((record) => [
            record.id,
            record.schemaVersion || '',
            record.title || '',
            record.company || '',
            record.salaryText || '',
            record.keywordText || '',
            record.logoSrc || '',
            JSON.stringify(record.tagTexts || []),
            record.locationText || '',
            record.expectationText || '',
            record.href || '',
            record.securityId || '',
            JSON.stringify(record.detailSnapshot || null),
            record.detailHtml || '',
            record.detailJobId || '',
            Number.isFinite(record.detailSchemaVersion) ? record.detailSchemaVersion : '',
            record.activeTimeText || '',
            Number.isFinite(record.activeRank) ? record.activeRank : ''
        ]));
    }

    function cacheCurrentMatchingJobs() {
        const now = Date.now();
        const before = JSON.stringify(serializeRecordMap(state.jobCache));
        state.jobCache = normalizeCachedJobRecords(state.jobCache, {
            ...state.jobCacheSettings,
            now,
            requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION
        });
        if (!hasActiveJobExpectation()) {
            const after = JSON.stringify(serializeRecordMap(state.jobCache));
            if (after !== before) saveJobCache();
            state.lastCacheSignature = '';
            return;
        }

        const activeExpectationText = getActiveJobExpectationText();
        const records = getLiveJobCards()
            .filter((card) => {
                const id = getJobIdFromCard(card);
                return Boolean(id && !state.ignoredJobs.has(id) && !isCardHiddenByFilters(card));
            })
            .map(makeCacheableJobRecordFromCard)
            .filter(Boolean)
            .map((record) => ({
                ...record,
                schemaVersion: JOB_CACHE_SCHEMA_VERSION,
                expectationText: activeExpectationText
            }));
        const signature = getJobCacheSignature(records);

        if (records.length && signature !== state.lastCacheSignature) {
            state.jobCache = mergeCachedJobRecords(state.jobCache, records, {
                ...state.jobCacheSettings,
                now,
                requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION
            });
            state.lastCacheSignature = signature;
        }

        const after = JSON.stringify(serializeRecordMap(state.jobCache));
        if (after !== before) saveJobCache();
    }

    function clearDetailPrefetchTimer() {
        if (!state.detailPrefetchTimer) return;
        window.clearTimeout(state.detailPrefetchTimer);
        state.detailPrefetchTimer = null;
    }

    function getPendingDetailPrefetchCards() {
        if (!hasActiveJobExpectation()) return [];
        const activeExpectationText = getActiveJobExpectationText();
        if (!activeExpectationText) return [];

        return getLiveJobCards()
            .filter((card) => {
                const id = getJobIdFromCard(card);
                if (!id || state.ignoredJobs.has(id) || isCardHiddenByFilters(card)) return false;
                const record = state.jobCache.get(id);
                return Boolean(record
                    && record.schemaVersion === JOB_CACHE_SCHEMA_VERSION
                    && record.expectationText === activeExpectationText
                    && !getTrustedCachedDetailHtml(record));
            });
    }

    function getDetailPrefetchSignature(cards) {
        return JSON.stringify((Array.isArray(cards) ? cards : [])
            .map((card) => normalizeSpace(getJobIdFromCard(card)))
            .filter(Boolean));
    }

    function updateCachedJobDetailRecord(id, detailHtml) {
        const targetId = normalizeSpace(id);
        const trustedDetailHtml = normalizeSpace(detailHtml);
        if (!targetId || !trustedDetailHtml) return false;

        const existing = state.jobCache.get(targetId);
        if (!existing) return false;
        if (existing.detailHtml === trustedDetailHtml && Number(existing.detailSchemaVersion) === DETAIL_CACHE_SCHEMA_VERSION) return false;

        state.jobCache.set(targetId, {
            ...existing,
            detailHtml: trustedDetailHtml,
            detailJobId: targetId,
            detailSchemaVersion: DETAIL_CACHE_SCHEMA_VERSION,
            detailFetchedAt: Date.now()
        });
        return true;
    }

    async function captureLiveJobDetailForCard(card) {
        const id = normalizeSpace(getJobIdFromCard(card));
        if (!id) return '';

        const activeId = normalizeSpace(getJobIdFromCard(getCurrentJobCard()));
        if (activeId !== id) {
            const activated = await activateJobCard(card);
            if (!activated) return '';
        }

        for (let attempt = 0; attempt < 8; attempt += 1) {
            await sleep(attempt === 0 ? 140 : DETAIL_PREFETCH_STEP_DELAY_MS);
            const record = makeCacheableJobRecordFromCard(card);
            const detailHtml = normalizeSpace(record && record.detailHtml);
            if (detailHtml) return detailHtml;
        }

        return '';
    }

    async function prefetchMissingJobDetailsFromLiveCards() {
        if (state.detailPrefetchRunning || state.scanning || state.currentCachedDetailId) return;

        const cards = getPendingDetailPrefetchCards();
        if (!cards.length) {
            state.detailPrefetchSignature = '';
            return;
        }

        state.detailPrefetchRunning = true;
        const originalActiveId = normalizeSpace(getJobIdFromCard(getCurrentJobCard()));
        const targetCards = cards.slice(0, DETAIL_PREFETCH_MAX_PER_PASS);
        let changed = false;

        try {
            for (let index = 0; index < targetCards.length; index += 1) {
                if (state.currentCachedDetailId) break;
                const card = targetCards[index];
                const id = normalizeSpace(getJobIdFromCard(card));
                if (!id) continue;

                updateToolbarStatus(`预抓职位描述 ${index + 1}/${targetCards.length}`);
                const detailHtml = await captureLiveJobDetailForCard(card);
                if (detailHtml) {
                    changed = updateCachedJobDetailRecord(id, detailHtml) || changed;
                }
            }
        } finally {
            if (originalActiveId && !state.currentCachedDetailId) {
                const originalCard = findJobCardById(originalActiveId);
                if (originalCard && !isCachedJobCard(originalCard)) {
                    await activateJobCard(originalCard).catch(() => {});
                }
            }

            state.detailPrefetchRunning = false;
            if (changed) {
                saveJobCache();
                renderCachedJobCards({ allowDuringScroll: true });
            }
            updateToolbarStatus('');
        }
    }

    function scheduleDetailPrefetch() {
        clearDetailPrefetchTimer();
        const cards = getPendingDetailPrefetchCards();
        const signature = getDetailPrefetchSignature(cards);
        if (!signature) {
            state.detailPrefetchSignature = '';
            return;
        }
        if (signature === state.detailPrefetchSignature) return;
        state.detailPrefetchSignature = signature;
        state.detailPrefetchTimer = window.setTimeout(() => {
            state.detailPrefetchTimer = null;
            void prefetchMissingJobDetailsFromLiveCards();
        }, DETAIL_PREFETCH_IDLE_MS);
    }

    function getCachedJobRecordsForRender() {
        const activeExpectationText = getActiveJobExpectationText();
        if (!activeExpectationText) return [];

        const liveIds = new Set(getLiveJobCards().map(getJobIdFromCard).filter(Boolean));
        return Array.from(state.jobCache.values())
            .filter((record) => {
                const filterRecord = {
                    ...record,
                    keywordText: normalizeSpace([
                        record.keywordText,
                        getCustomTagTextForJob(record.id)
                    ].filter(Boolean).join(' '))
                };
                return record.id
                    && record.schemaVersion === JOB_CACHE_SCHEMA_VERSION
                    && record.expectationText === activeExpectationText
                    && !liveIds.has(record.id)
                    && !state.ignoredJobs.has(record.id)
                    && !jobMatchesHiddenFilters(filterRecord, state.hiddenFilters);
            })
            .sort((left, right) => (Number(right.lastSeenAt) || 0) - (Number(left.lastSeenAt) || 0));
    }

    function markJobListUserScroll() {
        state.lastJobListUserScrollAt = Date.now();
    }

    function handleJobListScrollKey(event) {
        if (!event || event.defaultPrevented) return;
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
            markJobListUserScroll();
        }
    }

    function scheduleCachedJobRenderAfterScroll(deferMs) {
        const delayMs = Math.max(50, Math.ceil(Number(deferMs) || 0) + 50);
        if (state.cachedRenderTimer) window.clearTimeout(state.cachedRenderTimer);

        state.cachedRenderTimer = window.setTimeout(() => {
            state.cachedRenderTimer = null;
            renderCachedJobCards();
        }, delayMs);
    }

    function clearCachedJobRenderTimer() {
        if (!state.cachedRenderTimer) return;
        window.clearTimeout(state.cachedRenderTimer);
        state.cachedRenderTimer = null;
    }

    function clearJobCaches() {
        const activeTimeCount = state.activeTimeCache.size;
        const jobCacheCount = state.jobCache.size;
        if (!activeTimeCount && !jobCacheCount) {
            showToast('\u5f53\u524d\u6ca1\u6709\u53ef\u6e05\u9664\u7684\u7f13\u5b58');
            return;
        }

        state.activeTimeCache = new Map();
        state.jobCache = new Map();
        state.lastCacheSignature = '';
        state.detailPrefetchSignature = '';
        clearCachedJobRenderTimer();
        clearDetailPrefetchTimer();
        clearCachedJobDetail();
        saveActiveTimeCache();
        saveJobCache();

        for (const card of getJobCards()) {
            renderCardActiveBadge(card, getCardActiveTimeText(card));
        }
        renderCachedJobCards({ allowDuringScroll: true });
        updateToolbarStatus('');
        showToast(`\u5df2\u6e05\u9664 ${jobCacheCount} \u6761\u804c\u4f4d\u7f13\u5b58\u548c ${activeTimeCount} \u6761\u6d3b\u8dc3\u7f13\u5b58`);
    }

    function renderCachedJobCards(options = {}) {
        const deferMs = options.allowDuringScroll
            ? 0
            : getCachedRenderDeferDelay({
                lastUserScrollAt: state.lastJobListUserScrollAt,
                now: Date.now(),
                idleMs: USER_SCROLL_RENDER_DEFER_MS
            });
        if (deferMs > 0) {
            scheduleCachedJobRenderAfterScroll(deferMs);
            return;
        }
        clearCachedJobRenderTimer();

        const parent = getJobListParent();
        if (!parent) return;

        const desiredRecords = getCachedJobRecordsForRender();
        const desiredIds = new Set(desiredRecords.map((record) => record.id));
        const existingCards = new Map(
            Array.from(parent.querySelectorAll(`.${APP_ID}-cached-card`))
                .map((card) => [getJobIdFromCard(card), card])
                .filter(([id]) => id)
        );

        for (const [id, card] of existingCards.entries()) {
            if (!desiredIds.has(id)) card.remove();
        }

        const desiredCards = desiredRecords.map((record) => {
            const card = existingCards.get(record.id) || createCachedJobCard(record);
            updateCachedJobCard(card, record);
            return card;
        });

        const currentCards = Array.from(parent.querySelectorAll(`.${APP_ID}-cached-card`))
            .filter((card) => desiredIds.has(getJobIdFromCard(card)));
        const alreadyOrdered = currentCards.length === desiredCards.length
            && currentCards.every((card, index) => card === desiredCards[index]);
        if (!alreadyOrdered) {
            for (const card of desiredCards) parent.appendChild(card);
        }
        syncCachedJobScrollLayout(parent, desiredCards);
    }

    function getCachedJobScrollHost(parent) {
        if (!parent) return null;

        const candidates = [
            parent.closest('.job-list-container'),
            parent.closest('.job-list-box'),
            parent.closest('.job-list-wrapper'),
            parent.closest('.job-list'),
            parent.parentElement,
            parent
        ].filter(Boolean);
        const uniqueCandidates = candidates.filter((element, index, elements) => elements.indexOf(element) === index);

        return uniqueCandidates.find((element) => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            return element.clientHeight > 0
                && (element.scrollHeight > element.clientHeight + 4 || style.overflowY !== 'visible');
        }) || uniqueCandidates.find((element) => element instanceof HTMLElement && element.clientHeight > 0) || parent;
    }

    function syncCachedJobScrollLayout(parent, cachedCards) {
        const cards = Array.isArray(cachedCards) ? cachedCards.filter(Boolean) : [];
        const scrollHost = cards.length ? getCachedJobScrollHost(parent) : null;

        for (const element of Array.from(document.querySelectorAll(`.${APP_ID}-cached-list-host`))) {
            if (element !== parent) element.classList.remove(`${APP_ID}-cached-list-host`);
        }
        for (const element of Array.from(document.querySelectorAll(`.${APP_ID}-cached-scroll-host`))) {
            if (element !== scrollHost) {
                element.classList.remove(`${APP_ID}-cached-scroll-host`);
                element.style.removeProperty('--bzjt-cache-extra-height');
            }
        }

        if (!parent || !cards.length) {
            parent?.classList.remove(`${APP_ID}-cached-list-host`);
            return;
        }

        parent.classList.add(`${APP_ID}-cached-list-host`);
        if (scrollHost) {
            scrollHost.classList.add(`${APP_ID}-cached-scroll-host`);
            const cachedHeight = cards.reduce((total, card) => {
                const rect = card.getBoundingClientRect();
                return total + (rect.height || card.offsetHeight || 0);
            }, 0);
            scrollHost.style.setProperty('--bzjt-cache-extra-height', `${Math.ceil(cachedHeight)}px`);
        }
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
                <button type="button" class="${APP_ID}-clear-cache-btn">\u6e05\u9664\u7f13\u5b58</button>
                <span class="${APP_ID}-status"></span>
                <span class="${APP_ID}-version">v${SCRIPT_VERSION}</span>
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
                    <label class="${APP_ID}-settings-field">
                        <span>缓存保留天数</span>
                        <input class="${APP_ID}-cache-ttl-input" type="number" min="${MIN_JOB_CACHE_TTL_DAYS}" max="${MAX_JOB_CACHE_TTL_DAYS}" step="1">
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
            toolbar.querySelector(`.${APP_ID}-clear-cache-btn`).addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!window.confirm('\u786e\u8ba4\u6e05\u9664\u804c\u4f4d\u7f13\u5b58\u548c\u6d3b\u8dc3\u65f6\u95f4\u7f13\u5b58\u5417\uff1f')) return;
                clearJobCaches();
            });

            const panel = toolbar.querySelector(`.${APP_ID}-settings-panel`);
            panel.addEventListener('click', (event) => event.stopPropagation());
            panel.querySelector(`.${APP_ID}-keyword-input`).addEventListener('input', () => {
                commitSettingsFromPanel(panel);
            });
            panel.querySelector(`.${APP_ID}-salary-range`).addEventListener('input', () => {
                commitSettingsFromPanel(panel);
            });
            panel.querySelector(`.${APP_ID}-cache-ttl-input`).addEventListener('input', () => {
                commitSettingsFromPanel(panel);
            });
        }
        syncToolbarButtonStyle(toolbar, anchor);
        let version = toolbar.querySelector(`.${APP_ID}-version`);
        if (!version) {
            version = document.createElement('span');
            version.className = `${APP_ID}-version`;
            const panel = toolbar.querySelector(`.${APP_ID}-settings-panel`);
            toolbar.insertBefore(version, panel || null);
        }
        version.textContent = `v${SCRIPT_VERSION}`;
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
        const cacheTtlInput = panel.querySelector(`.${APP_ID}-cache-ttl-input`);

        if (keywordsInput && document.activeElement !== keywordsInput) {
            keywordsInput.value = state.hiddenFilters.keywords.join('\n');
        }
        if (salaryRange && document.activeElement !== salaryRange) {
            salaryRange.value = String(state.hiddenFilters.minSalaryMaxK);
        }
        if (cacheTtlInput && document.activeElement !== cacheTtlInput) {
            cacheTtlInput.value = String(state.jobCacheSettings.ttlDays);
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
        const cacheTtlInput = panel.querySelector(`.${APP_ID}-cache-ttl-input`);
        state.hiddenFilters = normalizeHiddenFilterSettings({
            keywords: keywordsInput ? keywordsInput.value : '',
            minSalaryMaxK: salaryRange ? salaryRange.value : 0
        });
        state.jobCacheSettings = normalizeJobCacheSettings({
            ttlDays: cacheTtlInput ? cacheTtlInput.value : state.jobCacheSettings.ttlDays
        });
        saveHiddenFilterSettings();
        saveJobCacheSettings();
        cacheCurrentMatchingJobs();
        renderCachedJobCards();
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
        autoSelectDefaultJobExpectation();
        cacheCurrentMatchingJobs();
        renderCachedJobCards();
        scheduleDetailPrefetch();
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

    function initJobListPage() {
        loadIgnoredJobs();
        loadActiveTimeCache();
        loadHiddenFilterSettings();
        loadCustomTags();
        loadJobCacheSettings();
        loadJobCache();
        watchJobCacheStorage();
        installStyles();
        renderGlobalPickerButton();
        registerMenus();
        installPageBridge();
        document.addEventListener('wheel', markJobListUserScroll, { passive: true, capture: true });
        document.addEventListener('touchmove', markJobListUserScroll, { passive: true, capture: true });
        document.addEventListener('keydown', handleJobListScrollKey, true);
        document.addEventListener('click', handleJobExpectationClick, true);
        document.addEventListener('click', handleLiveJobCardClick, true);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            if (syncJobCacheFromStorage()) scheduleRefresh();
        });
        window.addEventListener('focus', () => {
            if (syncJobCacheFromStorage()) scheduleRefresh();
        });
        refreshUi();
        startObserver();
        window.setInterval(scheduleRefresh, 1500);
    }

    function initStandaloneJobDetailPage() {
        installStyles();
        loadJobCacheSettings();
        loadJobCache();
        renderGlobalPickerButton();
        renderStandaloneDetailDebugPanel();
        captureStandaloneJobDetailWhenReady();
    }

    function init() {
        if (isStandaloneJobDetailPage()) {
            initStandaloneJobDetailPage();
            return;
        }
        initJobListPage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
