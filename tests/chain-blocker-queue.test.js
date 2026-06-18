const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'X.com Chain Blocker.fixed.user.js');

function extractFunction(source, name) {
    const marker = `function ${name}`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < source.length; i += 1) {
        const char = source[i];
        if (char === '{') depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`Could not extract function ${name}`);
}

function loadHelpers(names) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const sandbox = { module: { exports: {} } };
    const code = [
        extractFunction(source, 'normalizePromoHandle'),
        ...names.map((name) => extractFunction(source, name)),
        `module.exports = { ${names.join(', ')} };`
    ].join('\n');
    vm.runInNewContext(code, sandbox);
    return sandbox.module.exports;
}

function loadAutoBlockDecisionHelpers() {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const sandbox = { module: { exports: {} } };
    const code = [
        'const DEFAULT_USERNAME_RULE_FOLLOWER_EXEMPT_THRESHOLD = 1000;',
        "const scriptConfig = { blockKeywordsStandard: ['看我主页'], usernameRuleFollowerExemptThreshold: 1000 };",
        extractFunction(source, 'matchesStandardKeywords'),
        extractFunction(source, 'matchesBuiltInDisplayNameSpam'),
        extractFunction(source, 'getUsernameRuleFollowerExemptThreshold'),
        extractFunction(source, 'getAutoBlockDecision'),
        'module.exports = { getAutoBlockDecision };'
    ].join('\n');
    vm.runInNewContext(code, sandbox);
    return sandbox.module.exports;
}

function loadManualCaptureHelpers() {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const sandbox = {
        module: { exports: {} },
        calls: [],
        isDetectedNukeTargetArticle: (article) => article.detected,
        buildManualDetectedNukeTrigger: (article) => ({ triggerId: article.id }),
        captureNukeTargetForImmediateHide: (article, trigger) => {
            sandbox.calls.push(`capture:${article.id}:${trigger.triggerId}`);
        }
    };
    const code = [
        extractFunction(source, 'captureManualDetectedNukeTargets'),
        'module.exports = { captureManualDetectedNukeTargets, calls };'
    ].join('\n');
    vm.runInNewContext(code, sandbox);
    return sandbox.module.exports;
}

test('pending hidden users are deduplicated and refreshed by id or handle', () => {
    const { mergePendingHiddenUserEntries } = loadHelpers(['getHiddenUserStorageKey', 'mergePendingHiddenUserEntries']);
    const merged = mergePendingHiddenUserEntries([
        { userId: '1', screenName: 'old_name', userNameText: 'Old', addedAt: 10, lastSeenAt: 10 }
    ], [
        { userId: '1', screenName: '@New_Name', userNameText: 'New', sourceTweetId: 'tweet-2' },
        { screenName: '@HandleOnly', userNameText: 'Handle Only', sourceTweetId: 'tweet-3' }
    ], 99);

    assert.equal(merged.length, 2);
    assert.deepEqual(Array.from(merged, (entry) => entry.screenName), ['new_name', 'handleonly']);
    assert.equal(merged[0].addedAt, 10);
    assert.equal(merged[0].lastSeenAt, 99);
    assert.equal(merged[0].sourceTweetId, 'tweet-2');
});

test('hidden release queue removes truly blocked users from pending hidden users', () => {
    const { queueHiddenUserRelease, applyHiddenUserReleaseQueue } = loadHelpers([
        'getHiddenUserStorageKey',
        'getHiddenUserStorageKeys',
        'mergePendingHiddenUserEntries',
        'queueHiddenUserRelease',
        'applyHiddenUserReleaseQueue'
    ]);
    const userData = {
        pendingHiddenUsers: [
            { userId: '1', screenName: 'one' },
            { userId: '2', screenName: 'two' },
            { screenName: 'handleonly' }
        ],
        hiddenReleaseQueue: []
    };

    queueHiddenUserRelease(userData, { userId: '2', screenName: 'two' }, 200);
    queueHiddenUserRelease(userData, { screenName: '@HandleOnly' }, 201);
    const released = applyHiddenUserReleaseQueue(userData);

    assert.equal(released, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(userData.pendingHiddenUsers)), [{ userId: '1', screenName: 'one' }]);
    assert.deepEqual(JSON.parse(JSON.stringify(userData.hiddenReleaseQueue)), []);
});

