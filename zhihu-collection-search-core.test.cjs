const test = require('node:test');
const assert = require('node:assert/strict');
const {
    collectionNeedsReindex,
    extractCollectionList,
    extractCollectionMetaFromText,
    extractCollectionMeta,
    extractItemRecord,
    findCollectionsNeedingIndex,
    getImmediatePositioningEvents,
    getResultPanelProtectedEvents,
    getResultPanelUserCloseTriggers,
    makeIndexButtonLabel,
    makeIndexProgressText,
    makeResultTabLabel,
    selectVisibleSearchAnchor,
    shouldCloseResultPanelFromClick,
    shouldUpdateText,
    sumCollectionItemCount,
    searchRecords
} = require('./zhihu-collection-search-core.cjs');

test('marks collection stale when item count or update time changes', () => {
    const cached = {
        itemCount: 19,
        updatedTime: 1710000000
    };

    assert.equal(collectionNeedsReindex(cached, { itemCount: 19, updatedTime: 1710000000 }), false);
    assert.equal(collectionNeedsReindex(cached, { itemCount: 20, updatedTime: 1710000000 }), true);
    assert.equal(collectionNeedsReindex(cached, { itemCount: 19, updatedTime: 1710001234 }), true);
    assert.equal(collectionNeedsReindex({ itemCount: 19 }, { itemCount: 19, updatedTime: 1710000000 }), true);
});

test('extracts created collection IDs from member favlists response', () => {
    const response = {
        data: [
            { id: 31464743, type: 'collection', title: '软件应用' },
            { id: 0, type: 'people', title: 'ignored' },
            { id: 587415866, type: 'collection', title: 'Unreal' }
        ]
    };

    assert.deepEqual(extractCollectionList(response), [
        { id: '31464743', title: '软件应用' },
        { id: '587415866', title: 'Unreal' }
    ]);
});

test('extracts collection metadata from detail API response', () => {
    const meta = extractCollectionMeta({
        collection: {
            id: 31464743,
            title: '软件应用',
            item_count: 91,
            updated_time: 1775327916
        }
    });

    assert.deepEqual(meta, {
        id: '31464743',
        title: '软件应用',
        itemCount: 91,
        updatedTime: 1775327916
    });
});

test('extracts collection metadata from rendered collection row text', () => {
    const meta = extractCollectionMetaFromText({
        id: '31464743',
        title: '软件应用',
        detailText: '软件应用 2026-04-05 更新 · 91 条内容 · 0 人关注 添加评论 编辑 删除'
    });

    assert.equal(meta.id, '31464743');
    assert.equal(meta.title, '软件应用');
    assert.equal(meta.itemCount, 91);
    assert.equal(meta.updatedTime, 1775318400);
});

test('returns null when rendered row text does not contain collection count and update date', () => {
    assert.equal(extractCollectionMetaFromText({
        id: '31464743',
        title: '软件应用',
        detailText: '正在加载'
    }), null);
});

test('extracts searchable text from zhihu collection item content', () => {
    const record = extractItemRecord({
        collectionId: '123',
        collectionTitle: '技术文章',
        item: {
            content: {
                type: 'answer',
                url: 'https://www.zhihu.com/question/1/answer/2',
                question: { title: '如何学习 Unreal Engine?' },
                content: '<p>先理解渲染管线，再做项目。</p><figure><img src="x"></figure>'
            },
            created_time: 1710000000
        }
    });

    assert.equal(record.title, '如何学习 Unreal Engine?');
    assert.equal(record.url, 'https://www.zhihu.com/question/1/answer/2');
    assert.equal(record.collectionTitle, '技术文章');
    assert.match(record.text, /渲染管线/);
    assert.doesNotMatch(record.text, /<p>/);
});

test('searches title and body and returns highlighted snippets with collection names', () => {
    const records = [
        {
            id: 'a',
            title: 'UE 材质系统',
            text: '这篇文章介绍 PBR、纹理采样和材质实例。',
            url: 'https://example.com/a',
            collectionTitle: 'Unreal'
        },
        {
            id: 'b',
            title: 'JavaScript 笔记',
            text: '事件循环和 Promise。',
            url: 'https://example.com/b',
            collectionTitle: 'Web'
        }
    ];

    const results = searchRecords(records, '材质 pbr');

    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'UE 材质系统');
    assert.equal(results[0].collectionTitle, 'Unreal');
    assert.match(results[0].snippet, /PBR/);
});

