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
    const sandbox = {
        module: { exports: {} },
        MANUAL_DETECTED_NUKE_STALE_RUNNING_MS: 120000,
        buildChainBlockNote: () => ({ blockReason: 'chain_mixed', blockNote: '' })
    };
    const baseNames = ['normalizeNukeTaskIds', 'mergeNukeTaskIds', 'getEntryNukeTaskIds'];
    const code = [
        extractFunction(source, 'normalizePromoHandle'),
        ...baseNames.map((name) => extractFunction(source, name)),
        ...names.filter((name) => !baseNames.includes(name)).map((name) => extractFunction(source, name)),
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
        getArticleEngagementCounts: () => ({ replies: 0, retweets: 0, likes: 0 }),
        getChainExemptHandlesForTarget: () => [],
        captureNukeTargetForImmediateHide: (article, trigger) => {
            sandbox.calls.push(`capture:${article.id}:${trigger.triggerId}`);
            return { authorHandle: article.id, trigger };
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

test('manual detected nuke task status shows hidden expected api and blocked counts', () => {
    const { formatManualDetectedNukeTaskStatus } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'getManualDetectedNukeTaskTweetIds',
        'getManualDetectedNukeTaskStats',
        'formatManualDetectedNukeTaskStatus'
    ]);
    const task = {
        hiddenTargets: 2,
        expectedBlockCount: 7,
        apiCollectedCount: 5,
        captures: [
            { tweetContext: { tweetId: 'tweet-1' } },
            { tweetContext: { tweetId: 'tweet-2' } }
        ]
    };
    const userData = {
        queue: [{ userId: 'queued-1', sourceTweetId: 'tweet-2' }],
        blockedLog: [{ userId: 'blocked-1', sourceTweetId: 'tweet-1' }, { userId: 'other', sourceTweetId: 'other' }]
    };

    const html = formatManualDetectedNukeTaskStatus(task, userData);

    assert.match(html, /已隐藏 2 个目标/);
    assert.match(html, /网页预期关联数（回复数\+转推数）: 7/);
    assert.match(html, /API 已发现关联数: 5/);
    assert.match(html, /已进入拉黑流程: 2/);
    assert.match(html, /已拉黑数量: 1 \/ 2（待处理 1）/);
});

test('manual detected task stats stay linked after the global block log is trimmed', () => {
    const { getManualDetectedNukeTaskStats } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'getManualDetectedNukeTaskTweetIds',
        'getManualDetectedNukeTaskStats'
    ]);
    const task = {
        taskId: 'task-a',
        hiddenTargets: 2,
        expectedBlockCount: 9,
        apiUserIds: ['api-1', 'api-2', 'api-3'],
        queuedUserIds: ['user-1', 'user-2', 'user-3', 'user-4'],
        blockedUserIds: ['user-1', 'user-2'],
        failedUserIds: ['user-4'],
        captures: [{ tweetContext: { tweetId: 'tweet-shared' } }]
    };
    const userData = {
        queue: [
            { userId: 'user-3', sourceTweetId: 'tweet-shared', nukeTaskIds: ['task-a'] },
            { userId: 'other-task-user', sourceTweetId: 'tweet-shared', nukeTaskIds: ['task-b'] }
        ],
        blockedLog: []
    };

    const stats = getManualDetectedNukeTaskStats(task, userData);

    assert.equal(stats.apiCollectedCount, 3);
    assert.equal(stats.workflowCount, 4);
    assert.equal(stats.queuedCount, 1);
    assert.equal(stats.blockedCount, 2);
    assert.equal(stats.failedCount, 1);
});

test('queue outcomes update every linked manual detected task', () => {
    const { recordManualDetectedNukeQueueOutcome } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'recordManualDetectedNukeQueueOutcome'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            { taskId: 'task-a' },
            { taskId: 'task-b', queuedUserIds: ['existing'] },
            { taskId: 'task-c' }
        ]
    };
    const entry = { userId: 'user-1', nukeTaskIds: ['task-a', 'task-b'] };

    assert.equal(recordManualDetectedNukeQueueOutcome(userData, entry, 'queued'), 2);
    assert.equal(recordManualDetectedNukeQueueOutcome(userData, entry, 'blocked'), 2);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].queuedUserIds), ['user-1']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].blockedUserIds), ['user-1']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[1].queuedUserIds), ['existing', 'user-1']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[1].blockedUserIds), ['user-1']);
    assert.equal(userData.manualDetectedNukeTasks[2].queuedUserIds, undefined);
});

