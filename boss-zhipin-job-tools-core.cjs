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
    compareJobRecordsByActiveTime,
    extractJobIdFromHref,
    findNextVisibleJobIndex,
    getActiveTimeTextFromJobData,
    getJobDataId,
    jobMatchesHiddenFilters,
    normalizeHiddenFilterSettings,
    normalizeStoredRecordMap,
    normalizeSpace,
    parseBossSalaryMaxK,
    parseBossActiveTimeRank,
    reorderJobDataListBySortedRecords,
    serializeRecordMap,
    sortJobRecordsByActiveTime
};
