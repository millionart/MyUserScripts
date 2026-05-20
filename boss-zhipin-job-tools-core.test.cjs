const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    JOB_CACHE_SCHEMA_VERSION,
    compareJobRecordsByActiveTime,
    extractJobIdFromHref,
    findNextVisibleJobIndex,
    findAutoJobExpectationIndex,
    getActiveTimeTextFromJobData,
    getCachedRenderDeferDelay,
    getJobDataId,
    extractBossActiveTimeText,
    jobMatchesHiddenFilters,
    mergeCachedJobRecords,
    normalizeCachedJobRecords,
    normalizeJobCacheSettings,
    isRealJobExpectationText,
    normalizeStoredRecordMap,
    normalizeCustomTagRecords,
    normalizeCustomTagList,
    parseBossSalaryMaxK,
    parseBossActiveTimeRank,
    reorderJobDataListBySortedRecords,
    serializeRecordMap,
    sortJobRecordsByActiveTime
} = require('./boss-zhipin-job-tools-core.cjs');

test('userscript metadata is bumped for cached job retention delivery', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /\/\/ @version\s+0\.1\.52\b/);
    assert.match(script, /const SCRIPT_VERSION = '0\.1\.52';/);
});

test('toolbar script buttons keep a readable minimum width', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /\.\$\{APP_ID\}-toolbar button \{[\s\S]*min-width:\s*var\(--bzjt-filter-min-width,\s*68px\);/);
});

test('extracts BOSS Zhipin job ID from detail links', () => {
    assert.equal(
        extractJobIdFromHref('https://www.zhipin.com/job_detail/10b302d493f7c9f50nR-29m4GFpU.html'),
        '10b302d493f7c9f50nR-29m4GFpU'
    );
    assert.equal(
        extractJobIdFromHref('/job_detail/b7395962313210a703Fz3NS6GVFV.html?lid=abc#detail'),
        'b7395962313210a703Fz3NS6GVFV'
    );
    assert.equal(extractJobIdFromHref(''), '');
});

test('ranks boss active time with smaller values first', () => {
    assert.equal(parseBossActiveTimeRank('刚刚活跃'), 0);
    assert.equal(parseBossActiveTimeRank('今日活跃'), 10);
    assert.equal(parseBossActiveTimeRank('5分钟前活跃'), 5);
    assert.equal(parseBossActiveTimeRank('2小时前活跃'), 120);
    assert.equal(parseBossActiveTimeRank('昨天活跃'), 1440);
    assert.equal(parseBossActiveTimeRank('3天前活跃'), 4320);
    assert.equal(parseBossActiveTimeRank('3日内活跃'), 4320);
    assert.equal(parseBossActiveTimeRank('2周前活跃'), 20160);
    assert.equal(parseBossActiveTimeRank('1个月前活跃'), 43200);
    assert.equal(parseBossActiveTimeRank('未知'), Number.MAX_SAFE_INTEGER);
});

test('extracts boss active time from noisy loaded card text', () => {
    assert.equal(extractBossActiveTimeText('急聘 技术美术 25-40K 刚刚活跃'), '刚刚活跃');
    assert.equal(extractBossActiveTimeText('高级前端 在线'), '在线');
    assert.equal(extractBossActiveTimeText('后端开发 今日活跃 20-30K'), '今日活跃');
    assert.equal(extractBossActiveTimeText('TA 3日内活跃 北京'), '3日内活跃');
    assert.equal(extractBossActiveTimeText('HR 5分钟前活跃'), '5分钟前活跃');
    assert.equal(extractBossActiveTimeText('业务活跃用户增长'), '');
});

test('active sort uses loaded card active text without detail scanning', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const sortStart = script.indexOf('async function sortLoadedJobsByActiveTime()');
    const sortEnd = script.indexOf('function refreshUi()', sortStart);
    assert.notEqual(sortStart, -1);
    assert.notEqual(sortEnd, -1);
    const sortBody = script.slice(sortStart, sortEnd);
    assert.match(sortBody, /await loadMoreVisibleJobCardsBeforeSort\(\)/);
    assert.doesNotMatch(sortBody, /scanMissingActiveTimes/);
    assert.doesNotMatch(sortBody, /getDetailActiveTimeText/);
    assert.doesNotMatch(sortBody, /activateJobCard/);
});

test('active sort temporarily reveals filtered cards while loading more jobs', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const loadStart = script.indexOf('async function loadMoreVisibleJobCardsBeforeSort()');
    const loadEnd = script.indexOf('function getListController', loadStart);
    assert.notEqual(loadStart, -1);
    assert.notEqual(loadEnd, -1);
    const loadBody = script.slice(loadStart, loadEnd);
    assert.match(script, /filtersSuspendedForLoading: false/);
    assert.match(script, /function setFiltersSuspendedForLoading\(suspended\)/);
    assert.match(script, /function isFilterHidingSuspended\(\)/);
    assert.match(loadBody, /setFiltersSuspendedForLoading\(true\)/);
    assert.match(loadBody, /setFiltersSuspendedForLoading\(false\)/);
    assert.ok(loadBody.indexOf('setFiltersSuspendedForLoading(true)') < loadBody.indexOf('const target = getJobListScrollTarget()'));
});