test('merged queue entries retain all manual task links', () => {
    const { mergeQueueEntries } = loadHelpers([
        'mergeQueueEntries'
    ]);
    const merged = mergeQueueEntries(
        { userId: 'user-1', chainSources: ['reply'], nukeTaskIds: ['task-a'] },
        { userId: 'user-1', chainSources: ['retweet'], nukeTaskIds: ['task-b'] },
        { authorHandle: 'source' }
    );

    assert.deepEqual(Array.from(merged.nukeTaskIds), ['task-a', 'task-b']);
});

test('manual detected captures can be stored as a resumable nuke task', () => {
    const { createManualDetectedNukeTask } = loadHelpers([
        'getManualDetectedNukeTaskTweetIds',
        'sumManualDetectedExpectedBlockCount',
        'createManualDetectedNukeTask'
    ]);
    const capturedTargets = [
        {
            capture: {
                authorHandle: 'first',
                authorUserNameText: 'First',
                trigger: { autoReason: 'spam_identify' },
                tweetContext: { tweetId: 'tweet-1', tweetUrl: 'https://x.com/a/status/tweet-1' },
                engagementCounts: { replies: 3, retweets: 2, likes: 99 },
                chainExemptHandles: ['root']
            }
        },
        {
            capture: {
                authorHandle: 'second',
                authorUserNameText: 'Second',
                trigger: { autoReason: 'avatar_ocr' },
                tweetContext: { tweetId: 'tweet-2', tweetUrl: 'https://x.com/b/status/tweet-2' },
                engagementCounts: { replies: 1, retweets: 4, likes: 10 },
                chainExemptHandles: []
            }
        }
    ];

    const task = createManualDetectedNukeTask(capturedTargets, 1000);

    assert.equal(task.status, 'pending');
    assert.equal(task.hiddenTargets, 2);
    assert.equal(task.expectedBlockCount, 10);
    assert.equal(task.apiCollectedCount, 0);
    assert.deepEqual(Array.from(task.targetTweetIds), ['tweet-1', 'tweet-2']);
    assert.deepEqual(Array.from(task.captures, (capture) => capture.authorHandle), ['first', 'second']);
});

test('manual detected nuke status aggregates multiple active tasks', () => {
    const { getManualDetectedNukeTaskSummary, formatManualDetectedNukeTaskStatus } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'getManualDetectedNukeTaskTweetIds',
        'sumManualDetectedExpectedBlockCount',
        'getActiveManualDetectedNukeTasks',
        'getManualDetectedNukeTaskStats',
        'getManualDetectedNukeTaskSummary',
        'formatManualDetectedNukeTaskStatus'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            {
                status: 'running',
                hiddenTargets: 8,
                expectedBlockCount: 188,
                apiUserIds: ['u1'],
                captures: [{ tweetContext: { tweetId: 'tweet-1' } }]
            },
            {
                status: 'pending',
                hiddenTargets: 4,
                expectedBlockCount: 8,
                apiUserIds: ['u2', 'u1'],
                captures: [{ tweetContext: { tweetId: 'tweet-2' } }]
            },
            {
                status: 'complete',
                hiddenTargets: 99,
                expectedBlockCount: 99,
                apiUserIds: ['u3'],
                captures: [{ tweetContext: { tweetId: 'tweet-3' } }]
            }
        ],
        queue: [{ userId: 'queued-1', sourceTweetId: 'tweet-2' }],
        blockedLog: [{ userId: 'blocked-1', sourceTweetId: 'tweet-1' }, { userId: 'blocked-complete', sourceTweetId: 'tweet-3' }]
    };

    const summary = getManualDetectedNukeTaskSummary(userData);
    const html = formatManualDetectedNukeTaskStatus(summary, userData);

    assert.equal(summary.hiddenTargets, 12);
    assert.equal(summary.expectedBlockCount, 196);
    assert.equal(summary.apiCollectedCount, 2);
    assert.match(html, /已隐藏 12 个目标/);
    assert.match(html, /网页预期关联数（回复数\+转推数）: 196/);
    assert.match(html, /API 已发现关联数: 2/);
    assert.match(html, /已拉黑数量: 1 \/ 2（待处理 1）/);
});

