const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'X.com Chain Blocker.fixed.user.js');

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const signatureEnd = source.indexOf(') {', start);
    const braceStart = signatureEnd >= 0 ? signatureEnd + 2 : source.indexOf('{', start);
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
        BLOCK_RETRY_BASE_MS: 30000,
        BLOCK_RETRY_MAX_MS: 300000,
        BLOCK_RETRY_MAX_ATTEMPTS: 4,
        AVATAR_OCR_ENGINE_OFF: 'off',
        AVATAR_OCR_ENGINE_PADDLE: 'paddle',
        AVATAR_OCR_ENGINE_TESSERACT: 'tesseract',
        currentUserId: 'self',
        buildChainBlockNote: () => ({ blockReason: 'chain_mixed', blockNote: '' })
    };
    const baseNames = [
        'normalizeNukeTaskIds',
        'mergeNukeTaskIds',
        'getEntryNukeTaskIds',
        'sumManualDetectedExpectedBlockCount',
        'isManualDetectedCaptureAuthorPending',
        'getManualDetectedPendingAuthorCaptures',
        'getManualDetectedNukeTaskPipelineStats'
    ];
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

function loadSpamDetector() {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const constLine = (name) => {
        const start = source.indexOf(`const ${name} = `);
        if (start < 0) throw new Error(`Missing constant ${name}`);
        return source.slice(start, source.indexOf('\n', start));
    };
    const signalStart = source.indexOf('const SPAM_SIGNAL_DEFS = [');
    const signalEnd = source.indexOf('\n];', signalStart);
    const helperNames = [
        'isShortDatingInviteCompact',
        'hasStandaloneDd',
        'extractSpamEmojiChars',
        'spamEmojiBucket',
        'isEmojiOnlyBaitText',
        'isShortLocationInviteCompact',
        'isPetRoleInviteCompact',
        'isAdultEndorsementContextCompact',
        'isIncidentClipFunnelCompact',
        'isAdultPlatformClipFunnelCompact',
        'normalizeSpamText',
        'compactSpamText',
        'compactSpamTextVariants',
        'detectSpamReply'
    ];
    const code = [
        'const DEFAULT_SPAM_IDENTIFY_MIN_SCORE = 3;',
        'const scriptConfig = { spamIdentifyMinScore: 3 };',
        constLine('SPAM_ZERO_WIDTH_RE'),
        constLine('SPAM_CJK_PUNCT_RE'),
        constLine('SPAM_ASCII_NOISE_BETWEEN_CJK_RE'),
        ...helperNames.slice(0, 10).map((name) => extractFunction(source, name)),
        source.slice(signalStart, signalEnd + 3),
        ...helperNames.slice(10).map((name) => extractFunction(source, name)),
        'module.exports = { detectSpamReply };'
    ].join('\n');
    const sandbox = { module: { exports: {} } };
    vm.runInNewContext(code, sandbox);
    return sandbox.module.exports.detectSpamReply;
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
        captureNukeTargetForImmediateHide: (article, trigger, userData, options) => {
            sandbox.calls.push(`capture:${article.id}:${trigger.triggerId}:${options?.deferPageHide ? 'deferred' : 'immediate'}`);
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

test('completed articles are not requeued by unrelated page mutations', () => {
    const { shouldQueueArticleForDetection } = loadHelpers(['shouldQueueArticleForDetection']);

    assert.equal(shouldQueueArticleForDetection({ isConnected: true, dataset: { autoblockChecked: 'complete', spamScanned: 'complete' } }), false);
    assert.equal(shouldQueueArticleForDetection({ isConnected: true, dataset: { autoblockChecked: 'complete', avatarOcrPending: 'true' } }), false);
    assert.equal(shouldQueueArticleForDetection({ isConnected: true, dataset: {} }), true);
    assert.equal(shouldQueueArticleForDetection({ isConnected: false, dataset: {} }), false);
});

test('incremental detection batches deduplicate and ignore detached articles', () => {
    const { selectDetectionScanArticles } = loadHelpers([
        'shouldQueueArticleForDetection',
        'selectDetectionScanArticles'
    ]);
    const pending = { id: 'pending', isConnected: true, dataset: {} };
    const complete = { id: 'complete', isConnected: true, dataset: { autoblockChecked: 'complete', spamScanned: 'complete' } };
    const detached = { id: 'detached', isConnected: false, dataset: {} };
    const extra = { id: 'extra', isConnected: true, dataset: {} };

    assert.deepEqual(Array.from(selectDetectionScanArticles([pending, pending, complete, detached], [], false), (item) => item.id), ['pending']);
    assert.deepEqual(Array.from(selectDetectionScanArticles([pending], [complete, extra, pending], true), (item) => item.id), ['extra', 'pending']);
});

test('detection safety scan no longer runs every two seconds', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const interval = Number(source.match(/const DETECTION_SAFETY_INTERVAL_MS = (\d+)\s*\*?\s*(\d+)?/)?.[1]);

    assert.ok(interval >= 10000);
});

test('avatar OCR cache separates engines and keyword sets', () => {
    const { getAvatarOcrCacheKey } = loadHelpers(['normalizeAvatarOcrEngine', 'getAvatarOcrCacheKey']);

    assert.notEqual(
        getAvatarOcrCacheKey('https://pbs.twimg.com/a.jpg', ['全国安排'], 'tesseract'),
        getAvatarOcrCacheKey('https://pbs.twimg.com/a.jpg', ['全国安排'], 'paddle')
    );
    assert.notEqual(
        getAvatarOcrCacheKey('https://pbs.twimg.com/a.jpg', ['全国安排'], 'tesseract'),
        getAvatarOcrCacheKey('https://pbs.twimg.com/a.jpg', ['点击主页'], 'tesseract')
    );
});

test('successful negative avatar OCR results are reusable', () => {
    const { isReusableAvatarOcrCacheEntry } = loadHelpers(['isReusableAvatarOcrCacheEntry']);
    const now = 100000;

    assert.equal(isReusableAvatarOcrCacheEntry({ at: now - 1000, result: { match: false, ocrOk: true } }, now, 30000), true);
    assert.equal(isReusableAvatarOcrCacheEntry({ at: now - 1000, result: { match: false, ocrOk: false } }, now, 30000), false);
    assert.equal(isReusableAvatarOcrCacheEntry({ at: now - 40000, result: { match: true, ocrOk: true } }, now, 30000), false);
});

test('automatic avatar OCR is limited to articles near the viewport', () => {
    const { isArticleNearOcrViewport } = loadHelpers(['isArticleNearOcrViewport']);
    const article = (top, bottom, isConnected = true) => ({ isConnected, getBoundingClientRect: () => ({ top, bottom }) });

    assert.equal(isArticleNearOcrViewport(article(100, 300), 800, 400), true);
    assert.equal(isArticleNearOcrViewport(article(1000, 1200), 800, 100), false);
    assert.equal(isArticleNearOcrViewport(article(-500, -300), 800, 100), false);
    assert.equal(isArticleNearOcrViewport(article(100, 300, false), 800, 400), false);
});

test('Paddle OCR does not secretly run Tesseract and image IDs are absent', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const paddleSource = extractFunction(source, 'recognizeAvatarWithPaddleBrowser');

    assert.doesNotMatch(paddleSource, /recognizeAvatarWithTesseract/);
    assert.doesNotMatch(source, /function extractTwitterProfileImageId/);
});