test('hidden release queue can release handle-only pending entries after id is resolved', () => {
    const { queueHiddenUserRelease, applyHiddenUserReleaseQueue } = loadHelpers([
        'getHiddenUserStorageKey',
        'getHiddenUserStorageKeys',
        'mergePendingHiddenUserEntries',
        'queueHiddenUserRelease',
        'applyHiddenUserReleaseQueue'
    ]);
    const userData = {
        pendingHiddenUsers: [
            { screenName: 'resolved_later' },
            { screenName: 'still_pending' }
        ],
        hiddenReleaseQueue: []
    };

    queueHiddenUserRelease(userData, { userId: '42', screenName: '@Resolved_Later' }, 300);
    const released = applyHiddenUserReleaseQueue(userData);

    assert.equal(released, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(userData.pendingHiddenUsers)), [{ screenName: 'still_pending' }]);
});

test('username keyword match still blocks when follower count is unknown', () => {
    const { getAutoBlockDecision } = loadAutoBlockDecisionHelpers();

    const decision = getAutoBlockDecision('真实 幂幂（腰软 主人看我主页简介', null);

    assert.equal(decision.block, true);
    assert.equal(decision.reason, 'standard_keywords');
});

test('username keyword match is exempt only when visible or cached follower count exceeds threshold', () => {
    const { getAutoBlockDecision } = loadAutoBlockDecisionHelpers();

    const exemptDecision = getAutoBlockDecision('真实 幂幂（腰软 主人看我主页简介', 1001);
    assert.equal(exemptDecision.block, false);
    assert.equal(exemptDecision.reason, 'follower_exempt');
    assert.equal(exemptDecision.followerCount, 1001);
    assert.equal(exemptDecision.exemptThreshold, 1000);
    assert.equal(getAutoBlockDecision('真实 幂幂（腰软 主人看我主页简介', 1000).block, true);
});

test('chain list collection is skipped when visible engagement count is zero', () => {
    const { shouldCollectChainSourceFromCounts } = loadHelpers(['shouldCollectChainSourceFromCounts']);
    const counts = { replies: 0, retweets: 0, likes: 0 };

    assert.equal(shouldCollectChainSourceFromCounts(counts, 'reply'), false);
    assert.equal(shouldCollectChainSourceFromCounts(counts, 'retweet'), false);
    assert.equal(shouldCollectChainSourceFromCounts(counts, 'like'), false);
    assert.equal(shouldCollectChainSourceFromCounts({ replies: null, retweets: null, likes: null }, 'reply'), true);
});

test('visible follower count text parser handles compact Chinese and English counts', () => {
    const { getVisibleFollowerCountFromText } = loadHelpers(['parseCompactEngagementCount', 'getVisibleFollowerCountFromText']);

    assert.equal(getVisibleFollowerCountFromText('1.2万 粉丝'), 12000);
    assert.equal(getVisibleFollowerCountFromText('Followers 3.4K'), 3400);
    assert.equal(getVisibleFollowerCountFromText('4 回复 3 转推'), null);
});

test('manual detected nuke captures every detected target before background resolution', () => {
    const { captureManualDetectedNukeTargets, calls } = loadManualCaptureHelpers();
    const articles = [
        { id: 'first', detected: true, dataset: {} },
        { id: 'second', detected: true, dataset: {} },
        { id: 'ignored', detected: false, dataset: {} }
    ];
    const userData = {};

    const jobs = captureManualDetectedNukeTargets(articles, userData);

    assert.deepEqual(calls, ['capture:first:first', 'capture:second:second']);
    assert.deepEqual(Array.from(jobs, (job) => job.article.id), ['first', 'second']);
    assert.equal(articles[0].dataset.autoblockTriggered, 'true');
    assert.equal(articles[1].dataset.autoblockTriggered, 'true');
    assert.equal(articles[2].dataset.autoblockTriggered, undefined);
});

test('manual detected button is disabled only during capture or when no targets exist', () => {
    const { shouldDisableManualDetectedNukeButton } = loadHelpers(['shouldDisableManualDetectedNukeButton']);

    assert.equal(shouldDisableManualDetectedNukeButton(true, 2), true);
    assert.equal(shouldDisableManualDetectedNukeButton(false, 0), true);
    assert.equal(shouldDisableManualDetectedNukeButton(false, 2), false);
});
