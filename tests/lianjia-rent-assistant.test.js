const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CONTENT_FILTER_HOST_LABEL,
    DEFAULT_FILTER_STATE,
    buildPageUrl,
    classifyListingContent,
    filterNewListingKeys,
    getListingKey,
    normalizeFilterState,
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