test('current X user id is parsed from the twid cookie', () => {
    const { parseTwidUserId } = loadHelpers(['parseTwidUserId']);

    assert.equal(parseTwidUserId('ct0=abc; twid=u%3D15331808; lang=zh-cn'), '15331808');
    assert.equal(parseTwidUserId('twid="u=42"'), '42');
    assert.equal(parseTwidUserId('ct0=abc'), '');
});

test('GraphQL user wrappers normalize ids and core screen names', () => {
    const { getNormalizedUserIdentity } = loadHelpers([
        'normalizeTimelineUserResult',
        'getTimelineUserRestId',
        'getUserScreenNameFromResult',
        'getNormalizedUserIdentity'
    ]);
    const identity = getNormalizedUserIdentity({
        result: {
            user: {
                rest_id: '99',
                core: { screen_name: 'CoreName' },
                legacy: { name: 'Display Name' }
            }
        }
    });

    assert.equal(identity.userId, '99');
    assert.equal(identity.screenName, 'corename');
});

test('TweetDetail uses the live X operation and GraphQL errors are not empty timelines', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const endpointStart = source.indexOf('API_ENDPOINTS.TweetDetail = {');
    const endpointEnd = source.indexOf('\n};', endpointStart);
    const endpointSource = source.slice(endpointStart, endpointEnd + 3);
    const { getGraphqlErrorMessage } = loadHelpers(['getGraphqlErrorMessage']);

    assert.match(endpointSource, /hash: 'jd3V43oDY9cY7obs1YMfbQ'/);
    assert.match(endpointSource, /"withArticleSummaryText":true/);
    assert.equal(getGraphqlErrorMessage({ errors: [{ message: 'PersistedQueryNotFound' }] }), 'PersistedQueryNotFound');
    assert.equal(getGraphqlErrorMessage({ data: {} }), '');
});