test('active sort also reorders visible cards and returns list to top', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const sortRecordsStart = script.indexOf('async function sortRecordsOnPage(records)');
    const sortRecordsEnd = script.indexOf('async function sortLoadedJobsByActiveTime()', sortRecordsStart);
    const sortLoadedStart = sortRecordsEnd;
    const sortLoadedEnd = script.indexOf('function refreshUi()', sortLoadedStart);
    assert.notEqual(sortRecordsStart, -1);
    assert.notEqual(sortRecordsEnd, -1);
    assert.notEqual(sortLoadedEnd, -1);

    const sortRecordsBody = script.slice(sortRecordsStart, sortRecordsEnd);
    const sortLoadedBody = script.slice(sortLoadedStart, sortLoadedEnd);
    assert.match(sortRecordsBody, /const vueSorted = await sortRecordsInVue\(records, sorted\)/);
    assert.match(sortRecordsBody, /sortRecordsInDom\(records, sorted\)/);
    assert.match(sortLoadedBody, /scrollJobListToTopAfterSort\(sorted\)/);
    assert.match(script, /function scrollJobListToTopAfterSort\(sortedRecords\)/);
});

test('uses loaded job data online flag as an active-time hint', () => {
    assert.equal(getActiveTimeTextFromJobData({ bossOnline: true }), '在线');
    assert.equal(getActiveTimeTextFromJobData({ bossOnline: false }), '');
    assert.equal(getActiveTimeTextFromJobData(null), '');
    assert.equal(getJobDataId({ encryptJobId: ' job-a ' }), 'job-a');
});

test('parses BOSS salary text maximum value in K units', () => {
    assert.equal(parseBossSalaryMaxK('2-29K'), 29);
    assert.equal(parseBossSalaryMaxK('29-30k·13薪'), 30);
    assert.equal(parseBossSalaryMaxK('\uE033\uE031-\uE035\uE031K·\uE032\uE037薪'), 40);
    assert.equal(parseBossSalaryMaxK('15K以上'), 15);
    assert.equal(parseBossSalaryMaxK('10000-13000元/月'), 13);
    assert.equal(parseBossSalaryMaxK('8000-12000元'), 12);
    assert.equal(parseBossSalaryMaxK('120-150元/时'), 36);
    assert.equal(parseBossSalaryMaxK('120-150元/小时'), 36);
    assert.equal(parseBossSalaryMaxK('300-500元/天'), 0);
    assert.equal(parseBossSalaryMaxK('面议'), 0);
});

test('matches hidden filters by title keyword and salary maximum threshold', () => {
    assert.equal(jobMatchesHiddenFilters({
        title: '高级前端开发工程师',
        salaryText: '25-29K'
    }, {
        keywords: ['后端', '产品'],
        minSalaryMaxK: 30
    }), true);

    assert.equal(jobMatchesHiddenFilters({
        title: '后端开发工程师',
        salaryText: '35-45K'
    }, {
        keywords: ['后端'],
        minSalaryMaxK: 30
    }), true);

    assert.equal(jobMatchesHiddenFilters({
        title: '前端开发工程师',
        salaryText: '29-30K'
    }, {
        keywords: ['后端'],
        minSalaryMaxK: 30
    }), false);

    assert.equal(jobMatchesHiddenFilters({
        title: '在研项目-技术美术',
        keywordText: '3-5年 学历不限 计算机图形学',
        salaryText: '35-45K'
    }, {
        keywords: ['计算机图形学'],
        minSalaryMaxK: 30
    }), true);
});

test('normalizes custom tags by job without changing hidden filter settings', () => {
    assert.deepEqual(normalizeCustomTagList(['  TA  ', 'ta', 'UE5', '', 'UE5']), ['TA', 'UE5']);

    const tags = normalizeCustomTagRecords({
        a: { id: 'ignored', tags: [' 技术美术 ', 'UE5', '技术美术'], updatedAt: '1778136000000' },
        b: { tags: [] },
        '': { tags: ['bad'] }
    });

    assert.deepEqual(serializeRecordMap(tags), {
        a: {
            id: 'a',
            tags: ['技术美术', 'UE5'],
            updatedAt: 1778136000000
        }
    });

    const settings = { keywords: ['技术美术'] };
    assert.equal(jobMatchesHiddenFilters({ title: 'TA', keywordText: 'UE5 技术美术' }, settings), true);
    assert.deepEqual(settings, { keywords: ['技术美术'] });
});

test('normalizes job cache settings with a 30 day default and safe bounds', () => {
    assert.deepEqual(normalizeJobCacheSettings({}), { ttlDays: 30 });
    assert.deepEqual(normalizeJobCacheSettings({ ttlDays: '45' }), { ttlDays: 45 });
    assert.deepEqual(normalizeJobCacheSettings({ ttlDays: 0 }), { ttlDays: 1 });
    assert.deepEqual(normalizeJobCacheSettings({ ttlDays: 999 }), { ttlDays: 365 });
});

test('finds the first real job expectation between recommendation and add buttons', () => {
    assert.equal(findAutoJobExpectationIndex(['推荐', '技术美术(上海)', 'TA(上海)', '添加求职期望']), 1);
    assert.equal(findAutoJobExpectationIndex(['推荐', '添加求职期望']), -1);
    assert.equal(findAutoJobExpectationIndex(['推荐', '', 'UE TA', '添加求职期望']), 2);
    assert.equal(findAutoJobExpectationIndex(['UE TA', '添加求职期望']), 0);
    assert.equal(isRealJobExpectationText('推荐'), false);
    assert.equal(isRealJobExpectationText('添加求职期望'), false);
    assert.equal(isRealJobExpectationText('技术美术(上海)'), true);
});