test('formats result tab label without status parentheses', () => {
    assert.equal(makeResultTabLabel('缓存已是最新'), '全文搜索我的收藏夹');
    assert.equal(makeResultTabLabel('全文索引 4/7'), '全文搜索我的收藏夹');
});

test('finds stale collections from metadata without requiring item fetches', () => {
    const cached = [
        { id: 'a', ownerToken: 'jack-frost', itemCount: 2, updatedTime: 100 },
        { id: 'b', ownerToken: 'jack-frost', itemCount: 4, updatedTime: 200 },
        { id: 'c', ownerToken: 'other-user', itemCount: 8, updatedTime: 300 }
    ];
    const current = [
        { id: 'a', itemCount: 2, updatedTime: 100 },
        { id: 'b', itemCount: 5, updatedTime: 200 },
        { id: 'c', itemCount: 8, updatedTime: 301 },
        { id: 'd', itemCount: 1, updatedTime: 400 }
    ];

    assert.deepEqual(findCollectionsNeedingIndex(cached, current, 'jack-frost').map((item) => item.id), ['b', 'c', 'd']);
});

test('shows pending update count on the index button without marking it as active indexing', () => {
    assert.equal(makeIndexButtonLabel({ syncing: true, pendingCount: 3 }), '索引中');
    assert.equal(makeIndexButtonLabel({ syncing: false, pendingCount: 3 }), '更新 3 个');
    assert.equal(makeIndexButtonLabel({ syncing: false, pendingCount: 0 }), '全文索引');
});

test('summarizes background indexing as simple xx/yy progress', () => {
    const collections = [
        { id: 'a', itemCount: 2 },
        { id: 'b', itemCount: 5 }
    ];

    assert.equal(sumCollectionItemCount(collections), 7);
    assert.equal(makeIndexProgressText('checking', 3, 19), '检查收藏夹 3/19');
    assert.equal(makeIndexProgressText('indexing', 4, 7), '全文索引 4/7');
});

test('selects visible main collection search input when hidden duplicate appears first', () => {
    const hiddenHeaderInput = {
        id: 'header',
        insideMain: false,
        rect: { width: 0, height: 0 }
    };
    const visibleMainInput = {
        id: 'main',
        insideMain: true,
        rect: { width: 240, height: 32 }
    };

    assert.equal(selectVisibleSearchAnchor([hiddenHeaderInput, visibleMainInput]), visibleMainInput);
    assert.equal(selectVisibleSearchAnchor([hiddenHeaderInput]), null);
});

test('does not rewrite unchanged UI text', () => {
    assert.equal(shouldUpdateText('全文搜索我的收藏夹', '全文搜索我的收藏夹'), false);
    assert.equal(shouldUpdateText('收藏夹搜索结果(2)', '全文搜索我的收藏夹'), true);
});

test('uses scroll and resize as immediate positioning triggers', () => {
    assert.deepEqual(getImmediatePositioningEvents(), ['scroll', 'resize']);
});

test('only allows the result panel close button as a user close trigger', () => {
    assert.deepEqual(getResultPanelUserCloseTriggers(), ['close-button']);
});

test('keeps the result panel open for all clicks except the close button', () => {
    assert.equal(shouldCloseResultPanelFromClick({ closestCloseButton: true }), true);
    assert.equal(shouldCloseResultPanelFromClick({ closestCloseButton: false, insidePanelHeader: true }), false);
    assert.equal(shouldCloseResultPanelFromClick({ closestCloseButton: false, insidePanelSearch: true }), false);
    assert.equal(shouldCloseResultPanelFromClick({ closestCloseButton: false, insideBackdrop: true }), false);
});

test('guards every pointer-like panel event so blank header clicks cannot bubble out', () => {
    assert.deepEqual(getResultPanelProtectedEvents(), [
        'pointerdown',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'touchstart'
    ]);
});