test('UserByScreenName uses the live X profile operation', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const userLookupSource = extractFunction(source, 'getUserDataByScreenName');

    assert.match(source, /UserByScreenName:\s*\{ hash: '2qvSHpkWTMS9i0zJAwDNiA'/);
    assert.match(source, /UserByScreenName:[^\n]+"withAuxiliaryUserLabels":true/);
    assert.match(userLookupSource, /withGrokTranslatedBio:true/);
    assert.doesNotMatch(userLookupSource, /withSafetyModeUserFields/);
});

test('profile bio lookup waits for its real request instead of leaking it after a local timeout', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const cachedLookupSource = extractFunction(source, 'getCachedProfileBioUserData');

    assert.doesNotMatch(cachedLookupSource, /withProfileBioTimeout/);
    assert.doesNotMatch(source, /function withProfileBioTimeout/);
});

test('automatic profile bio scans defer articles outside the nearby viewport', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const scheduleSource = extractFunction(source, 'scheduleProfileBioScanForArticle');
    const processSource = extractFunction(source, 'processSpamArticle');

    assert.match(scheduleSource, /document\.hidden \|\| !isArticleNearOcrViewport\(article\)/);
    assert.match(scheduleSource, /deferProfileBioUntilNearViewport/);
    assert.match(processSource, /scheduleProfileBioScanForArticle/);
    assert.doesNotMatch(processSource, /enqueueProfileBioScan\(article/);
});

test('userscript initialization is single-flight and registers its menu once', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const initializeSource = extractFunction(source, 'initialize');
    const retrySource = extractFunction(source, 'scheduleInitializeRetry');
    const menuSource = extractFunction(source, 'updateMenuCommands');

    assert.match(source, /initializeRunning\s*=\s*false/);
    assert.match(initializeSource, /if \(initializeRunning\) return/);
    assert.match(initializeSource, /ensureUserscriptBootstrap/);
    assert.match(initializeSource, /scheduleInitializeRetry/);
    assert.doesNotMatch(initializeSource, /setTimeout\(initialize, 500\)/);
    assert.match(retrySource, /if \(initializeRetryTimeoutId\) return/);
    assert.match(menuSource, /if \(menuCommandRegistered\) return/);
});

test('closing a dialog releases its resize and drag resources', () => {
    const { closeDialogSurface } = loadHelpers(['closeDialogSurface']);
    const calls = [];
    const surface = {
        open: true,
        _nukeDialogCleanup: () => calls.push('cleanup'),
        close: () => calls.push('close'),
        remove: () => calls.push('remove')
    };

    closeDialogSurface(surface);

    assert.deepEqual(calls, ['cleanup', 'close', 'remove']);
});

test('manual detected author resolution puts zero-engagement targets first', () => {
    const { sortManualDetectedCapturesForAuthorResolution } = loadHelpers([
        'isZeroEngagementNukeTarget',
        'sortManualDetectedCapturesForAuthorResolution'
    ]);
    const captures = [
        { authorHandle: 'busy-first', engagementCounts: { replies: 2, retweets: 1, likes: 4 } },
        { authorHandle: 'zero-first', engagementCounts: { replies: 0, retweets: 0, likes: 0 } },
        { authorHandle: 'chain-only', status: 'chain_only', engagementCounts: { replies: 0, retweets: 0, likes: 0 } },
        { authorHandle: 'zero-second', engagementCounts: { replies: 0, retweets: 0, likes: 0 } },
        { authorHandle: 'busy-second', engagementCounts: { replies: 1, retweets: 0, likes: 0 } }
    ];

    const ordered = sortManualDetectedCapturesForAuthorResolution(captures);

    assert.deepEqual(Array.from(ordered, (capture) => capture.authorHandle), ['zero-first', 'zero-second', 'busy-first', 'busy-second']);
});