test('defers cached-card rendering until user scrolling has gone idle', () => {
    assert.equal(getCachedRenderDeferDelay({ lastUserScrollAt: 1000, now: 1100, idleMs: 700 }), 600);
    assert.equal(getCachedRenderDeferDelay({ lastUserScrollAt: 1000, now: 1700, idleMs: 700 }), 0);
    assert.equal(getCachedRenderDeferDelay({ lastUserScrollAt: 0, now: 1100, idleMs: 700 }), 0);
    assert.equal(getCachedRenderDeferDelay({ lastUserScrollAt: Number.NaN, now: 1100, idleMs: 700 }), 0);
});

test('normalizes cached jobs and prunes records older than the configured ttl', () => {
    const now = Date.UTC(2026, 4, 20);
    const records = normalizeCachedJobRecords({
        keep: {
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: '技术美术',
            company: '库洛',
            salaryText: '25-35K',
            keywordText: 'UE5 TA',
            tagTexts: ['3-5年', '本科', 'UE5'],
            logoSrc: 'https://img.bosszhipin.com/logo.png',
            locationText: '上海',
            expectationText: '技术美术(上海)',
            href: 'https://www.zhipin.com/job_detail/keep.html',
            detailHtml: '<section>职位描述</section>',
            activeTimeText: '今日活跃',
            activeRank: 10,
            firstSeenAt: now - 35 * 86400000,
            lastSeenAt: now - 29 * 86400000
        },
        drop: {
            title: '后端',
            lastSeenAt: now - 31 * 86400000
        },
        bad: {
            title: ''
        }
    }, {
        now,
        ttlDays: 30
    });

    assert.deepEqual(serializeRecordMap(records), {
        keep: {
            id: 'keep',
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: '技术美术',
            company: '库洛',
            salaryText: '25-35K',
            keywordText: 'UE5 TA',
            tagTexts: ['3-5年', '本科', 'UE5'],
            logoSrc: 'https://img.bosszhipin.com/logo.png',
            locationText: '上海',
            expectationText: '技术美术(上海)',
            href: 'https://www.zhipin.com/job_detail/keep.html',
            detailHtml: '<section>职位描述</section>',
            activeTimeText: '今日活跃',
            activeRank: 10,
            firstSeenAt: now - 35 * 86400000,
            lastSeenAt: now - 29 * 86400000
        }
    });
});

test('normalizes cached jobs can require the current cache schema', () => {
    const now = Date.UTC(2026, 4, 20);
    const records = normalizeCachedJobRecords({
        current: {
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: '技术美术',
            expectationText: '技术美术(上海)',
            lastSeenAt: now
        },
        legacy: {
            title: '超声医生 体检中心',
            expectationText: '技术美术(上海)',
            lastSeenAt: now
        }
    }, {
        now,
        ttlDays: 30,
        requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION
    });

    assert.deepEqual(Object.keys(serializeRecordMap(records)), ['current']);
});

test('normalizes cached jobs keeps structured list card and detail fields', () => {
    const now = Date.UTC(2026, 4, 20);
    const records = normalizeCachedJobRecords({
        native: {
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: 'AI 技术美术',
            salaryText: '30-50K',
            tagTexts: [' 3-5年 ', '', '本科', '本科'],
            logoSrc: ' https://img.bosszhipin.com/logo.png ',
            locationText: '上海',
            detailHtml: '<div class="job-detail-container">详情</div>',
            lastSeenAt: now
        }
    }, {
        now,
        ttlDays: 30,
        requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION
    });

    assert.deepEqual(serializeRecordMap(records).native, {
        id: 'native',
        schemaVersion: JOB_CACHE_SCHEMA_VERSION,
        title: 'AI 技术美术',
        salaryText: '30-50K',
        tagTexts: ['3-5年', '本科'],
        logoSrc: 'https://img.bosszhipin.com/logo.png',
        locationText: '上海',
        detailHtml: '<div class="job-detail-container">详情</div>',
        firstSeenAt: now,
        lastSeenAt: now
    });
});

test('merges current matching jobs into cache while preserving first seen time', () => {
    const now = Date.UTC(2026, 4, 20);
    const cached = {
        a: {
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: '旧标题',
            company: '旧公司',
            firstSeenAt: now - 2 * 86400000,
            lastSeenAt: now - 2 * 86400000
        },
        stale: {
            title: '过期职位',
            lastSeenAt: now - 40 * 86400000
        }
    };

    const merged = mergeCachedJobRecords(cached, [
        {
            id: 'a',
            title: '新标题',
            company: '新公司',
            salaryText: '30-40K',
            keywordText: '图形学',
            tagTexts: ['3-5年', '本科'],
            logoSrc: 'https://img.bosszhipin.com/logo-a.png',
            locationText: '上海',
            expectationText: '技术美术(上海)',
            href: '/job_detail/a.html',
            detailHtml: '<section>新详情</section>',
            activeTimeText: '刚刚活跃',
            activeRank: 0
        },
        {
            id: 'b',
            title: '新增职位',
            company: '新公司',
            salaryText: '20-30K',
            tagTexts: ['经验不限'],
            expectationText: '技术美术(上海)'
        }
    ], {
        now,
        ttlDays: 30
    });

    assert.deepEqual(serializeRecordMap(merged), {
        a: {
            id: 'a',
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: '新标题',
            company: '新公司',
            salaryText: '30-40K',
            keywordText: '图形学',
            tagTexts: ['3-5年', '本科'],
            logoSrc: 'https://img.bosszhipin.com/logo-a.png',
            locationText: '上海',
            expectationText: '技术美术(上海)',
            href: '/job_detail/a.html',
            detailHtml: '<section>新详情</section>',
            activeTimeText: '刚刚活跃',
            activeRank: 0,
            firstSeenAt: now - 2 * 86400000,
            lastSeenAt: now
        },
        b: {
            id: 'b',
            schemaVersion: JOB_CACHE_SCHEMA_VERSION,
            title: '新增职位',
            company: '新公司',
            salaryText: '20-30K',
            tagTexts: ['经验不限'],
            expectationText: '技术美术(上海)',
            firstSeenAt: now,
            lastSeenAt: now
        }
    });
});

