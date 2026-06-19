const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CONTENT_FILTER_HOST_LABEL,
    COORDINATE_SOURCE_OPTIONS,
    DEFAULT_COORDINATE_SOURCE,
    DEFAULT_FILTER_STATE,
    DEFAULT_MAP_HEIGHT,
    DEFAULT_NEXT_PAGE_FETCH_MODE,
    DEFAULT_SHOW_ALL_FETCHED_ON_MAP,
    DEFAULT_TIMING_SETTINGS,
    MAX_MAP_HEIGHT,
    AUTO_FETCH_PAGE_DELAY_MS,
    MAP_DETAIL_FETCH_DELAY_MS,
    MIN_MAP_HEIGHT,
    NEXT_PAGE_FETCH_MODE_OPTIONS,
    applyMapCanvasHeight,
    applyMarkerGroupLabel,
    buildGeocodeQuery,
    buildInfoWindowHtml,
    buildMapGroupInfoWindowHtml,
    buildPageUrl,
    classifyListingContent,
    clearMapOverlaysIfPresent,
    extractMapPointFromDetailHtml,
    extractPreviewImageFromDetailHtml,
    fetchWithTimeout,
    filterMapRecordsByState,
    filterNewListingKeys,
    formatShowAllFetchedText,
    getAutoFetchNextPage,
    getAutoFetchRetryDelay,
    getAutoFetchRetryStatusText,
    getAutoFetchPageDelay,
    getAllFetchedMapRecords,
    getMapClusterSplitZoom,
    getCoordinateSourceSequence,
    getListingDetailUrl,
    getListingKeyFromDetailUrl,
    getListingKey,
    getMapQueueWaitMs,
    getMapOverlayBatchSize,
    getMapPointGroupPrecision,
    getMapRenderGroupPrecision,
    getMapRenderProgressText,
    groupMapRecordsByPoint,
    isSubwaySwitchLinkText,
    getSearchCacheRecords,
    insertMapPanel,
    hydrateMapRecordsFromCache,
    markAutoFetchCaptchaRetry,
    markAutoFetchPageFetched,
    mergeMapCacheRecords,
    normalizeAutoFetchState,
    normalizeCoordinateSource,
    normalizeMapHeight,
    normalizeNextPageFetchMode,
    normalizePreviewImageUrl,
    normalizeShowAllFetchedOnMap,
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

test('show all fetched map toggle is hosted beside auto fetch', () => {
    assert.match(script, /actions\.append\(buildShowAllFetchedControl\(\), buildAutoFetchControl\(\), buildTimingSettingsControl\(\), status\)/);
    assert.doesNotMatch(script, /buildShowAllFetchedRow/);
});

test('show all fetched map toggle displays cached count in parentheses', () => {
    assert.equal(formatShowAllFetchedText(0), '显示所有（0）');
    assert.equal(formatShowAllFetchedText(791), '显示所有（791）');
    assert.equal(formatShowAllFetchedText('bad'), '显示所有（0）');
});

test('large map overlay renders are split into bounded batches', () => {
    assert.equal(getMapOverlayBatchSize(0), 0);
    assert.equal(getMapOverlayBatchSize(38), 38);
    assert.equal(getMapOverlayBatchSize(791), 40);
    assert.equal(getMapRenderProgressText(40, 791), '正在标记 40/791 套');
});

test('map marker records are grouped by normalized coordinates', () => {
    assert.equal(getMapPointGroupPrecision(38), 5);
    assert.equal(getMapPointGroupPrecision(300), 3);
    assert.equal(getMapPointGroupPrecision(791), 2);
    assert.deepEqual(groupMapRecordsByPoint([{
        key: 'house:SH1',
        point: { longitude: 121.400001, latitude: 31.200001 }
    }, {
        key: 'house:SH2',
        point: { longitude: 121.400002, latitude: 31.200002 }
    }, {
        key: 'house:SH3',
        point: { longitude: 121.5, latitude: 31.3 }
    }, {
        key: 'house:SH4'
    }]).map((group) => ({
        count: group.records.length,
        keys: group.records.map((record) => record.key),
        point: group.point
    })), [{
        count: 2,
        keys: ['house:SH1', 'house:SH2'],
        point: { longitude: 121.4, latitude: 31.2 }
    }, {
        count: 1,
        keys: ['house:SH3'],
        point: { longitude: 121.5, latitude: 31.3 }
    }]);
});