test('priority queue keeps detected authors ahead of collected chain users', () => {
    const { insertNukeQueueEntryByPriority } = loadHelpers([
        'getNukeQueueEntryPriority',
        'insertNukeQueueEntryByPriority'
    ]);
    const userData = {
        queue: [
            { userId: 'chain-old', queuePriority: 10, queuedAt: 1 },
            { userId: 'chain-new', queuePriority: 10, queuedAt: 2 }
        ]
    };

    insertNukeQueueEntryByPriority(userData, { userId: 'author-normal', queuePriority: 1 }, 20);
    insertNukeQueueEntryByPriority(userData, { userId: 'author-zero', queuePriority: 0 }, 30);

    assert.deepEqual(Array.from(userData.queue, (entry) => entry.userId), ['author-zero', 'author-normal', 'chain-old', 'chain-new']);
});

test('queue retries transient block failures without stalling runnable users', () => {
    const { scheduleBlockQueueRetry, getNextRunnableQueueEntryIndex } = loadHelpers([
        'isApiRateLimitError',
        'isApiTimeoutError',
        'isRetryableBlockError',
        'getBlockRetryDelayMs',
        'scheduleBlockQueueRetry',
        'getNextRunnableQueueEntryIndex'
    ]);
    const delayed = { userId: 'retry-me', blockAttempts: 0 };

    assert.equal(scheduleBlockQueueRetry(delayed, { status: 503 }, 1000), true);
    assert.equal(delayed.blockAttempts, 1);
    assert.ok(delayed.retryAfter > 1000);
    assert.equal(getNextRunnableQueueEntryIndex([delayed, { userId: 'ready' }], 1001), 1);
    assert.equal(scheduleBlockQueueRetry({ userId: 'bad-request' }, { status: 400 }, 1000), false);
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

    const jobs = captureManualDetectedNukeTargets(articles, userData, { deferPageHide: true });

    assert.deepEqual(calls, ['capture:first:first:deferred', 'capture:second:second:deferred']);
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

test('manual batch hide anchors the viewport to the nearest unaffected tweet', () => {
    const { selectManualDetectedViewportAnchor } = loadHelpers([
        'getManualDetectedViewportAnchorDistance',
        'selectManualDetectedViewportAnchor'
    ]);
    const article = (id, handle, rect) => ({ id, handle, isConnected: true, getBoundingClientRect: () => rect });
    const articles = [
        article('hidden', 'target', { top: 10, bottom: 110, height: 100 }),
        article('near', 'safe', { top: 140, bottom: 240, height: 100 }),
        article('far', 'other', { top: 900, bottom: 1000, height: 100 })
    ];

    const anchor = selectManualDetectedViewportAnchor(articles, new Set(['target']), 800, (item) => item.handle);

    assert.equal(anchor.id, 'near');
});

test('manual detected execution batches page hiding and restores its viewport anchor', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const executeSource = extractFunction(source, 'executeManualNukeForDetectedTargets');
    const captureSource = extractFunction(source, 'captureNukeTargetForImmediateHide');

    assert.match(executeSource, /deferPageHide: true/);
    assert.match(executeSource, /captureManualDetectedViewportState\(hiddenHandles\)/);
    assert.match(executeSource, /hideArticlesByHandles\(hiddenHandles\)/);
    assert.match(executeSource, /restoreManualDetectedViewportState\(viewportState\)/);
    assert.match(captureSource, /!options\.deferPageHide/);
});

test('panel toggle remains available with a panel and shifts above the manual button', () => {
    const { getUnifiedToastPanelToggleLabel } = loadHelpers([
        'getUnifiedToastPanelToggleLabel'
    ]);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const toggleSource = extractFunction(source, 'ensureUnifiedToastPanelToggleButton');

    assert.equal(getUnifiedToastPanelToggleLabel(false), '收起队列面板');
    assert.equal(getUnifiedToastPanelToggleLabel(true), '展开队列面板');
    assert.match(source, /#nuke-toast-panel-toggle-button\.nuke-toast-panel-toggle-with-manual\{bottom:213px\}/);
    assert.match(source, /#nuke-toast-panel\.nuke-toast-panel-collapsed\{display:none!important\}/);
    assert.match(source, /#nuke-toast-panel\{[^}]*z-index:10/);
    assert.match(source, /#nuke-manual-detected-nuke-button,#nuke-toast-panel-toggle-button\{[^}]*z-index:10/);
    assert.match(source, /body:has\(\[role="dialog"\]\[aria-modal="true"\]\)[^}]*visibility:hidden!important;pointer-events:none!important/);
    assert.match(toggleSource, /nuke-manual-detected-nuke-button/);
    assert.match(toggleSource, /!manualButton && !panel/);
    assert.match(toggleSource, /nuke-toast-panel-toggle-with-manual/);
    assert.match(toggleSource, /aria-controls/);
});

test('manual task panel is hidden after both list-building stages reach zero', () => {
    const { shouldShowManualDetectedNukeTaskToast } = loadHelpers([
        'getManualDetectedNukeTaskTweetIds',
        'getManualDetectedNukeTaskStats',
        'shouldShowManualDetectedNukeTaskToast'
    ]);
    const userData = { queue: [], blockedLog: [] };
    const pendingTask = {
        status: 'running',
        captures: [{ status: 'pending', tweetContext: { tweetId: 'pending' }, engagementCounts: { replies: 1, retweets: 0 } }]
    };
    const transferredTask = {
        status: 'queued',
        collectedTweetIds: ['done'],
        captures: [{ status: 'resolved', tweetContext: { tweetId: 'done' }, engagementCounts: { replies: 1, retweets: 0 } }]
    };

    assert.equal(shouldShowManualDetectedNukeTaskToast(pendingTask, userData), true);
    assert.equal(shouldShowManualDetectedNukeTaskToast(transferredTask, userData), false);
});

test('manual detected nuke task status leaves queue execution progress to the global status', () => {
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
        collectedTweetIds: ['tweet-1'],
        captures: [
            { status: 'resolved', tweetContext: { tweetId: 'tweet-1' }, engagementCounts: { replies: 4, retweets: 1 } },
            { status: 'pending', tweetContext: { tweetId: 'tweet-2' }, engagementCounts: { replies: 1, retweets: 1 } }
        ]
    };
    const userData = {
        queue: [{ userId: 'queued-1', sourceTweetId: 'tweet-2' }],
        blockedLog: [{ userId: 'blocked-1', sourceTweetId: 'tweet-1' }, { userId: 'other', sourceTweetId: 'other' }]
    };

    const html = formatManualDetectedNukeTaskStatus(task, userData);

    assert.match(html, /待移交目标: 1/);
    assert.match(html, /待收集回复\/转推: 约 2/);
    assert.doesNotMatch(html, /已隐藏|API 发现/);
    assert.doesNotMatch(html, /拉黑进度/);
    assert.doesNotMatch(html, /待处理/);
});

test('paused manual capture describes background retry without disabling manual action', () => {
    const { getManualDetectedNukeTaskTitle, shouldDisableManualDetectedNukeButton } = loadHelpers([
        'getManualDetectedNukeTaskTitle',
        'shouldDisableManualDetectedNukeButton'
    ]);
    const source = fs.readFileSync(sourcePath, 'utf8');

    assert.equal(getManualDetectedNukeTaskTitle('paused'), '后台列表等待重试');
    assert.equal(shouldDisableManualDetectedNukeButton(false, 2), false);
    assert.doesNotMatch(source, /手动执行已暂停/);
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

test('manual detected task terminal counts exclude users that were requeued', () => {
    const { getManualDetectedNukeTaskStats } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'getManualDetectedNukeTaskTweetIds',
        'getManualDetectedNukeTaskStats'
    ]);
    const workflowIds = Array.from({ length: 8 }, (_, index) => `user-${index + 1}`);
    const task = {
        taskId: 'task-a',
        hiddenTargets: 0,
        expectedBlockCount: 0,
        apiCollectedCount: 0,
        queuedUserIds: workflowIds,
        failedUserIds: workflowIds
    };
    const userData = {
        queue: workflowIds.slice(0, 6).map((userId) => ({ userId, nukeTaskIds: ['task-a'] })),
        blockedLog: []
    };

    const stats = getManualDetectedNukeTaskStats(task, userData);

    assert.equal(stats.workflowCount, 8);
    assert.equal(stats.queuedCount, 6);
    assert.equal(stats.failedCount, 2);
    assert.equal(stats.blockedCount + stats.queuedCount + stats.failedCount + stats.skippedCount, stats.workflowCount);
});

test('queue outcomes update every linked manual detected task', () => {
    const { recordManualDetectedNukeQueueOutcome } = loadHelpers([
        'normalizeNukeTaskIds',
        'getEntryNukeTaskIds',
        'recordManualDetectedNukeQueueOutcome'
    ]);
    const userData = {
        manualDetectedNukeTasks: [
            { taskId: 'task-a', failedUserIds: ['user-1'] },
            { taskId: 'task-b', queuedUserIds: ['existing'] },
            { taskId: 'task-c' }
        ]
    };
    const entry = { userId: 'user-1', nukeTaskIds: ['task-a', 'task-b'] };

    assert.equal(recordManualDetectedNukeQueueOutcome(userData, entry, 'queued'), 2);
    assert.equal(recordManualDetectedNukeQueueOutcome(userData, entry, 'blocked'), 2);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].queuedUserIds), ['user-1']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].blockedUserIds), ['user-1']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].failedUserIds), []);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[1].queuedUserIds), ['existing', 'user-1']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[1].blockedUserIds), ['user-1']);
    assert.equal(userData.manualDetectedNukeTasks[2].queuedUserIds, undefined);
});

