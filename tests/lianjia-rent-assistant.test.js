const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CONTENT_FILTER_HOST_LABEL,
    DEFAULT_FILTER_STATE,
    buildPageUrl,
    classifyListingContent,
    extractMapPointFromDetailHtml,
    fetchWithTimeout,
    filterMapRecordsByState,
    filterNewListingKeys,
    getAutoFetchNextPage,
    getAutoFetchRetryDelay,
    getListingDetailUrl,
    getListingKey,
    getSearchCacheRecords,
    hydrateMapRecordsFromCache,
    markAutoFetchCaptchaRetry,
    markAutoFetchPageFetched,
    mergeMapCacheRecords,
    normalizeAutoFetchState,
    normalizeFilterState,
    normalizeMapPoint,
    parseStoredMapCache,
    releaseQueuedMapRecordKeys,
    resetAutoFetchRetry,
    serializeFilterState,
    shouldShowListing
} = require('../Lianjia Rent Assistant.user.js');

const script = fs.readFileSync(path.join(__dirname, '..', 'Lianjia Rent Assistant.user.js'), 'utf8');

test('userscript metadata uses a general assistant name', () => {
    assert.match(script, /@name\s+Lianjia Rent Assistant/);
    assert.match(script, /@name:zh-CN\s+链家租房助手/);
});

test('default content filters show all listings', () => {
    assert.deepEqual(DEFAULT_FILTER_STATE, { beikePreferred: true, apartment: true });
    assert.deepEqual(normalizeFilterState(null), DEFAULT_FILTER_STATE);
    assert.deepEqual(normalizeFilterState({}), DEFAULT_FILTER_STATE);
});

test('content filter controls are hosted in the brand row', () => {
    assert.equal(CONTENT_FILTER_HOST_LABEL, '品牌');
});

test('filter state normalizes and serializes JSON-compatible values', () => {
    const state = normalizeFilterState({ beikePreferred: false, apartment: true, ignored: false });

    assert.deepEqual(state, { beikePreferred: false, apartment: true });
    assert.equal(serializeFilterState(state), '{"beikePreferred":false,"apartment":true}');
    assert.deepEqual(normalizeFilterState(JSON.parse(serializeFilterState(state))), state);
});

test('pagination URL templates resolve relative next-page URLs', () => {
    assert.equal(
        buildPageUrl(
            '/ditiezufang/li99620692s99635743/pg{page}rco21/',
            2,
            'https://sh.lianjia.com/ditiezufang/li99620692s99635743/rco21/'
        ),
        'https://sh.lianjia.com/ditiezufang/li99620692s99635743/pg2rco21/'
    );
});

test('listing keys prefer stable house codes and skip duplicates', () => {
    assert.equal(getListingKey({ houseCode: 'SH123', hrefs: ['/zufang/SH123.html'] }), 'house:SH123');
    assert.equal(getListingKey({ houseCode: '', hrefs: ['/zufang/SH456.html'] }), 'href:/zufang/SH456.html');

    const seen = new Set(['house:SH123']);
    assert.deepEqual(
        filterNewListingKeys([
            { houseCode: 'SH123', hrefs: ['/zufang/SH123.html'] },
            { houseCode: 'SH456', hrefs: ['/zufang/SH456.html'] },
            { houseCode: 'SH456', hrefs: ['/zufang/SH456-copy.html'] }
        ], seen),
        ['house:SH456']
    );
});

test('listing detail URLs are normalized for rent detail pages', () => {
    assert.equal(
        getListingDetailUrl({ hrefs: ['/zufang/SH2176197223874822144.html', '/zufang/'] }, 'https://sh.lianjia.com/zufang/'),
        'https://sh.lianjia.com/zufang/SH2176197223874822144.html'
    );
    assert.equal(
        getListingDetailUrl({ hrefs: ['https://sh.lianjia.com/apartment/109456.html'] }, 'https://sh.lianjia.com/ditiezufang/'),
        'https://sh.lianjia.com/apartment/109456.html'
    );
});

test('map points are normalized and bounded to China coordinates', () => {
    assert.deepEqual(
        normalizeMapPoint({ longitude: '121.905235', latitude: '30.905494' }),
        { longitude: 121.905235, latitude: 30.905494 }
    );
    assert.equal(normalizeMapPoint({ longitude: '0', latitude: '0' }), null);
});

test('detail HTML map points are extracted from standard and apartment templates', () => {
    assert.deepEqual(
        extractMapPointFromDetailHtml("g_conf.coord = { longitude: '121.905235', latitude: '30.905494' };"),
        { longitude: 121.905235, latitude: 30.905494 }
    );
    assert.deepEqual(
        extractMapPointFromDetailHtml('{"latitude":"31.24969822332007","longitude":"121.28041761711265","apartment_name":"纪王大街店"}'),
        { longitude: 121.28041761711265, latitude: 31.24969822332007 }
    );
});