test('manual detected nuke runner selects pending task instead of latest queued task', () => {
    const { getNextRunnableManualDetectedNukeTask } = loadHelpers([
        'getActiveManualDetectedNukeTasks',
        'getNextRunnableManualDetectedNukeTask'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            { taskId: 'queued-new', status: 'queued', updatedAt: 300, createdAt: 300 },
            { taskId: 'pending-old', status: 'pending', updatedAt: 100, createdAt: 100 },
            { taskId: 'paused-future', status: 'paused', retryAfter: Date.now() + 60000, updatedAt: 200, createdAt: 200 },
            { taskId: 'complete', status: 'complete', updatedAt: 400, createdAt: 400 }
        ]
    };

    assert.equal(getNextRunnableManualDetectedNukeTask(userData)?.taskId, 'pending-old');
    assert.equal(getNextRunnableManualDetectedNukeTask(userData, 'pending-old')?.taskId, 'pending-old');
});

test('manual detected nuke task is paused until shared api limit resets', () => {
    const { pauseManualDetectedNukeTaskForApiLimit, getManualDetectedNukeRetryDelay } = loadHelpers([
        'getActiveManualDetectedNukeTasks',
        'getManualDetectedNukeRetryDelay',
        'pauseManualDetectedNukeTaskForApiLimit'
    ]);
    const retryAt = Date.now() + 60000;
    const userData = {
        manualDetectedNukeTasks: [
            { taskId: 'running-task', status: 'running', retryAfter: 0, updatedAt: 100, createdAt: 100 }
        ]
    };

    const changed = pauseManualDetectedNukeTaskForApiLimit(userData.manualDetectedNukeTasks[0], { retryAt }, 1234);

    assert.equal(changed, true);
    assert.equal(userData.manualDetectedNukeTasks[0].status, 'paused');
    assert.equal(userData.manualDetectedNukeTasks[0].retryAfter, retryAt);
    assert.equal(userData.manualDetectedNukeTasks[0].updatedAt, 1234);
    assert.ok(getManualDetectedNukeRetryDelay(userData) > 0);
});

test('manual detected nuke migration leaves queued tasks with zero api users alone', () => {
    const { normalizeManualDetectedNukeTasks, getNextRunnableManualDetectedNukeTask } = loadHelpers([
        'getActiveManualDetectedNukeTasks',
        'shouldRetryQueuedManualDetectedNukeTask',
        'normalizeManualDetectedNukeTasks',
        'getNextRunnableManualDetectedNukeTask'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            {
                taskId: 'stale-queued',
                status: 'queued',
                expectedBlockCount: 188,
                apiCollectedCount: 0,
                targetTweetIds: ['tweet-1'],
                collectedTweetIds: [],
                updatedAt: 100,
                createdAt: 100
            },
            {
                taskId: 'stale-collected-marker',
                status: 'queued',
                expectedBlockCount: 188,
                apiCollectedCount: 0,
                targetTweetIds: ['tweet-2'],
                collectedTweetIds: ['tweet-2'],
                updatedAt: 200,
                createdAt: 200
            }
        ]
    };

    assert.equal(normalizeManualDetectedNukeTasks(userData), 0);
    assert.equal(userData.manualDetectedNukeTasks[0].status, 'queued');
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].collectedTweetIds), []);
    assert.equal(userData.manualDetectedNukeTasks[1].status, 'queued');
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[1].collectedTweetIds), ['tweet-2']);
    assert.equal(getNextRunnableManualDetectedNukeTask(userData), null);
});

test('manual detected nuke migration removes completed tasks', () => {
    const { normalizeManualDetectedNukeTasks } = loadHelpers([
        'getActiveManualDetectedNukeTasks',
        'shouldRetryQueuedManualDetectedNukeTask',
        'normalizeManualDetectedNukeTasks'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            {
                taskId: 'complete-task',
                status: 'complete'
            },
            {
                taskId: 'queued-task',
                status: 'queued'
            }
        ]
    };

    assert.equal(normalizeManualDetectedNukeTasks(userData), 1);

    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks, (task) => task.taskId), ['queued-task']);
});

test('manual detected nuke migration reruns stale running tasks with zero api users', () => {
    const { normalizeManualDetectedNukeTasks } = loadHelpers([
        'getActiveManualDetectedNukeTasks',
        'shouldRetryQueuedManualDetectedNukeTask',
        'normalizeManualDetectedNukeTasks'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            {
                taskId: 'stale-running',
                status: 'running',
                expectedBlockCount: 188,
                apiCollectedCount: 0,
                apiUserIds: [],
                targetTweetIds: ['tweet-1'],
                collectedTweetIds: ['tweet-1']
            }
        ]
    };

    normalizeManualDetectedNukeTasks(userData);

    assert.equal(userData.manualDetectedNukeTasks[0].status, 'pending');
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].collectedTweetIds), []);
});