test('terminal block failures are discarded from active task stats but stay locally hidden', () => {
    const { discardTerminalManualDetectedNukeFailures } = loadHelpers([
        'discardTerminalManualDetectedNukeFailures'
    ]);
    const userData = {
        queue: [{ userId: 'retrying' }],
        blockedLog: [{ userId: 'blocked' }],
        pendingHiddenUsers: [{ userId: 'terminal' }],
        manualDetectedNukeTasks: [{
            taskId: 'task-a',
            queuedUserIds: ['terminal', 'retrying', 'blocked'],
            failedUserIds: ['terminal', 'retrying', 'blocked']
        }]
    };

    assert.equal(discardTerminalManualDetectedNukeFailures(userData), 1);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].queuedUserIds), ['retrying', 'blocked']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].failedUserIds), ['retrying', 'blocked']);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].discardedUserIds), ['terminal']);
    assert.deepEqual(Array.from(userData.pendingHiddenUsers, (entry) => entry.userId), ['terminal']);
});

test('terminal failures cannot re-enter the same nuke task but a new task may retry them', () => {
    const { isQueueEntryDiscardedForLinkedTask, selectNewChainQueueEntries } = loadHelpers([
        'isQueueEntryDiscardedForLinkedTask',
        'selectNewChainQueueEntries'
    ]);
    const userData = {
        queue: [],
        blockedLog: [],
        manualDetectedNukeTasks: [
            { taskId: 'old-task', discardedUserIds: ['terminal'] },
            { taskId: 'new-task', discardedUserIds: [] }
        ]
    };
    const oldEntry = { userId: 'terminal', screenName: 'retry_me', nukeTaskIds: ['old-task'] };
    const newEntry = { ...oldEntry, nukeTaskIds: ['new-task'] };

    assert.equal(isQueueEntryDiscardedForLinkedTask(userData, oldEntry), true);
    assert.equal(isQueueEntryDiscardedForLinkedTask(userData, newEntry), false);
    assert.deepEqual(Array.from(selectNewChainQueueEntries(userData, new Map([['terminal', oldEntry]]), new Set(), [])), []);
    assert.deepEqual(Array.from(selectNewChainQueueEntries(userData, new Map([['terminal', newEntry]]), new Set(), []), (entry) => entry.userId), ['terminal']);
});