test('userscript renders cached jobs into the live list and exposes cache ttl setting', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /const JOB_CACHE_STORAGE_KEY = 'boss-zhipin-job-tools:job-cache';/);
    assert.match(script, /const JOB_CACHE_SETTINGS_STORAGE_KEY = 'boss-zhipin-job-tools:job-cache-settings';/);
    assert.match(script, /const JOB_CACHE_SCHEMA_VERSION = 5;/);
    assert.match(script, /jobCacheSettings: \{ ttlDays: DEFAULT_JOB_CACHE_TTL_DAYS \}/);
    assert.match(script, /function cacheCurrentMatchingJobs\(\)/);
    assert.match(script, /function renderCachedJobCards\(options = \{\}\)/);
    assert.match(script, /function createCachedJobCard\(record\)/);
    assert.match(script, /function cloneNativeJobCardTemplate\(\)/);
    assert.match(script, /function updateNativeCachedJobCard\(card, record\)/);
    assert.match(script, /function renderFallbackCachedJobCard\(card, record\)/);
    assert.match(script, /cloneNode\(true\)/);
    assert.match(script, /dataset\.bzjtNativeTemplate = '1'/);
    assert.match(script, /className = `job-card-wrap \$\{APP_ID\}-cached-card`/);
    assert.match(script, /'job-card-body clearfix'/);
    assert.match(script, /'job-card-left'/);
    assert.match(script, /'job-card-right'/);
    assert.match(script, /'tag-list'/);
    assert.match(script, /class="\$\{APP_ID\}-cache-ttl-input"/);
    assert.match(script, /loadJobCacheSettings\(\)/);
    assert.match(script, /loadJobCache\(\)/);
    assert.match(script, /cacheCurrentMatchingJobs\(\)/);
    assert.match(script, /renderCachedJobCards\(\)/);
    assert.match(script, /class="\$\{APP_ID\}-version"/);
});

test('userscript cached cards render in-place detail instead of opening a new tab', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const start = script.indexOf('function createCachedJobCard(record)');
    const end = script.indexOf('function makeCacheableJobRecordFromCard(card)', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const body = script.slice(start, end);

    assert.match(body, /showCachedJobDetail\(latestRecord\)/);
    assert.doesNotMatch(body, /window\.open/);
    assert.match(script, /async function showCachedJobDetail\(record\)/);
    assert.match(script, /function findDetailRoot\(\)/);
    assert.match(script, /async function fetchCachedJobDetailHtml\(record, options = \{\}\)/);
    assert.match(script, /function renderCachedJobDetail\(record, detailHtml/);
    assert.match(script, /function sanitizeCachedDetailHtml\(html\)/);
});

test('userscript opening cached detail does not refresh cached job ordering timestamp', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const showStart = script.indexOf('async function showCachedJobDetail(record)');
    const showEnd = script.indexOf('function renderFallbackCachedJobCard(card, record)', showStart);
    assert.notEqual(showStart, -1);
    assert.notEqual(showEnd, -1);
    const showBody = script.slice(showStart, showEnd);

    assert.doesNotMatch(showBody, /lastSeenAt:\s*Date\.now\(\)/);
    assert.match(showBody, /detailFetchedAt:\s*Date\.now\(\)/);
});

test('userscript cached detail overlay does not replace site-owned detail dom', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const renderStart = script.indexOf('function renderCachedJobDetail(record, detailHtml');
    const renderEnd = script.indexOf('async function showCachedJobDetail(record)', renderStart);
    assert.notEqual(renderStart, -1);
    assert.notEqual(renderEnd, -1);
    const renderBody = script.slice(renderStart, renderEnd);

    assert.match(script, /function getCachedDetailOverlay\(root\)/);
    assert.match(script, /function syncCachedDetailOverlayClass\(root, overlay\)/);
    assert.match(script, /function clearCachedJobDetail\(\)/);
    assert.match(script, /function handleLiveJobCardClick\(event\)/);
    assert.match(script, /document\.addEventListener\('click', handleLiveJobCardClick, true\)/);
    assert.match(script, /\$\{APP_ID\}-cached-detail-overlay/);
    assert.doesNotMatch(renderBody, /root\.innerHTML\s*=/);
    assert.match(renderBody, /syncCachedDetailOverlayClass\(root, overlay\)/);
    assert.match(renderBody, /overlay\.innerHTML = detailHtml/);
});

