const DEFAULT_JOB_CACHE_TTL_DAYS = 30;
const MIN_JOB_CACHE_TTL_DAYS = 1;
const MAX_JOB_CACHE_TTL_DAYS = 365;
const JOB_CACHE_SCHEMA_VERSION = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_RENDER_SCROLL_IDLE_MS = 700;

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

function parseBossActiveTimeRank(text) {
    const value = normalizeSpace(text);
    if (!value) return Number.MAX_SAFE_INTEGER;
    if (/刚刚|在线|当前/.test(value)) return 0;
    if (/今日|今天/.test(value)) return 10;
    if (/昨天/.test(value)) return 24 * 60;
    if (/前天/.test(value)) return 2 * 24 * 60;

    const match = value.match(/(\d+)\s*(分钟|小时|天|日|周|个月|月|年)/);
    if (!match) return Number.MAX_SAFE_INTEGER;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return Number.MAX_SAFE_INTEGER;

    const unit = match[2];
    if (unit === '分钟') return amount;
    if (unit === '小时') return amount * 60;
    if (unit === '天' || unit === '日') return amount * 24 * 60;
    if (unit === '周') return amount * 7 * 24 * 60;
    if (unit === '个月' || unit === '月') return amount * 30 * 24 * 60;
    if (unit === '年') return amount * 365 * 24 * 60;
    return Number.MAX_SAFE_INTEGER;
}

function extractBossActiveTimeText(text) {
    const value = normalizeSpace(text);
    if (!value) return '';

    const match = value.match(/((?:刚刚|当前|今日|今天|昨天|前天)活跃|在线|(?:\d+\s*(?:分钟|小时|天|日|周|个月|月|年)(?:内|前)?活跃))/);
    return match ? normalizeSpace(match[1]) : '';
}

function getRecordRank(record) {
    const explicitRank = Number(record && record.activeRank);
    if (Number.isFinite(explicitRank)) return explicitRank;
    return parseBossActiveTimeRank(record && record.activeTimeText);
}

function compareJobRecordsByActiveTime(left, right) {
    const rankDiff = getRecordRank(left) - getRecordRank(right);
    if (rankDiff !== 0) return rankDiff;
    return (Number(left && left.originalIndex) || 0) - (Number(right && right.originalIndex) || 0);
}

function sortJobRecordsByActiveTime(records) {
    return (Array.isArray(records) ? records : [])
        .slice()
        .sort(compareJobRecordsByActiveTime);
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
        : DEFAULT_CACHE_RENDER_SCROLL_IDLE_MS;
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

function normalizeCachedJobRecord(key, record, now) {
    const id = normalizeSpace(key || (record && record.id));
    if (!id || !record || typeof record !== 'object') return null;

    const normalized = { id };
    const schemaVersion = Number(record.schemaVersion);
    if (Number.isFinite(schemaVersion)) normalized.schemaVersion = Math.trunc(schemaVersion);

    for (const field of ['title', 'company', 'salaryText', 'keywordText', 'logoSrc', 'locationText', 'expectationText', 'href', 'detailHtml', 'detailJobId', 'activeTimeText']) {
        const value = normalizeSpace(record[field]);
        if (value) normalized[field] = value;
    }

    const tagTexts = normalizeCachedJobTagTexts(record.tagTexts);
    if (tagTexts.length) normalized.tagTexts = tagTexts;

    if (!normalized.title && !normalized.href) return null;

    const activeRank = Number(record.activeRank);
    if (Number.isFinite(activeRank)) normalized.activeRank = activeRank;

    const detailSchemaVersion = Number(record.detailSchemaVersion);
    if (Number.isFinite(detailSchemaVersion)) normalized.detailSchemaVersion = Math.trunc(detailSchemaVersion);

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

            for (const field of ['title', 'company', 'salaryText', 'keywordText', 'logoSrc', 'locationText', 'expectationText', 'href', 'detailHtml', 'detailJobId', 'activeTimeText']) {
                const value = normalizeSpace(record && record[field]) || normalizeSpace(existing[field]);
                if (value) next[field] = value;
            }

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

function reorderJobDataListBySortedRecords(jobDataList, sortedRecords) {
    const list = Array.isArray(jobDataList) ? jobDataList : [];
    const records = Array.isArray(sortedRecords) ? sortedRecords : [];
    const targetIds = new Set(records.map((record) => normalizeSpace(record && record.id)).filter(Boolean));
    const sortedJobData = records
        .map((record) => record && record.jobData)
        .filter((jobData) => targetIds.has(getJobDataId(jobData)));

    let cursor = 0;
    return list.map((jobData) => {
        const id = getJobDataId(jobData);
        if (!targetIds.has(id)) return jobData;
        const replacement = sortedJobData[cursor];
        cursor += 1;
        return replacement || jobData;
    });
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

module.exports = {
    JOB_CACHE_SCHEMA_VERSION,
    compareJobRecordsByActiveTime,
    extractBossActiveTimeText,
    extractJobIdFromHref,
    findAutoJobExpectationIndex,
    findNextVisibleJobIndex,
    getActiveTimeTextFromJobData,
    getCachedRenderDeferDelay,
    getJobDataId,
    jobMatchesHiddenFilters,
    mergeCachedJobRecords,
    isRealJobExpectationText,
    normalizeCachedJobRecords,
    normalizeCustomTagList,
    normalizeCustomTagRecords,
    normalizeHiddenFilterSettings,
    normalizeJobCacheSettings,
    normalizeStoredRecordMap,
    normalizeSpace,
    parseBossSalaryMaxK,
    parseBossActiveTimeRank,
    reorderJobDataListBySortedRecords,
    serializeRecordMap,
    sortJobRecordsByActiveTime
};