test('API failures retain structured X error details', () => {
    const { getApiResponseErrorMessage } = loadHelpers(['getApiResponseErrorMessage']);

    assert.equal(
        getApiResponseErrorMessage(404, JSON.stringify({ errors: [{ code: 50, message: 'User not found.' }] })),
        'API请求失败: 404 - User not found. (50)'
    );
    assert.equal(getApiResponseErrorMessage(403, '<html>nope</html>'), 'API请求失败: 403');
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

test('manual detected nuke status aggregates remaining pipeline stages', () => {
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
                collectedTweetIds: ['tweet-1'],
                captures: [{ status: 'resolved', tweetContext: { tweetId: 'tweet-1' }, engagementCounts: { replies: 180, retweets: 8 } }]
            },
            {
                status: 'pending',
                hiddenTargets: 4,
                expectedBlockCount: 8,
                apiUserIds: ['u2', 'u1'],
                captures: [{ status: 'pending', tweetContext: { tweetId: 'tweet-2' }, engagementCounts: { replies: 5, retweets: 3 } }]
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
    assert.match(html, /待移交目标: 1/);
    assert.match(html, /待收集回复\/转推: 约 8/);
    assert.doesNotMatch(html, /已隐藏|API 发现/);
    assert.doesNotMatch(html, /拉黑进度/);
    assert.doesNotMatch(html, /待处理/);
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
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].collectedTweetIds), ['tweet-1']);
});