test('detail fetch aborts when the response hangs', async () => {
    let abortSignal;

    await assert.rejects(async () => Promise.race([
        fetchWithTimeout('https://sh.lianjia.com/zufang/SH1.html', { credentials: 'same-origin' }, 5, (url, options) => new Promise((resolve, reject) => {
            abortSignal = options.signal;
            abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        })),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('test timeout')), 50))
    ]), /aborted/);

    assert.equal(abortSignal.aborted, true);
});

test('map cache parsing keeps valid cached listing records only', () => {
    assert.deepEqual(
        parseStoredMapCache(JSON.stringify({
            version: 1,
            listings: {
                'house:SH1': {
                    key: 'house:SH1',
                    detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
                    title: '整租·缓存房源',
                    price: '3000 元/月',
                    point: { longitude: '121.4', latitude: '31.2' },
                    updatedAt: 123
                },
                broken: { key: '', detailUrl: '' }
            }
        })),
        {
            version: 1,
            listings: {
                'house:SH1': {
                    key: 'house:SH1',
                    detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
                    title: '整租·缓存房源',
                    price: '3000 元/月',
                    point: { longitude: 121.4, latitude: 31.2 },
                    updatedAt: 123
                }
            }
        }
    );
});

test('streamed listing records merge into map cache without losing coordinates', () => {
    const cache = parseStoredMapCache({
        listings: {
            'house:SH1': {
                key: 'house:SH1',
                detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
                title: '旧标题',
                price: '2900 元/月',
                point: { longitude: 121.4, latitude: 31.2 },
                updatedAt: 1
            }
        }
    });

    assert.deepEqual(
        mergeMapCacheRecords(cache, [{
            key: 'house:SH1',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
            title: '新标题',
            price: '3000 元/月'
        }, {
            key: 'house:SH2',
            detailUrl: 'https://sh.lianjia.com/zufang/SH2.html',
            title: '新增房源',
            price: '2500 元/月'
        }], 99),
        {
            version: 1,
            listings: {
                'house:SH1': {
                    key: 'house:SH1',
                    detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
                    title: '新标题',
                    price: '3000 元/月',
                    point: { longitude: 121.4, latitude: 31.2 },
                    updatedAt: 99
                },
                'house:SH2': {
                    key: 'house:SH2',
                    detailUrl: 'https://sh.lianjia.com/zufang/SH2.html',
                    title: '新增房源',
                    price: '2500 元/月',
                    updatedAt: 99
                }
            }
        }
    );
});

test('map records hydrate cached coordinates before detail fetches', () => {
    const cache = parseStoredMapCache({
        listings: {
            'house:SH1': {
                key: 'house:SH1',
                detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
                title: '缓存标题',
                price: '3000 元/月',
                point: { longitude: 121.4, latitude: 31.2 },
                updatedAt: 1
            }
        }
    });

    assert.deepEqual(
        hydrateMapRecordsFromCache([{
            key: 'house:SH1',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
            title: '当前标题',
            price: '3100 元/月'
        }, {
            key: 'house:SH2',
            detailUrl: 'https://sh.lianjia.com/zufang/SH2.html',
            title: '未缓存房源',
            price: '2500 元/月'
        }], cache),
        [{
            key: 'house:SH1',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
            title: '当前标题',
            price: '3100 元/月',
            point: { longitude: 121.4, latitude: 31.2 },
            updatedAt: 1
        }, {
            key: 'house:SH2',
            detailUrl: 'https://sh.lianjia.com/zufang/SH2.html',
            title: '未缓存房源',
            price: '2500 元/月'
        }]
    );
});

test('captcha pause releases pending map queue keys for retry', () => {
    const queuedKeys = new Set(['house:active', 'house:pending1', 'house:pending2']);

    releaseQueuedMapRecordKeys(queuedKeys, [
        { key: 'house:pending1' },
        { key: 'house:pending2' }
    ]);

    assert.deepEqual(Array.from(queuedKeys), ['house:active']);
});

test('auto fetch state defaults off and stores per-search progress', () => {
    assert.deepEqual(normalizeAutoFetchState(null), { enabled: false, progress: {} });
    assert.deepEqual(
        normalizeAutoFetchState(JSON.stringify({ enabled: true, progress: { '/zufang/pg{page}/': '3', broken: 'x' } })),
        { enabled: true, progress: { '/zufang/pg{page}/': 3 } }
    );
});

test('auto fetch next page resumes from the larger current or cached page', () => {
    const state = normalizeAutoFetchState({ enabled: true, progress: { '/zufang/pg{page}/': 4 } });

    assert.equal(getAutoFetchNextPage(state, '/zufang/pg{page}/', 1, 10), 5);
    assert.equal(getAutoFetchNextPage(state, '/zufang/pg{page}/', 6, 10), 7);
    assert.equal(getAutoFetchNextPage(state, '/zufang/pg{page}/', 10, 10), 0);
});

