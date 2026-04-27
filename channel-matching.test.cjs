const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveStoredIdForEntry,
    resolveCategoryForEntry
} = require('./channel-matching.cjs');

test('matches legacy stored handle against sidebar title variations', () => {
    const data = {
        channelsByCategory: {
            Unreal: ['SmartPoly']
        }
    };

    const category = resolveCategoryForEntry({
        href: 'https://www.youtube.com/channel/UC123/videos',
        text: 'Smart Poly'
    }, data);

    assert.equal(category, 'Unreal');
});

test('matches stored handle against canonical @handle links with suffixes', () => {
    const data = {
        channelsByCategory: {
            Unreal: ['CodeLikeMe']
        }
    };

    const category = resolveCategoryForEntry({
        href: 'https://www.youtube.com/@CodeLikeMe/videos',
        text: 'Code Like Me'
    }, data);

    assert.equal(category, 'Unreal');
});

test('reuses legacy stored handle when current sidebar entry exposes only a UC channel id', () => {
    const data = {
        channelsByCategory: {
            Unreal: ['SmartPoly']
        }
    };

    const storedId = resolveStoredIdForEntry({
        href: 'https://www.youtube.com/channel/UC123/videos',
        text: 'Smart Poly'
    }, data);

    assert.equal(storedId, 'SmartPoly');
});

test('matches legacy stored ids when current channel title is only a unique substring', () => {
    const data = {
        channelsByCategory: {
            'Unreal 动画系统': ['arkmithcreations', 'TechAnimStudios']
        }
    };

    const category = resolveCategoryForEntry({
        href: 'https://www.youtube.com/channel/UC999/videos',
        text: 'Arkmith'
    }, data);

    const storedId = resolveStoredIdForEntry({
        href: 'https://www.youtube.com/channel/UC999/videos',
        text: 'Arkmith'
    }, data);

    assert.equal(category, 'Unreal 动画系统');
    assert.equal(storedId, 'arkmithcreations');
});

test('matches real sidebar title variants seen on logged-in youtube', () => {
    const data = {
        channelsByCategory: {
            DCC: ['3dextrude'],
            'Unreal PCG': ['adrien_logut'],
            Unity: ['batchprogrammer108']
        }
    };

    assert.equal(resolveCategoryForEntry({
        href: 'https://www.youtube.com/@3dextrude',
        title: '3dEx',
        visible: '3dEx',
        aria: '3dEx。有新内容。',
        text: '3dEx'
    }, data), 'DCC');

    assert.equal(resolveCategoryForEntry({
        href: 'https://www.youtube.com/@adrien_logut',
        title: 'Adrien Logut',
        visible: 'Adrien Logut',
        aria: '',
        text: 'Adrien Logut'
    }, data), 'Unreal PCG');

    assert.equal(resolveCategoryForEntry({
        href: 'https://www.youtube.com/@batchprogrammer108',
        title: 'AJTech',
        visible: 'AJTech',
        aria: '',
        text: 'AJTech'
    }, data), 'Unity');
});
