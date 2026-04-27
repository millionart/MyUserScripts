function normalizeChannelKey(channelId) {
    if (!channelId) return null;

    const normalized = String(channelId)
        .trim()
        .replace(/^@+/, '')
        .replace(/\/+$/, '')
        .split('/')[0]
        .split('?')[0]
        .split('#')[0];
    return normalized || null;
}

function normalizeLooseChannelToken(value) {
    const normalized = normalizeChannelKey(value);
    if (!normalized) return null;

    const loose = normalized
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');

    return loose || null;
}

function splitChannelTextCandidates(value) {
    if (!value) return [];

    return String(value)
        .split(/[\n\r·•|｜]+/g)
        .map((part) => part.trim())
        .filter(Boolean);
}

function extractChannelId(urlLike) {
    try {
        const url = new URL(urlLike, 'https://www.youtube.com');
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '/') return null;

        if (path.startsWith('/channel/')) return normalizeChannelKey(path.slice('/channel/'.length));
        if (path.startsWith('/@')) return normalizeChannelKey(path.slice(2));
        if (path.startsWith('/c/')) return normalizeChannelKey(path.slice('/c/'.length));
        if (path.startsWith('/user/')) return normalizeChannelKey(path.slice('/user/'.length));
        return null;
    } catch {
        return null;
    }
}

function buildChannelLookups(data) {
    const exactCategoryMap = {};
    const exactToStoredId = {};
    const looseToStoredId = {};
    const storedIds = [];

    Object.entries(data.channelsByCategory || {}).forEach(([category, channelIds]) => {
        if (!Array.isArray(channelIds)) return;
        channelIds.forEach((channelId) => {
            const normalizedId = normalizeChannelKey(channelId);
            if (normalizedId) {
                exactCategoryMap[normalizedId] = category;
                exactToStoredId[normalizedId] = normalizedId;
                storedIds.push(normalizedId);

                const loose = normalizeLooseChannelToken(normalizedId);
                if (loose && !looseToStoredId[loose]) {
                    looseToStoredId[loose] = normalizedId;
                }
            }
        });
    });

    return {
        exactCategoryMap,
        exactToStoredId,
        looseToStoredId,
        storedIds
    };
}

function findUniqueLooseSubstringMatch(looseTokens, lookups) {
    const candidates = new Set();

    for (const token of looseTokens) {
        if (!token || token.length < 4) continue;

        for (const storedId of lookups.storedIds) {
            const storedLoose = normalizeLooseChannelToken(storedId);
            if (!storedLoose || storedLoose === token) continue;

            if (storedLoose.includes(token) || token.includes(storedLoose)) {
                candidates.add(storedId);
            }
        }
    }

    return candidates.size === 1 ? [...candidates][0] : null;
}

function collectEntryInfo(entry) {
    const ids = [];
    const looseTokens = [];

    const channelId = extractChannelId(entry.href);
    if (channelId) ids.push(channelId);

    const textCandidates = [entry.title, entry.aria, entry.visible, entry.text];
    textCandidates.forEach((candidate) => {
        splitChannelTextCandidates(candidate).forEach((part) => {
            const loose = normalizeLooseChannelToken(part);
            if (loose) looseTokens.push(loose);
        });
    });

    return {
        ids: [...new Set(ids)],
        looseTokens: [...new Set(looseTokens)]
    };
}

function resolveStoredIdForEntry(entry, data) {
    const info = collectEntryInfo(entry);
    const lookups = buildChannelLookups(data);

    for (const id of info.ids) {
        if (lookups.exactToStoredId[id]) return lookups.exactToStoredId[id];
    }

    for (const token of info.looseTokens) {
        if (lookups.looseToStoredId[token]) return lookups.looseToStoredId[token];
    }

    const fuzzyMatch = findUniqueLooseSubstringMatch(info.looseTokens, lookups);
    if (fuzzyMatch) return fuzzyMatch;

    return info.ids[0] || null;
}

function resolveCategoryForEntry(entry, data) {
    const lookups = buildChannelLookups(data);
    const storedId = resolveStoredIdForEntry(entry, data);
    if (!storedId) return null;
    return lookups.exactCategoryMap[storedId] || null;
}

module.exports = {
    buildChannelLookups,
    collectEntryInfo,
    extractChannelId,
    normalizeChannelKey,
    normalizeLooseChannelToken,
    splitChannelTextCandidates,
    resolveStoredIdForEntry,
    resolveCategoryForEntry
};