test('manual detected nuke completion removes terminal tasks from storage', () => {
    const { completeFinishedManualDetectedNukeTasks } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'getManualDetectedNukeTaskTweetIds',
        'sumManualDetectedExpectedBlockCount',
        'getManualDetectedNukeTaskStats',
        'completeFinishedManualDetectedNukeTasks'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            { taskId: 'finished', status: 'queued', targetTweetIds: ['tweet-1'], hiddenTargets: 1, expectedBlockCount: 0, apiCollectedCount: 0 }
        ],
        queue: [],
        blockedLog: []
    };

    const completed = completeFinishedManualDetectedNukeTasks(userData);

    assert.equal(completed.taskId, 'finished');
    assert.equal(completed.status, 'complete');
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks), []);
});

test('manual detected chain collection can continue without resolved author id', () => {
    const { createManualDetectedCollectTarget } = loadHelpers([
        'createManualDetectedCollectTarget'
    ]);
    const capture = {
        authorHandle: 'target_user',
        authorUserNameText: 'Target',
        trigger: { autoReason: 'spam_identify' },
        tweetContext: {
            tweetId: 'tweet-42',
            tweetUrl: 'https://x.com/target_user/status/tweet-42',
            authorHandle: 'target_user',
            rootAuthorHandle: 'root_user'
        },
        engagementCounts: { replies: 2, retweets: 3, likes: 0 }
    };

    const target = createManualDetectedCollectTarget(capture);

    assert.equal(target.authorId, null);
    assert.equal(target.authorHandle, 'target_user');
    assert.equal(target.tweetContext.tweetId, 'tweet-42');
    assert.deepEqual(target.engagementCounts, { replies: 2, retweets: 3, likes: 0 });
});

test('manual detected chain collection targets do not wait for author resolution', () => {
    const { getManualDetectedChainCollectTargets } = loadHelpers([
        'createManualDetectedCollectTarget',
        'getManualDetectedChainCollectTargets'
    ]);
    const task = {
        collectedTweetIds: ['tweet-done'],
        captures: [
            {
                authorHandle: 'first_user',
                tweetContext: { tweetId: 'tweet-first', authorHandle: 'first_user' },
                engagementCounts: { replies: 4, retweets: 1, likes: 0 }
            },
            {
                authorHandle: 'already_done',
                tweetContext: { tweetId: 'tweet-done', authorHandle: 'already_done' },
                engagementCounts: { replies: 2, retweets: 0, likes: 0 }
            }
        ]
    };

    const targets = getManualDetectedChainCollectTargets(task);

    assert.deepEqual(Array.from(targets, (target) => target.tweetContext.tweetId), ['tweet-first']);
    assert.equal(targets[0].authorId, null);
    assert.equal(targets[0].manualOrder, 0);
});

test('manual detected positive-count tweet stays uncollected when api returns zero users', () => {
    const { shouldMarkManualDetectedTweetCollected } = loadHelpers([
        'getManualDetectedVisibleChainCount',
        'shouldMarkManualDetectedTweetCollected'
    ]);
    const target = {
        tweetContext: { tweetId: 'tweet-first' },
        engagementCounts: { replies: 4, retweets: 1, likes: 0 }
    };

    assert.equal(shouldMarkManualDetectedTweetCollected(target, 0, 3, 3), false);
    assert.equal(shouldMarkManualDetectedTweetCollected(target, 0, 3, 4), true);
    assert.equal(shouldMarkManualDetectedTweetCollected({ ...target, engagementCounts: { replies: 0, retweets: 0, likes: 0 } }, 0, 3, 3), true);
});

test('manual detected author queue still runs when only chain collection is incomplete', () => {
    const { shouldContinueManualDetectedAuthorQueue, getManualDetectedPostCollectStatus } = loadHelpers([
        'shouldContinueManualDetectedAuthorQueue',
        'getManualDetectedPostCollectStatus'
    ]);

    assert.equal(shouldContinueManualDetectedAuthorQueue(false), true);
    assert.equal(shouldContinueManualDetectedAuthorQueue(true), false);
    assert.equal(getManualDetectedPostCollectStatus(false, true), 'paused');
    assert.equal(getManualDetectedPostCollectStatus(false, false), 'queued');
    assert.equal(getManualDetectedPostCollectStatus(true, false), 'paused');
});