test('large map marker groups use coarse coordinate buckets', () => {
    assert.equal(groupMapRecordsByPoint([{
        key: 'house:SH1',
        point: { longitude: 121.4001, latitude: 31.2001 }
    }, {
        key: 'house:SH2',
        point: { longitude: 121.4042, latitude: 31.2042 }
    }], 2).length, 1);
});

test('show-all map grouping gets finer as the user zooms in', () => {
    assert.equal(getMapRenderGroupPrecision(791, 12, true), 1);
    assert.equal(getMapRenderGroupPrecision(791, 13, true), 2);
    assert.equal(getMapRenderGroupPrecision(791, 14, true), 3);
    assert.equal(getMapRenderGroupPrecision(791, 16, true), 4);
    assert.equal(getMapRenderGroupPrecision(791, 17, true), 5);
    assert.equal(getMapRenderGroupPrecision(791, 12, false), 2);
    assert.equal(getMapRenderGroupPrecision(791, 16, false), 5);
});

test('cluster marker clicks zoom in until the maximum split level', () => {
    assert.equal(getMapClusterSplitZoom(10), 12);
    assert.equal(getMapClusterSplitZoom(17), 18);
    assert.equal(getMapClusterSplitZoom(18), 18);
    assert.equal(getMapClusterSplitZoom('bad'), 14);
});