test('userscript cached detail fallback inherits native detail css classes', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const fallbackStart = script.indexOf('function buildCachedJobDetailFallback(record, message = \'\', root = null');
    const fallbackEnd = script.indexOf('async function fetchCachedJobDetailHtml(record', fallbackStart);
    const renderStart = script.indexOf('function renderCachedJobDetail(record, detailHtml');
    const renderEnd = script.indexOf('async function showCachedJobDetail(record)', renderStart);
    assert.notEqual(fallbackStart, -1);
    assert.notEqual(fallbackEnd, -1);
    assert.notEqual(renderStart, -1);
    assert.notEqual(renderEnd, -1);

    const fallbackBody = script.slice(fallbackStart, fallbackEnd);
    const renderBody = script.slice(renderStart, renderEnd);
    assert.match(script, /function getNativeDetailClassName\(root\)/);
    assert.match(fallbackBody, /wrapper\.className = normalizeSpace\(`\$\{APP_ID\}-cached-detail-fallback \$\{getNativeDetailClassName\(root\)\}`\)/);
    assert.match(renderBody, /buildCachedJobDetailFallback\(record, message, root/);
});

test('userscript cached detail targets the outer native detail panel', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /const DETAIL_ROOT_CONTAINER_SELECTOR = /);
    assert.match(script, /const DETAIL_SCAN_SELECTOR = /);
    assert.match(script, /function resolveDetailRootContainer\(candidate\)/);
    assert.match(script, /candidate\.closest\(DETAIL_ROOT_CONTAINER_SELECTOR\)/);
    assert.match(script, /function getDetailRootCandidates\(scope\)/);
    assert.match(script, /resolveDetailRootContainer\(element\)/);
    assert.match(script, /findBestDetailRoot\(candidates\)/);
});

test('userscript wraps partial cached detail html with a native detail header shell', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const fallbackStart = script.indexOf('function buildCachedJobDetailFallback(record, message = \'\', root = null');
    const fallbackEnd = script.indexOf('async function fetchCachedJobDetailHtml(record', fallbackStart);
    const renderStart = script.indexOf('function renderCachedJobDetail(record, detailHtml');
    const renderEnd = script.indexOf('async function showCachedJobDetail(record)', renderStart);
    assert.notEqual(fallbackStart, -1);
    assert.notEqual(fallbackEnd, -1);
    assert.notEqual(renderStart, -1);
    assert.notEqual(renderEnd, -1);

    const fallbackBody = script.slice(fallbackStart, fallbackEnd);
    const renderBody = script.slice(renderStart, renderEnd);
    assert.match(script, /function detailHtmlHasNativeHeader\(html\)/);
    assert.match(script, /function buildCachedJobDetailNativeShell\(record, message = '', root = null, contentHtml = ''\)/);
    assert.match(script, /const clone = root\.cloneNode\(true\)/);
    assert.match(script, /clone\.classList\.remove\(`\$\{APP_ID\}-cached-detail`\)/);
    assert.match(script, /replaceElementText\(clone\.querySelector\('\.job-detail-header \.job-name, \.job-detail-header h1, h1, \.job-name'\), record\.title \|\| '缓存职位'\)/);
    assert.match(script, /replaceElementText\(clone\.querySelector\('\.job-detail-header \.salary, \.job-detail-header \.job-salary, \.salary, \.job-salary, \[class\*="salary"\]'\), record\.salaryText\)/);
    assert.match(fallbackBody, /const nativeShell = buildCachedJobDetailNativeShell\(record, message, root, contentHtml\)/);
    assert.match(fallbackBody, /if \(nativeShell\) return nativeShell\.outerHTML/);
    assert.match(fallbackBody, /content\.innerHTML = sanitizeCachedDetailHtml\(contentHtml\)/);
    assert.match(renderBody, /detailHtmlHasNativeHeader\(detailHtml\)/);
    assert.match(renderBody, /buildCachedJobDetailFallback\(record, message, root, detailHtml\)/);
});

test('userscript replaces stale native detail body when switching cached jobs', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const shellStart = script.indexOf('function buildCachedJobDetailNativeShell(record, message = \'\', root = null');
    const shellEnd = script.indexOf('function buildCachedJobDetailFallback(record, message = \'\', root = null', shellStart);
    assert.notEqual(shellStart, -1);
    assert.notEqual(shellEnd, -1);
    const shellBody = script.slice(shellStart, shellEnd);

    assert.match(script, /function removeStaleCachedDetailSections\(root\)/);
    assert.match(script, /function createCachedDetailDescriptionSection\(message = '', contentHtml = ''\)/);
    assert.match(script, /function appendCachedDetailDescription\(root, message = '', contentHtml = ''\)/);
    assert.match(script, /function replaceCachedDetailDescription\(root, message = '', contentHtml = ''\)/);
    assert.match(shellBody, /replaceCachedDetailDescription\(clone, message, contentHtml\)/);
    assert.match(script, /const headerContainer = header\?\.closest\('\.job-detail-header'\) \|\| header/);
    assert.match(script, /岗位职责\|岗位要求\|任职要求/);
    assert.match(script, /section\.remove\(\)/);
    assert.match(script, /appendCachedDetailDescription\(root, message, contentHtml\)/);
});

