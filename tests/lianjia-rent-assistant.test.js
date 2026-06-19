const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CONTENT_FILTER_HOST_LABEL,
    COORDINATE_SOURCE_OPTIONS,
    DEFAULT_COORDINATE_SOURCE,
    DEFAULT_FILTER_STATE,
    DEFAULT_TIMING_SETTINGS,
    AUTO_FETCH_PAGE_DELAY_MS,
    MAP_DETAIL_FETCH_DELAY_MS,
    buildGeocodeQuery,
    buildInfoWindowHtml,
    buildPageUrl,
    classifyListingContent,
    clearMapOverlaysIfPresent,
    extractMapPointFromDetailHtml,
    extractPreviewImageFromDetailHtml,
    fetchWithTimeout,
    filterMapRecordsByState,
    filterNewListingKeys,
    getAutoFetchNextPage,
    getAutoFetchRetryDelay,
    getAutoFetchRetryStatusText,
    getAutoFetchPageDelay,
    getCoordinateSourceSequence,
    getListingDetailUrl,
    getListingKeyFromDetailUrl,
    getListingKey,
    getMapQueueWaitMs,
    isSubwaySwitchLinkText,
    getSearchCacheRecords,
    hydrateMapRecordsFromCache,
    markAutoFetchCaptchaRetry,
    markAutoFetchPageFetched,
    mergeMapCacheRecords,
    normalizeAutoFetchState,
    normalizeCoordinateSource,
    normalizePreviewImageUrl,
    normalizeSubwayStationLinkHref,
    normalizeTimingSettings,
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
    assert.deepEqual(DEFAULT_FILTER_STATE, { beikePreferred: true, apartment: true, guessYouLike: true });
    assert.deepEqual(normalizeFilterState(null), DEFAULT_FILTER_STATE);
    assert.deepEqual(normalizeFilterState({}), DEFAULT_FILTER_STATE);
});

test('content filter controls are hosted in the brand row', () => {
    assert.equal(CONTENT_FILTER_HOST_LABEL, '品牌');
});

test('automatic fetching waits 4 seconds between requests', () => {
    assert.equal(AUTO_FETCH_PAGE_DELAY_MS, 4000);
    assert.equal(MAP_DETAIL_FETCH_DELAY_MS, 4000);
    assert.deepEqual(DEFAULT_TIMING_SETTINGS, {
        autoFetchPageDelayMs: 4000,
        mapDetailFetchDelayMs: 4000,
        captchaRetryDelayMs: 20000
    });
});

test('map coordinate queue keeps the 4 second window across repeated wakeups', () => {
    assert.equal(getMapQueueWaitMs({
        activeFetches: 0,
        blocked: false,
        lastMapFetchFinishedAt: 1000,
        pendingRecords: [{ key: 'house:SH1' }]
    }, 1000), 4000);
    assert.equal(getMapQueueWaitMs({
        activeFetches: 0,
        blocked: false,
        lastMapFetchFinishedAt: 1000,
        pendingRecords: [{ key: 'house:SH1' }]
    }, 5000), 0);
    assert.equal(getMapQueueWaitMs({
        activeFetches: 1,
        blocked: false,
        lastMapFetchFinishedAt: 1000,
        pendingRecords: [{ key: 'house:SH1' }]
    }, 1000), null);
});

test('map coordinate queue stops when automatic fetching is disabled', () => {
    assert.equal(getMapQueueWaitMs({
        activeFetches: 0,
        autoFetchEnabled: false,
        blocked: false,
        lastMapFetchFinishedAt: 1000,
        pendingRecords: [{ key: 'house:SH1' }]
    }, 1000), null);

    assert.equal(getMapQueueWaitMs({
        activeFetches: 0,
        autoFetchEnabled: true,
        blocked: false,
        lastMapFetchFinishedAt: 1000,
        pendingRecords: [{ key: 'house:SH1' }]
    }, 1000), 4000);
});

test('custom timing settings drive every fetch scheduler', () => {
    const settings = normalizeTimingSettings({
        autoFetchPageDelayMs: 9000,
        mapDetailFetchDelayMs: 7000,
        captchaRetryDelayMs: 45000
    });

    assert.deepEqual(settings, {
        autoFetchPageDelayMs: 9000,
        mapDetailFetchDelayMs: 7000,
        captchaRetryDelayMs: 45000
    });
    assert.equal(getAutoFetchPageDelay(settings), 9000);
    assert.equal(getAutoFetchPageDelay(settings, 2), 18000);
    assert.equal(getAutoFetchRetryDelay({ retryCount: 6 }, settings), 45000);
    assert.equal(getMapQueueWaitMs({
        activeFetches: 0,
        blocked: false,
        lastMapFetchFinishedAt: 1000,
        pendingRecords: [{ key: 'house:SH1' }]
    }, settings, 3000), 5000);
});