test('auto fetch progress marks the highest fetched page only', () => {
    assert.deepEqual(
        markAutoFetchPageFetched({ enabled: true, progress: { search: 5 } }, 'search', 3),
        { enabled: true, progress: { search: 5 } }
    );
    assert.deepEqual(
        markAutoFetchPageFetched({ enabled: true, progress: { search: 5 } }, 'search', 6),
        { enabled: true, progress: { search: 6 } }
    );
});

test('auto fetch captcha retry waits 20 seconds and keeps the toggle enabled', () => {
    assert.equal(getAutoFetchRetryDelay({ retryCount: 0 }), 20000);
    assert.equal(getAutoFetchRetryDelay({ retryCount: 1 }), 20000);
    assert.equal(getAutoFetchRetryDelay({ retryCount: 2 }), 20000);
    assert.equal(getAutoFetchRetryDelay({ retryCount: 6 }), 20000);

    assert.deepEqual(
        markAutoFetchCaptchaRetry({ enabled: true, progress: { search: 4 }, retryCount: 1 }),
        { enabled: true, progress: { search: 4 }, retryCount: 2 }
    );
});

test('auto fetch retry count resets after a successful fetch', () => {
    assert.deepEqual(
        resetAutoFetchRetry({ enabled: true, progress: { search: 4 }, retryCount: 2 }),
        { enabled: true, progress: { search: 4 } }
    );
});

test('search cache records return cached listings for the active search', () => {
    const cache = mergeMapCacheRecords(parseStoredMapCache(null), [{
        key: 'house:SH1',
        detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
        title: '本搜索房源',
        price: '3000 元/月',
        point: { longitude: 121.4, latitude: 31.2 },
        kinds: { beikePreferred: false, apartment: false }
    }, {
        key: 'house:SH2',
        detailUrl: 'https://sh.lianjia.com/zufang/SH2.html',
        title: '其他搜索房源',
        price: '2500 元/月',
        point: { longitude: 121.5, latitude: 31.3 },
        kinds: { beikePreferred: false, apartment: true }
    }], 99, '/zufang/pg{page}/');

    assert.deepEqual(
        getSearchCacheRecords(cache, '/zufang/pg{page}/', { beikePreferred: true, apartment: false }),
        [{
            key: 'house:SH1',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
            title: '本搜索房源',
            price: '3000 元/月',
            point: { longitude: 121.4, latitude: 31.2 },
            kinds: { beikePreferred: false, apartment: false },
            searchKeys: ['/zufang/pg{page}/'],
            updatedAt: 99
        }]
    );
});

test('auto fetch skips map records hidden by current content filters', () => {
    assert.deepEqual(
        filterMapRecordsByState([{
            key: 'house:SH1',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
            title: '普通房源',
            price: '3000 元/月',
            kinds: { beikePreferred: false, apartment: false }
        }, {
            key: 'house:SH2',
            detailUrl: 'https://sh.lianjia.com/apartment/SH2.html',
            title: '公寓房源',
            price: '2500 元/月',
            kinds: { beikePreferred: false, apartment: true }
        }, {
            key: 'house:SH3',
            detailUrl: 'https://sh.lianjia.com/zufang/SH3.html',
            title: '贝壳优选',
            price: '3200 元/月',
            kinds: { beikePreferred: true, apartment: false }
        }], { beikePreferred: false, apartment: false }),
        [{
            key: 'house:SH1',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
            title: '普通房源',
            price: '3000 元/月',
            kinds: { beikePreferred: false, apartment: false }
        }]
    );
});

test('listing classification catches Beike preferred and apartment markers', () => {
    assert.deepEqual(
        classifyListingContent({
            text: '整租·徐泾北城欣沁苑东区 贝壳优选 3780 元/月',
            hrefs: ['/zufang/SH2172678357441839104.html']
        }),
        { beikePreferred: true, apartment: false }
    );

    assert.deepEqual(
        classifyListingContent({
            text: '独栋·壹间公寓 虹桥公馆壹间C 1室1厅',
            hrefs: ['/apartment/64659.html']
        }),
        { beikePreferred: false, apartment: true }
    );
});

test('unchecked content options hide matching listings only', () => {
    const hideApartment = normalizeFilterState({ beikePreferred: true, apartment: false });
    const hidePreferred = normalizeFilterState({ beikePreferred: false, apartment: true });

    assert.equal(shouldShowListing({ beikePreferred: false, apartment: true }, hideApartment), false);
    assert.equal(shouldShowListing({ beikePreferred: true, apartment: false }, hideApartment), true);
    assert.equal(shouldShowListing({ beikePreferred: true, apartment: false }, hidePreferred), false);
    assert.equal(shouldShowListing({ beikePreferred: false, apartment: false }, hidePreferred), true);
});