test('userscript ignores stale async cached detail responses after switching jobs', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const showStart = script.indexOf('async function showCachedJobDetail(record)');
    const showEnd = script.indexOf('function renderFallbackCachedJobCard(card, record)', showStart);
    assert.notEqual(showStart, -1);
    assert.notEqual(showEnd, -1);
    const showBody = script.slice(showStart, showEnd);

    assert.match(script, /currentCachedDetailId: ''/);
    assert.match(showBody, /state\.currentCachedDetailId = id/);
    assert.match(showBody, /if \(state\.currentCachedDetailId !== id\) return/);
    assert.match(showBody, /if \(state\.currentCachedDetailId === id(?: && !trustedDetailHtml)?\) \{/);
});

test('userscript only trusts cached detail html tagged for the same job', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const showStart = script.indexOf('async function showCachedJobDetail(record)');
    const showEnd = script.indexOf('function renderFallbackCachedJobCard(card, record)', showStart);
    assert.notEqual(showStart, -1);
    assert.notEqual(showEnd, -1);
    const showBody = script.slice(showStart, showEnd);

    assert.match(script, /function cachedDetailHtmlMatchesRecord\(record, detailHtml\)/);
    assert.match(script, /function cachedDetailContentMatchesRecord\(record, detailHtml\)/);
    assert.match(script, /function getTrustedCachedDetailHtml\(record\)/);
    assert.match(script, /detailJobId/);
    assert.match(script, /const DETAIL_CACHE_SCHEMA_VERSION = 3/);
    assert.match(script, /detailSchemaVersion: DETAIL_CACHE_SCHEMA_VERSION/);
    assert.match(script, /schemaVersion < DETAIL_CACHE_SCHEMA_VERSION/);
    assert.match(script, /`\$\{APP_ID\}-cached-detail`/);
    assert.match(script, /`\$\{APP_ID\}-cache-tag`/);
    assert.match(script, /detailHtmlHasNativeHeader\(detailHtml\)/);
    assert.match(script, /function isDuplicateDetailForDifferentCachedJob\(id, detailHtml\)/);
    assert.match(script, /duplicate stale detail/);
    assert.match(script, /detailJobId && \(!id \|\| detailJobId !== id\)/);
    assert.match(script, /if \(title\) return text\.includes\(title\)/);
    assert.match(script, /return cachedDetailContentMatchesRecord\(record, detailHtml\) \? detailHtml : ''/);
    assert.match(showBody, /let trustedDetailHtml = getTrustedCachedDetailHtml\(latestRecord\)/);
    assert.match(showBody, /renderCachedJobDetail\(latestRecord, trustedDetailHtml, trustedDetailHtml \? '' : '正在加载缓存职位详情\.\.\.'\)/);
    assert.match(showBody, /fetchCachedJobDetailHtml\(latestRecord, \{ forceNetwork: true \}\)/);
    assert.match(showBody, /detailJobId: id/);
    assert.match(showBody, /if \(state\.currentCachedDetailId === id && !trustedDetailHtml\) \{/);
});

test('userscript cached cards preserve logo, visible cache tag, and specific cache age text', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /function getCardLogoSrc\(card\)/);
    assert.match(script, /backgroundImage/);
    assert.match(script, /data-initial/);
    assert.match(script, /logoSrc: getCardLogoSrc\(card\)/);
    assert.match(script, /function updateCachedCardLogo\(card, record\)/);
    assert.match(script, /updateCachedCardLogo\(card, record\)/);
    assert.match(script, /function ensureCachedTagList\(card\)/);
    assert.match(script, /function ensureCacheTag\(list\)/);
    assert.match(script, /const minutes = Math\.floor\(elapsedMs \/ 60000\)/);
    assert.match(script, /return `\$\{minutes\}分钟前缓存`/);
    assert.match(script, /return `\$\{hours\}小时前缓存`/);
    assert.doesNotMatch(script, /return days > 0 \? `\$\{days\}天前缓存` : '今天缓存'/);
});

test('userscript marks cached list containers as scrollable when cache extends the list', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const renderStart = script.indexOf('function renderCachedJobCards(options = {})');
    const renderEnd = script.indexOf('function getDetailActiveTimeText()', renderStart);
    assert.notEqual(renderStart, -1);
    assert.notEqual(renderEnd, -1);
    const renderBody = script.slice(renderStart, renderEnd);

    assert.match(script, /function getCachedJobScrollHost\(parent\)/);
    assert.match(script, /function syncCachedJobScrollLayout\(parent, cachedCards\)/);
    assert.match(script, /\$\{APP_ID\}-cached-list-host/);
    assert.match(script, /\$\{APP_ID\}-cached-scroll-host/);
    assert.match(script, /overflow-y:\s*auto !important/);
    assert.match(renderBody, /syncCachedJobScrollLayout\(parent, desiredCards\)/);
});