test('timing settings normalize invalid stored values to defaults', () => {
    assert.deepEqual(normalizeTimingSettings(JSON.stringify({
        autoFetchPageDelayMs: 'bad',
        mapDetailFetchDelayMs: -1,
        captchaRetryDelayMs: 30000
    })), {
        autoFetchPageDelayMs: 4000,
        mapDetailFetchDelayMs: 4000,
        captchaRetryDelayMs: 30000
    });
});

test('coordinate source defaults to geocode with cascade as the final option', () => {
    assert.equal(DEFAULT_COORDINATE_SOURCE, 'geocode');
    assert.deepEqual(
        COORDINATE_SOURCE_OPTIONS.map((option) => option.value),
        ['geocode', 'fetch', 'tab', 'iframe', 'cascade']
    );
    assert.equal(normalizeCoordinateSource(''), 'geocode');
    assert.equal(normalizeCoordinateSource('iframe'), 'iframe');
    assert.equal(normalizeCoordinateSource('unknown'), 'geocode');
});

test('coordinate source sequences keep cascade explicit and ordered', () => {
    assert.deepEqual(getCoordinateSourceSequence('fetch'), ['fetch']);
    assert.deepEqual(getCoordinateSourceSequence('tab'), ['tab']);
    assert.deepEqual(getCoordinateSourceSequence('iframe'), ['iframe']);
    assert.deepEqual(getCoordinateSourceSequence('geocode'), ['geocode']);
    assert.deepEqual(getCoordinateSourceSequence('cascade'), ['geocode', 'iframe', 'tab', 'fetch']);
});

test('detail URLs and listing text produce stable coordinate lookup keys', () => {
    assert.equal(
        getListingKeyFromDetailUrl('https://sh.lianjia.com/zufang/SH123456.html?foo=1'),
        'house:SH123456'
    );
    assert.equal(
        buildGeocodeQuery({ city: '上海', title: '经纬城市绿洲 1室1厅 南', address: '宝山 上大' }),
        '上海经纬城市绿洲 1室1厅 南'
    );
});

