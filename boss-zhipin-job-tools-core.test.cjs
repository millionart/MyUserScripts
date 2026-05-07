const test = require('node:test');
const assert = require('node:assert/strict');
const {
    compareJobRecordsByActiveTime,
    extractJobIdFromHref,
    findNextVisibleJobIndex,
    getActiveTimeTextFromJobData,
    getJobDataId,
    normalizeStoredRecordMap,
    parseBossActiveTimeRank,
    reorderJobDataListBySortedRecords,
    serializeRecordMap,
    sortJobRecordsByActiveTime
} = require('./boss-zhipin-job-tools-core.cjs');

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
    assert.equal(parseBossActiveTimeRank('2周前活跃'), 20160);
    assert.equal(parseBossActiveTimeRank('1个月前活跃'), 43200);
    assert.equal(parseBossActiveTimeRank('未知'), Number.MAX_SAFE_INTEGER);
});

test('uses loaded job data online flag as an active-time hint', () => {
    assert.equal(getActiveTimeTextFromJobData({ bossOnline: true }), '在线');
    assert.equal(getActiveTimeTextFromJobData({ bossOnline: false }), '');
    assert.equal(getActiveTimeTextFromJobData(null), '');
    assert.equal(getJobDataId({ encryptJobId: ' job-a ' }), 'job-a');
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