test('queue root protection does not skip detected source authors', () => {
    const { isQueueEntryProtectedRootAuthor } = loadHelpers([
        'isDirectManualRootQueueEntry',
        'isQueueEntryProtectedRootAuthor'
    ]);

    assert.equal(isQueueEntryProtectedRootAuthor({
        userId: 'target-id',
        screenName: 'target_user',
        sourceAuthorHandle: 'target_user',
        sourceRootAuthorId: 'root-id',
        sourceRootAuthorHandle: 'root_user',
        blockReason: 'auto_manual_detected'
    }), false);
    assert.equal(isQueueEntryProtectedRootAuthor({
        userId: 'root-id',
        screenName: 'root_user',
        sourceAuthorHandle: 'target_user',
        sourceRootAuthorId: 'root-id',
        sourceRootAuthorHandle: 'root_user',
        blockReason: 'auto_manual_detected'
    }), true);
    assert.equal(isQueueEntryProtectedRootAuthor({
        userId: 'root-id',
        screenName: 'root_user',
        sourceAuthorHandle: 'root_user',
        sourceRootAuthorId: 'root-id',
        sourceRootAuthorHandle: 'root_user',
        blockReason: 'manual_author'
    }), false);
});

test('api operation spacing uses the newest local or shared start time', () => {
    const { getApiOperationWaitMs } = loadHelpers([
        'getApiOperationWaitMs'
    ]);

    assert.equal(getApiOperationWaitMs(10_000, 12_000, 13_000, 5_000), 4_000);
    assert.equal(getApiOperationWaitMs(14_000, 12_000, 20_000, 5_000), 0);
});

test('unified toast entries update by id inside one panel list', () => {
    const { upsertUnifiedToastEntry } = loadHelpers([
        'upsertUnifiedToastEntry'
    ]);
    let entries = [];

    entries = upsertUnifiedToastEntry(entries, { id: 'nuke-status-toast', title: '队列', status: '待处理: 1' }, 100);
    entries = upsertUnifiedToastEntry(entries, { id: 'nuke-fetch-toast', title: '九族拉黑', status: '收集中' }, 200);
    entries = upsertUnifiedToastEntry(entries, { id: 'nuke-status-toast', title: '队列', status: '待处理: 2' }, 300);

    assert.deepEqual(Array.from(entries, (entry) => entry.id), ['nuke-status-toast', 'nuke-fetch-toast']);
    assert.equal(entries[0].status, '待处理: 2');
    assert.equal(entries[0].updatedAt, 300);
});

test('unified toast panel placement follows right sidebar width and edge', () => {
    const { getUnifiedToastPanelPlacement } = loadHelpers([
        'getUnifiedToastPanelPlacement'
    ]);

    const placement = getUnifiedToastPanelPlacement({ width: 350, right: 1220 }, 1280);

    assert.equal(placement.right, 60);
    assert.equal(placement.width, 350);
});

test('tweet detail user extraction unwraps visibility result tweets', () => {
    const { getUserResultFromTweetResults } = loadHelpers([
        'normalizeTimelineUserResult',
        'unwrapTimelineTweetResult',
        'getUserResultFromTweetResults'
    ]);
    const tweetResults = {
        result: {
            __typename: 'TweetWithVisibilityResults',
            tweet: {
                core: {
                    user_results: {
                        result: {
                            rest_id: 'user-42',
                            legacy: { screen_name: 'reply_user' }
                        }
                    }
                }
            }
        }
    };

    const user = getUserResultFromTweetResults(tweetResults);

    assert.equal(user.rest_id, 'user-42');
    assert.equal(user.legacy.screen_name, 'reply_user');
});

test('timeline user result keeps id_str users countable', () => {
    const { addTimelineUserResult } = loadHelpers([
        'normalizeTimelineUserResult',
        'getTimelineUserRestId',
        'addTimelineUserResult'
    ]);
    const users = new Map();
    const pageUsers = [];

    const added = addTimelineUserResult(users, pageUsers, { id_str: '123', legacy: { screen_name: 'id_str_user' } });

    assert.equal(added, true);
    assert.equal(users.get('123').rest_id, '123');
    assert.equal(pageUsers[0].rest_id, '123');
});