test('userscript does not reflow cached cards while the user is scrolling the list', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const renderStart = script.indexOf('function renderCachedJobCards(');
    const renderEnd = script.indexOf('function getCachedJobScrollHost(parent)', renderStart);
    const initStart = script.indexOf('function init()');
    const initEnd = script.indexOf("if (document.readyState === 'loading')", initStart);
    assert.notEqual(renderStart, -1);
    assert.notEqual(renderEnd, -1);
    assert.notEqual(initStart, -1);
    assert.notEqual(initEnd, -1);

    const renderBody = script.slice(renderStart, renderEnd);
    const initBody = script.slice(initStart, initEnd);
    assert.match(script, /const USER_SCROLL_RENDER_DEFER_MS = 700;/);
    assert.match(script, /lastJobListUserScrollAt: 0/);
    assert.match(script, /function markJobListUserScroll\(\)/);
    assert.match(script, /function getCachedRenderDeferDelay\(/);
    assert.match(script, /function scheduleCachedJobRenderAfterScroll\(/);
    assert.match(renderBody, /options\.allowDuringScroll/);
    assert.match(renderBody, /scheduleCachedJobRenderAfterScroll\(deferMs\)/);
    assert.match(initBody, /document\.addEventListener\('wheel', markJobListUserScroll, \{ passive: true, capture: true \}\)/);
    assert.doesNotMatch(script, /overscroll-behavior-y:\s*contain/);
    assert.doesNotMatch(script, /scroll-behavior:\s*smooth/);
});

test('userscript only collects cached jobs after a job expectation is active', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const cacheStart = script.indexOf('function cacheCurrentMatchingJobs()');
    const renderStart = script.indexOf('function getCachedJobRecordsForRender()', cacheStart);
    assert.notEqual(cacheStart, -1);
    assert.notEqual(renderStart, -1);

    const cacheBody = script.slice(cacheStart, renderStart);
    assert.match(script, /function getActiveJobExpectationText\(\)/);
    assert.match(script, /function hasActiveJobExpectation\(\)/);
    assert.match(script, /function handleJobExpectationClick\(event\)/);
    assert.match(script, /jobExpectationSelectedByUser: false/);
    assert.match(script, /EXPECTATION_CACHE_SETTLE_MS = 2500/);
    assert.match(script, /Date\.now\(\) - state\.expectationSelectedAt >= EXPECTATION_CACHE_SETTLE_MS/);
    assert.match(cacheBody, /if \(!hasActiveJobExpectation\(\)\) \{/);
    assert.match(cacheBody, /const activeExpectationText = getActiveJobExpectationText\(\)/);
    assert.match(cacheBody, /expectationText: activeExpectationText/);
    assert.match(cacheBody, /schemaVersion: JOB_CACHE_SCHEMA_VERSION/);
    assert.match(cacheBody, /state\.jobCache = normalizeCachedJobRecords\(state\.jobCache, \{[\s\S]*requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION[\s\S]*\}\)/);
    assert.match(cacheBody, /return;/);
    assert.match(script, /record\.expectationText === activeExpectationText/);
    assert.match(script, /record\.schemaVersion === JOB_CACHE_SCHEMA_VERSION/);
    assert.match(script, /requiredSchemaVersion: JOB_CACHE_SCHEMA_VERSION/);
});

test('userscript automatically opens the first real job expectation on page load', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const refreshStart = script.indexOf('function refreshUi()');
    const refreshEnd = script.indexOf('function scheduleRefresh()', refreshStart);
    assert.notEqual(refreshStart, -1);
    assert.notEqual(refreshEnd, -1);
    const refreshBody = script.slice(refreshStart, refreshEnd);

    assert.match(script, /function isRealJobExpectationText\(text\)/);
    assert.match(script, /function getJobExpectationItems\(\)/);
    assert.match(script, /function findDefaultJobExpectationItem\(\)/);
    assert.match(script, /function markJobExpectationSelected\(target\)/);
    assert.match(script, /function autoSelectDefaultJobExpectation\(\)/);
    assert.match(script, /findAutoJobExpectationIndex\(items\.map\(\(item\) => normalizeSpace\(item\.textContent\)\)\)/);
    assert.match(script, /if \(!activeText \|\| !isRealJobExpectationText\(activeText\)\) return false/);
    assert.match(script, /if \(!isRealJobExpectationText\(normalizeSpace\(target\.textContent\)\)\) return/);
    assert.match(script, /target\.click\(\)/);
    assert.match(refreshBody, /autoSelectDefaultJobExpectation\(\)/);
});

test('custom tag UI targets the job description tag row with native tag styling', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /function findJobDescriptionHeading\(\)/);
    assert.match(script, /function isElementAfter\(element, anchor\)/);
    assert.match(script, /function findDetailTagHost\(\)[\s\S]*findJobDescriptionHeading\(\)[\s\S]*isElementAfter\(candidate, heading\)/);
    assert.match(script, /function ensureDetailTagHost\(\)/);
    assert.match(script, /className = `\$\{APP_ID\}-custom-tag-row`/);
    assert.match(script, /insertBefore\(host, heading\.nextSibling\)/);
    assert.match(script, /\.\$\{APP_ID\}-custom-tag,\s*\.\$\{APP_ID\}-custom-tag-add \{[\s\S]*background:\s*#f8f8f8;/);
    assert.match(script, /\.\$\{APP_ID\}-custom-tag-add \{[\s\S]*border:\s*0;/);
});

test('native chat links are kept as new-tab links during UI refresh', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const refreshStart = script.indexOf('function refreshUi()');
    const refreshEnd = script.indexOf('function scheduleRefresh()', refreshStart);
    assert.notEqual(refreshStart, -1);
    assert.notEqual(refreshEnd, -1);

    const refreshBody = script.slice(refreshStart, refreshEnd);
    assert.match(script, /function findChatActionElements\(\)/);
    assert.match(script, /function ensureChatButtonsOpenInNewTabs\(\)/);
    assert.match(script, /anchor\.target = '_blank'/);
    assert.match(script, /anchor\.rel = 'noopener noreferrer'/);
    assert.match(refreshBody, /ensureChatButtonsOpenInNewTabs\(\)/);
});