test('map count labels reuse the marker click handler', () => {
    let labelClickHandler = null;
    let labelStyle = null;
    const marker = {
        label: null,
        setLabel(label) {
            this.label = label;
        }
    };
    const BMap = {
        Label: class {
            constructor(text, options) {
                this.text = text;
                this.options = options;
            }

            addEventListener(eventName, handler) {
                if (eventName === 'click') labelClickHandler = handler;
            }

            setStyle(style) {
                labelStyle = style;
            }
        },
        Size: class {
            constructor(width, height) {
                this.width = width;
                this.height = height;
            }
        }
    };
    let clickCount = 0;

    applyMarkerGroupLabel(marker, BMap, 3, '121.1,31.2', () => {
        clickCount += 1;
    });

    assert.match(marker.label.text, /data-lj-rent-map-cluster="121\.1,31\.2"/);
    assert.match(marker.label.text, /class="lj-rent-map-cluster-label"/);
    assert.match(marker.label.text, />3<\/span>/);
    assert.equal(labelStyle.cursor, 'pointer');
    assert.equal(labelStyle.pointerEvents, 'auto');
    assert.equal(typeof labelClickHandler, 'function');
    labelClickHandler();
    assert.equal(clickCount, 1);
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

test('map height settings normalize to the supported drag range', () => {
    assert.equal(DEFAULT_MAP_HEIGHT, 360);
    assert.equal(MIN_MAP_HEIGHT, 240);
    assert.equal(MAX_MAP_HEIGHT, 1200);
    assert.equal(normalizeMapHeight(null), 360);
    assert.equal(normalizeMapHeight('900'), 900);
    assert.equal(normalizeMapHeight(239), 240);
    assert.equal(normalizeMapHeight(1201), 1200);
    assert.equal(normalizeMapHeight(455.6), 456);
});

test('map canvas height is applied as a normalized pixel value', () => {
    const canvas = { style: {} };
    assert.equal(applyMapCanvasHeight(canvas, 1300), 1200);
    assert.equal(canvas.style.height, '1200px');
    assert.equal(applyMapCanvasHeight(canvas, 180), 240);
    assert.equal(canvas.style.height, '240px');
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

test('next page fetch mode defaults to fetch and supports iframe loading', () => {
    assert.equal(DEFAULT_NEXT_PAGE_FETCH_MODE, 'fetch');
    assert.deepEqual(NEXT_PAGE_FETCH_MODE_OPTIONS.map((option) => option.value), ['fetch', 'iframe']);
    assert.equal(normalizeNextPageFetchMode(null), 'fetch');
    assert.equal(normalizeNextPageFetchMode('iframe'), 'iframe');
    assert.equal(normalizeNextPageFetchMode('off'), 'fetch');
});

test('show all fetched map setting defaults off and normalizes booleans', () => {
    assert.equal(DEFAULT_SHOW_ALL_FETCHED_ON_MAP, false);
    assert.equal(normalizeShowAllFetchedOnMap(null), false);
    assert.equal(normalizeShowAllFetchedOnMap(false), false);
    assert.equal(normalizeShowAllFetchedOnMap(true), true);
    assert.equal(normalizeShowAllFetchedOnMap('true'), true);
    assert.equal(normalizeShowAllFetchedOnMap('false'), false);
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

test('map group info window lists every listing in the grouped marker', () => {
    const html = buildMapGroupInfoWindowHtml({
        records: [{
            title: '整租·一号房源',
            price: '3000 元/月',
            detailUrl: 'https://sh.lianjia.com/zufang/SH1.html'
        }, {
            title: '整租·二号房源',
            price: '3200 元/月',
            detailUrl: 'https://sh.lianjia.com/zufang/SH2.html'
        }]
    });

    assert.match(html, /共 2 套/);
    assert.match(html, /整租·一号房源/);
    assert.match(html, /3000 元\/月/);
    assert.match(html, /SH1\.html/);
    assert.match(html, /整租·二号房源/);
    assert.match(html, /3200 元\/月/);
    assert.match(html, /SH2\.html/);
});

test('map overlays are cleared when no listings remain renderable', () => {
    let clearCount = 0;
    assert.equal(clearMapOverlaysIfPresent({ clearOverlays: () => { clearCount += 1; } }), true);
    assert.equal(clearCount, 1);
    assert.equal(clearMapOverlaysIfPresent(null), false);
});

test('map panel is inserted into the full content width above result title', () => {
    const panel = {};
    const firstChild = {};
    const calls = [];
    const content = {
        firstChild,
        insertBefore(node, reference) {
            calls.push({ node, reference });
        }
    };
    const title = {
        closest(selector) {
            return selector === '#content, .content.w1150, .content' ? content : null;
        },
        after() {
            throw new Error('title.after should not be used when content container exists');
        }
    };

    assert.equal(insertMapPanel(panel, title), 'content');
    assert.deepEqual(calls, [{ node: panel, reference: firstChild }]);
});

test('map panel falls back to result title insertion when full content container is missing', () => {
    const panel = {};
    const calls = [];
    const title = {
        closest() {
            return null;
        },
        after(node) {
            calls.push(node);
        }
    };

    assert.equal(insertMapPanel(panel, title), 'title');
    assert.deepEqual(calls, [panel]);
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

test('all fetched map records return every cached listing with coordinates', () => {
    const cache = mergeMapCacheRecords(parseStoredMapCache(null), [{
        key: 'house:SH1',
        detailUrl: 'https://sh.lianjia.com/zufang/SH1.html',
        title: '当前区域房源',
        price: '3000 元/月',
        point: { longitude: 121.4, latitude: 31.2 }
    }, {
        key: 'house:SH2',
        detailUrl: 'https://sh.lianjia.com/zufang/SH2.html',
        title: '其他地铁线房源',
        price: '2500 元/月',
        point: { longitude: 121.5, latitude: 31.3 }
    }, {
        key: 'house:SH3',
        detailUrl: 'https://sh.lianjia.com/zufang/SH3.html',
        title: '尚未读取坐标房源',
        price: '2800 元/月'
    }], 99, '/ditiezufang/pg{page}/');

    assert.deepEqual(
        getAllFetchedMapRecords(cache).map((record) => record.key),
        ['house:SH1', 'house:SH2']
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