test('legacy paused collection resumes once without losing completed pipeline stages', () => {
    const { normalizeManualDetectedNukeTasks } = loadHelpers([
        'shouldRetryQueuedManualDetectedNukeTask',
        'normalizeManualDetectedNukeTasks'
    ]);
    const userData = {
        manualDetectedNukeTasks: [{
            taskId: 'legacy-paused',
            status: 'paused',
            retryAfter: Date.now() + 300000,
            collectedTweetIds: ['tweet-done']
        }]
    };

    assert.equal(normalizeManualDetectedNukeTasks(userData), 1);
    assert.equal(userData.manualDetectedNukeTasks[0].status, 'pending');
    assert.equal(userData.manualDetectedNukeTasks[0].retryAfter, 0);
    assert.deepEqual(Array.from(userData.manualDetectedNukeTasks[0].collectedTweetIds), ['tweet-done']);
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

test('successful empty chain response completes the collection stage', () => {
    const { shouldMarkManualDetectedTweetCollected } = loadHelpers([
        'shouldMarkManualDetectedTweetCollected'
    ]);
    const target = {
        tweetContext: { tweetId: 'tweet-first' },
        engagementCounts: { replies: 4, retweets: 1, likes: 0 }
    };
    const source = fs.readFileSync(sourcePath, 'utf8');
    const runnerSource = extractFunction(source, 'processManualDetectedNukeBackground');

    assert.equal(shouldMarkManualDetectedTweetCollected(target), true);
    assert.equal(shouldMarkManualDetectedTweetCollected({ tweetContext: {} }), false);
    assert.match(runnerSource, /getManualDetectedPendingAuthorCaptures\(task\)/);
    assert.doesNotMatch(runnerSource, /API 本轮返回 0|chainCollectionIncomplete/);
});

test('manual detected pipeline pauses only for real api failures', () => {
    const { shouldContinueManualDetectedAuthorQueue, getManualDetectedPostCollectStatus } = loadHelpers([
        'shouldContinueManualDetectedAuthorQueue',
        'getManualDetectedPostCollectStatus'
    ]);

    assert.equal(shouldContinueManualDetectedAuthorQueue(false), true);
    assert.equal(shouldContinueManualDetectedAuthorQueue(true), false);
    assert.equal(getManualDetectedPostCollectStatus(false), 'queued');
    assert.equal(getManualDetectedPostCollectStatus(true), 'paused');
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

test('old queue entries recover root-author protection from stored captures', () => {
    const { backfillQueueRootAuthorProtection, isQueueEntryProtectedRootAuthor } = loadHelpers([
        'backfillQueueRootAuthorProtection',
        'isDirectManualRootQueueEntry',
        'isQueueEntryProtectedRootAuthor'
    ]);
    const userData = {
        queue: [
            { userId: 'root-id', screenName: 'root_user', sourceTweetId: 'tweet-1', blockReason: 'chain_reply' },
            { userId: 'reply-id', screenName: 'reply_user', sourceTweetId: 'tweet-1', blockReason: 'chain_reply' }
        ],
        nukeCaptures: [
            { tweetContext: { tweetId: 'tweet-1', rootAuthorId: 'root-id', rootAuthorHandle: 'root_user' } }
        ],
        manualDetectedNukeTasks: []
    };

    assert.equal(backfillQueueRootAuthorProtection(userData), 2);
    assert.equal(isQueueEntryProtectedRootAuthor(userData.queue[0]), true);
    assert.equal(isQueueEntryProtectedRootAuthor(userData.queue[1]), false);
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

test('unified toast panel keeps sidebar width and anchors beside its toggle', () => {
    const { getUnifiedToastPanelPlacement } = loadHelpers([
        'getUnifiedToastPanelPlacement'
    ]);

    const placement = getUnifiedToastPanelPlacement(
        { width: 350, right: 1220 },
        1280,
        { left: 1205, bottom: 600 },
        813
    );

    assert.equal(placement.right, 87);
    assert.equal(placement.bottom, 213);
    assert.equal(placement.width, 350);
    assert.match(extractFunction(fs.readFileSync(sourcePath, 'utf8'), 'syncUnifiedToastPanelPlacement'), /document\.documentElement\.clientWidth/);
});

test('queue countdown uses block pacing api limits and entry retries', () => {
    const { getNextQueueActionAt, formatQueueCountdown } = loadHelpers([
        'getNextQueueActionAt',
        'formatQueueCountdown'
    ]);
    const now = 20_000;
    const queue = [{ userId: 'one' }, { userId: 'two', retryAfter: 80_000 }];

    assert.equal(getNextQueueActionAt({ queue, lastBlockTimestamp: 10_000 }, null, now, 60_000), 70_000);
    assert.equal(getNextQueueActionAt({ queue, lastBlockTimestamp: 10_000 }, { retryAt: 90_000 }, now, 60_000), 90_000);
    assert.equal(getNextQueueActionAt({ queue: [{ retryAfter: 80_000 }, { retryAfter: 95_000 }], lastBlockTimestamp: 0 }, null, now, 60_000), 80_000);
    assert.equal(formatQueueCountdown(85_000, now), '01:05');
    assert.equal(formatQueueCountdown(now, now), '00:00');
});

test('every real block attempt starts the pacing countdown, including failed requests', () => {
    const { markBlockAttemptStarted } = loadHelpers(['markBlockAttemptStarted']);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const processQueueSource = extractFunction(source, 'processQueue');
    const makeApiRequestSource = extractFunction(source, 'makeApiRequest');
    const userData = { lastBlockTimestamp: 10 };

    assert.equal(markBlockAttemptStarted(userData, 1234), 1234);
    assert.equal(userData.lastBlockTimestamp, 1234);
    assert.match(processQueueSource, /blockUserById\(userToBlock\.userId, \(\) => markBlockAttemptStarted\(userData\)\)/);
    assert.doesNotMatch(processQueueSource, /userData\.lastBlockTimestamp = Date\.now\(\)/);
    assert.match(makeApiRequestSource, /onStart\?\.\(\)/);
});

test('panel and toast dynamic values are escaped by default', () => {
    const { escapeHtml, trustedToastHtml, getToastContent } = loadHelpers([
        'escapeHtml',
        'trustedToastHtml',
        'getToastContent'
    ]);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const listRendererSource = extractFunction(source, 'renderListsInPanel');
    const showToastSource = extractFunction(source, 'showToast');
    const malicious = `<img src=x onerror='alert(1)'>"&`;

    assert.equal(escapeHtml(malicious), '&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&quot;&amp;');
    const plain = getToastContent(malicious);
    assert.equal(plain.html, null);
    assert.equal(plain.text, malicious);
    const trusted = getToastContent(trustedToastHtml('<b>2</b>'));
    assert.equal(trusted.html, '<b>2</b>');
    assert.equal(trusted.text, '');
    assert.match(listRendererSource, /const userName = escapeHtml\(/);
    assert.match(listRendererSource, /encodeURIComponent\(rawScreenName\)/);
    assert.match(showToastSource, /titleEl\.textContent/);
    assert.match(showToastSource, /statusEl\.textContent/);
    assert.doesNotMatch(showToastSource, /toast\.innerHTML/);
});

test('spam detection combines general links and adult endorsement context', () => {
    const detectSpamReply = loadSpamDetector();
    const linkFunnel = detectSpamReply('06女大真的花样多啊\n有点炸裂呢够劲嘻嘻\n\nhttp://t.cn/AXoHAs3g');
    const mentionFunnel = detectSpamReply('应该没人比她玩的开了吧 Pj真极品 2W @clarab198013');
    const genericLink = detectSpamReply('女高花样不少，点开看看 https://example.org/a');

    assert.equal(linkFunnel.match, true);
    assert.ok(Array.from(linkFunnel.signals, (signal) => signal.id).includes('external_link'));
    assert.equal(mentionFunnel.match, true);
    assert.equal(genericLink.match, true);
    assert.equal(detectSpamReply('女大学生分享社团活动，花样很多，这场比赛很炸裂').match, false);
    assert.equal(detectSpamReply('这个开源项目玩法多，真极品 @developer').match, false);
    assert.equal(detectSpamReply('123').match, false);
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