test('javascript chat routes are diverted to a new tab without changing current page route', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    const bridgeStart = script.indexOf('function installPageBridge()');
    const bridgeEnd = script.indexOf('function getJobCards()', bridgeStart);
    const initStart = script.indexOf('function init()');
    const initEnd = script.indexOf("if (document.readyState === 'loading')", initStart);
    assert.notEqual(bridgeStart, -1);
    assert.notEqual(bridgeEnd, -1);
    assert.notEqual(initStart, -1);
    assert.notEqual(initEnd, -1);

    const bridgeBody = script.slice(bridgeStart, bridgeEnd);
    const initBody = script.slice(initStart, initEnd);
    assert.match(bridgeBody, /function handleChatActionClick\(event\)/);
    assert.match(bridgeBody, /const popup = window\.open\('about:blank', '_blank', 'noopener,noreferrer'\)/);
    assert.match(bridgeBody, /const interceptPushState = makeHistoryRouteInterceptor\(originalPushState\)/);
    assert.match(bridgeBody, /const interceptReplaceState = makeHistoryRouteInterceptor\(originalReplaceState\)/);
    assert.match(bridgeBody, /history\.pushState = interceptPushState/);
    assert.match(bridgeBody, /history\.replaceState = interceptReplaceState/);
    assert.match(bridgeBody, /window\.addEventListener\('click', handleChatActionClick, true\)/);
    assert.match(script, /event\.preventDefault\(\)/);
    assert.match(initBody, /installPageBridge\(\)/);
    assert.doesNotMatch(initBody, /installChatNewTabClickHandler\(\)/);
});

test('selects the next visible job after ignoring the current one', () => {
    assert.equal(findNextVisibleJobIndex([
        { id: 'a', ignored: true },
        { id: 'b', ignored: false },
        { id: 'c', ignored: false }
    ], 0), 1);

    assert.equal(findNextVisibleJobIndex([
        { id: 'a', ignored: false },
        { id: 'b', ignored: true },
        { id: 'c', ignored: false }
    ], 2), 0);

    assert.equal(findNextVisibleJobIndex([
        { id: 'a', ignored: true }
    ], 0), -1);
});

test('sorts job records by active time while preserving original order for ties', () => {
    const jobs = [
        { id: 'a', activeTimeText: '3天前活跃', originalIndex: 0 },
        { id: 'b', activeTimeText: '刚刚活跃', originalIndex: 1 },
        { id: 'c', activeTimeText: '今日活跃', originalIndex: 2 },
        { id: 'd', activeTimeText: '今日活跃', originalIndex: 3 },
        { id: 'e', activeTimeText: '', originalIndex: 4 }
    ];

    assert.deepEqual(sortJobRecordsByActiveTime(jobs).map((job) => job.id), ['b', 'c', 'd', 'a', 'e']);
    assert.equal(compareJobRecordsByActiveTime(jobs[2], jobs[3]) < 0, true);
});

test('reorders Vue job data only in slots represented by sorted records', () => {
    const untouchedBefore = { encryptJobId: 'before', jobName: 'untouched before' };
    const untouchedMiddle = { encryptJobId: 'middle', jobName: 'untouched middle' };
    const a = { encryptJobId: 'a', jobName: 'A' };
    const b = { encryptJobId: 'b', jobName: 'B' };
    const c = { encryptJobId: 'c', jobName: 'C' };

    assert.deepEqual(
        reorderJobDataListBySortedRecords([
            untouchedBefore,
            a,
            b,
            untouchedMiddle,
            c
        ], [
            { id: 'b', jobData: b },
            { id: 'c', jobData: c },
            { id: 'a', jobData: a }
        ]),
        [
            untouchedBefore,
            b,
            c,
            untouchedMiddle,
            a
        ]
    );
});

test('normalizes script storage records into cloud-sync-friendly objects', () => {
    const stored = {
        a: {
            id: 'ignored',
            title: '  技术美术  ',
            company: ' 库洛 ',
            href: 'https://www.zhipin.com/job_detail/a.html',
            ignoredAt: '1778136000000'
        },
        '': {
            title: 'missing id'
        }
    };

    const records = normalizeStoredRecordMap(stored, {
        textFields: ['title', 'company', 'href'],
        numberFields: ['ignoredAt']
    });

    assert.deepEqual(serializeRecordMap(records), {
        a: {
            id: 'a',
            title: '技术美术',
            company: '库洛',
            href: 'https://www.zhipin.com/job_detail/a.html',
            ignoredAt: 1778136000000
        }
    });
});

test('normalizes active time cache stored by job id', () => {
    const records = normalizeStoredRecordMap([
        { id: 'a', text: '刚刚活跃', rank: 0, seenAt: 1778136000000 },
        { id: '', text: 'bad' }
    ], {
        textFields: ['text'],
        numberFields: ['rank', 'seenAt']
    });

    assert.deepEqual(serializeRecordMap(records), {
        a: {
            id: 'a',
            text: '刚刚活跃',
            rank: 0,
            seenAt: 1778136000000
        }
    });
});