test('filter state normalizes and serializes JSON-compatible values', () => {
    const state = normalizeFilterState({ beikePreferred: false, apartment: true, guessYouLike: false, ignored: false });

    assert.deepEqual(state, { beikePreferred: false, apartment: true, guessYouLike: false });
    assert.equal(serializeFilterState(state), '{"beikePreferred":false,"apartment":true,"guessYouLike":false}');
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

test('subway station switch links use ditiezufang paths', () => {
    assert.equal(isSubwaySwitchLinkText('按地铁线'), true);
    assert.equal(isSubwaySwitchLinkText('按地铁站'), true);
    assert.equal(isSubwaySwitchLinkText('按区域'), false);
    assert.equal(normalizeSubwayStationLinkHref('/zufang/'), '/ditiezufang/');
    assert.equal(
        normalizeSubwayStationLinkHref('https://sh.lianjia.com/zufang/jingan/'),
        'https://sh.lianjia.com/ditiezufang/jingan/'
    );
    assert.equal(
        normalizeSubwayStationLinkHref('//sh.lianjia.com/zufang/?showMore=1'),
        '//sh.lianjia.com/ditiezufang/?showMore=1'
    );
    assert.equal(normalizeSubwayStationLinkHref('https://example.com/zufang/'), 'https://example.com/zufang/');
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

test('preview image URLs normalize protocol-relative and reject empty values', () => {
    assert.equal(
        normalizePreviewImageUrl('//image1.ljcdn.com/110000-inspection/test.jpg.280x210.jpg'),
        'https://image1.ljcdn.com/110000-inspection/test.jpg.280x210.jpg'
    );
    assert.equal(normalizePreviewImageUrl(' https://image1.ljcdn.com/test.jpg '), 'https://image1.ljcdn.com/test.jpg');
    assert.equal(normalizePreviewImageUrl('javascript:alert(1)'), '');
    assert.equal(normalizePreviewImageUrl(''), '');
});

test('detail HTML preview image is extracted from common metadata and image tags', () => {
    assert.equal(
        extractPreviewImageFromDetailHtml('<meta property="og:image" content="//image1.ljcdn.com/preview.jpg">'),
        'https://image1.ljcdn.com/preview.jpg'
    );
    assert.equal(
        extractPreviewImageFromDetailHtml('<img data-src="//image1.ljcdn.com/lianjia/detail.jpg.280x210.jpg">'),
        'https://image1.ljcdn.com/lianjia/detail.jpg.280x210.jpg'
    );
});

test('map info window renders cached preview image above the price', () => {
    const html = buildInfoWindowHtml({
        key: 'house:SH1',
        detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
        title: '整租·缓存房源',
        price: '3000 元/月',
        previewImageUrl: 'https://image1.ljcdn.com/preview.jpg'
    });

    assert.match(html, /<img[^>]+src="https:\/\/image1\.ljcdn\.com\/preview\.jpg"/);
    assert.ok(html.indexOf('lj-rent-map-info__preview') < html.indexOf('lj-rent-map-info__price'));
});

test('map overlays are cleared when no listings remain renderable', () => {
    let clearCount = 0;
    assert.equal(clearMapOverlaysIfPresent({ clearOverlays: () => { clearCount += 1; } }), true);
    assert.equal(clearCount, 1);
    assert.equal(clearMapOverlaysIfPresent(null), false);
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
                previewImageUrl: 'https://image1.ljcdn.com/old.jpg',
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
                    previewImageUrl: 'https://image1.ljcdn.com/old.jpg',
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
                previewImageUrl: 'https://image1.ljcdn.com/cached.jpg',
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
            previewImageUrl: 'https://image1.ljcdn.com/cached.jpg',
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

test('auto fetch captcha retry status counts down every second', () => {
    assert.equal(getAutoFetchRetryStatusText(20000, 0), '遇到验证，20 秒后重试');
    assert.equal(getAutoFetchRetryStatusText(19000, 0), '遇到验证，19 秒后重试');
    assert.equal(getAutoFetchRetryStatusText(1, 0), '遇到验证，1 秒后重试');
    assert.equal(getAutoFetchRetryStatusText(0, 0), '正在重试');
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
            kinds: { beikePreferred: false, apartment: false, guessYouLike: false },
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
        }, {
            key: 'house:SH4',
            detailUrl: 'https://sh.lianjia.com/zufang/SH4.html',
            title: '推荐房源',
            price: '2800 元/月',
            kinds: { beikePreferred: false, apartment: false, guessYouLike: true }
        }], { beikePreferred: false, apartment: false, guessYouLike: false }),
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
        { beikePreferred: true, apartment: false, guessYouLike: false }
    );

    assert.deepEqual(
        classifyListingContent({
            text: '独栋·壹间公寓 虹桥公馆壹间C 1室1厅',
            hrefs: ['/apartment/64659.html']
        }),
        { beikePreferred: false, apartment: true, guessYouLike: false }
    );

    assert.deepEqual(
        classifyListingContent({
            text: '整租·富力桃园B区 3室2厅 南',
            hrefs: ['/zufang/SH999.html'],
            guessYouLike: true
        }),
        { beikePreferred: false, apartment: false, guessYouLike: true }
    );
});

test('unchecked content options hide matching listings only', () => {
    const hideApartment = normalizeFilterState({ beikePreferred: true, apartment: false, guessYouLike: true });
    const hidePreferred = normalizeFilterState({ beikePreferred: false, apartment: true, guessYouLike: true });
    const hideGuessYouLike = normalizeFilterState({ beikePreferred: true, apartment: true, guessYouLike: false });

    assert.equal(shouldShowListing({ beikePreferred: false, apartment: true }, hideApartment), false);
    assert.equal(shouldShowListing({ beikePreferred: true, apartment: false }, hideApartment), true);
    assert.equal(shouldShowListing({ beikePreferred: true, apartment: false }, hidePreferred), false);
    assert.equal(shouldShowListing({ beikePreferred: false, apartment: false }, hidePreferred), true);
    assert.equal(shouldShowListing({ beikePreferred: false, apartment: false, guessYouLike: true }, hideGuessYouLike), false);
    assert.equal(shouldShowListing({ beikePreferred: false, apartment: false, guessYouLike: false }, hideGuessYouLike), true);
});
