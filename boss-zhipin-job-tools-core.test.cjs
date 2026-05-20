const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    compareJobRecordsByActiveTime,
    extractJobIdFromHref,
    findNextVisibleJobIndex,
    getActiveTimeTextFromJobData,
    getJobDataId,
    extractBossActiveTimeText,
    jobMatchesHiddenFilters,
    normalizeStoredRecordMap,
    normalizeCustomTagRecords,
    normalizeCustomTagList,
    parseBossSalaryMaxK,
    parseBossActiveTimeRank,
    reorderJobDataListBySortedRecords,
    serializeRecordMap,
    sortJobRecordsByActiveTime
} = require('./boss-zhipin-job-tools-core.cjs');

test('userscript metadata is bumped for page-world chat route diversion delivery', () => {
    const script = fs.readFileSync(path.join(__dirname, 'BOSS Zhipin Job Tools.user.js'), 'utf8');
    assert.match(script, /\/\/ @version\s+0\.1\.28\b/);
    assert.match(script, /const SCRIPT_VERSION = '0\.1\.28';/);
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
