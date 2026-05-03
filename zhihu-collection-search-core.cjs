function normalizeSpace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
    return normalizeSpace(String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'"));
}

function collectionNeedsReindex(cached, current) {
    if (!cached) return true;
    if (!current) return false;
    const cachedCount = Number(cached.itemCount);
    const currentCount = Number(current.itemCount);
    if (Number.isFinite(currentCount) && (!Number.isFinite(cachedCount) || cachedCount !== currentCount)) {
        return true;
    }
    const cachedUpdated = Number(cached.updatedTime);
    const currentUpdated = Number(current.updatedTime);
    return Number.isFinite(currentUpdated) && (!Number.isFinite(cachedUpdated) || cachedUpdated !== currentUpdated);
}

function extractCollectionList(response) {
    return (response && Array.isArray(response.data) ? response.data : [])
        .filter((item) => item && item.type === 'collection' && item.id)
        .map((item) => ({
            id: String(item.id),
            title: normalizeSpace(item.title || '未命名收藏夹')
        }));
}

function extractCollectionMeta(response, fallback = {}) {
    const collection = response && response.collection ? response.collection : response || {};
    const id = collection.id || fallback.id;
    return {
        id: String(id),
        title: normalizeSpace(collection.title || fallback.title || '未命名收藏夹'),
        itemCount: Number(collection.item_count ?? collection.answer_count ?? fallback.itemCount ?? 0),
        updatedTime: Number(collection.updated_time ?? fallback.updatedTime ?? 0)
    };
}

function extractCollectionMetaFromText({ id, title, detailText }) {
    const text = normalizeSpace(detailText || '');
    const match = text.match(/(\d{4}-\d{2}-\d{2})\s*更新\s*·\s*([\d,]+)\s*条内容/);
    if (!match) return null;

    return {
        id: String(id),
        title: normalizeSpace(title || '未命名收藏夹'),
        itemCount: Number(match[2].replace(/,/g, '')),
        updatedTime: Math.floor(Date.parse(`${match[1]}T00:00:00+08:00`) / 1000)
    };
}

function extractItemRecord({ collectionId, collectionTitle, item }) {
    const content = item && item.content ? item.content : item || {};
    const title = normalizeSpace(content.title || content.question?.title || content.excerpt_title || '无标题');
    const text = htmlToText(content.content || content.excerpt || content.description || content.text || '');
    const url = content.url || content.url_token || content.link || '';
    const id = String(content.id || item.id || `${collectionId}:${url || title}`);

    return {
        id,
        collectionId: String(collectionId),
        collectionTitle: normalizeSpace(collectionTitle || '未命名收藏夹'),
        title,
        text,
        url,
        createdTime: item.created_time || item.created || 0,
        type: content.type || item.type || ''
    };
}

function makeSnippet(record, terms, radius = 42) {
    const haystack = `${record.title} ${record.text}`;
    const lower = haystack.toLowerCase();
    const firstIndex = terms.reduce((best, term) => {
        const index = lower.indexOf(term);
        if (index < 0) return best;
        return best < 0 ? index : Math.min(best, index);
    }, -1);
    if (firstIndex < 0) return normalizeSpace(record.text || record.title).slice(0, radius * 2);
    const start = Math.max(0, firstIndex - radius);
    const end = Math.min(haystack.length, firstIndex + radius);
    return `${start > 0 ? '...' : ''}${normalizeSpace(haystack.slice(start, end))}${end < haystack.length ? '...' : ''}`;
}

function searchRecords(records, query) {
    const terms = normalizeSpace(query).toLowerCase().split(' ').filter(Boolean);
    if (!terms.length) return [];

    return records
        .filter((record) => {
            const haystack = `${record.title} ${record.text} ${record.collectionTitle}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
        })
        .map((record) => ({
            ...record,
            snippet: makeSnippet(record, terms)
        }));
}

function makeResultTabLabel() {
    return '全文搜索我的收藏夹';
}

function findCollectionsNeedingIndex(cachedCollections, currentCollections, ownerToken = '') {
    const cachedById = new Map(
        (Array.isArray(cachedCollections) ? cachedCollections : [])
            .filter((collection) => !ownerToken || !collection.ownerToken || collection.ownerToken === ownerToken)
            .map((collection) => [String(collection.id), collection])
    );

    return (Array.isArray(currentCollections) ? currentCollections : [])
        .filter((collection) => collectionNeedsReindex(cachedById.get(String(collection.id)), collection));
}

function makeIndexButtonLabel({ syncing = false, pendingCount = 0 } = {}) {
    if (syncing) return '索引中';
    const count = Number(pendingCount);
    if (Number.isFinite(count) && count > 0) return `更新 ${count} 个`;
    return '全文索引';
}

function sumCollectionItemCount(collections) {
    return (Array.isArray(collections) ? collections : [])
        .reduce((total, collection) => {
            const count = Number(collection && collection.itemCount);
            return total + (Number.isFinite(count) && count > 0 ? count : 0);
        }, 0);
}

function makeIndexProgressText(stage, done, total) {
    const label = stage === 'checking' ? '检查收藏夹' : '全文索引';
    const safeDone = Math.max(0, Number(done) || 0);
    const safeTotal = Math.max(0, Number(total) || 0);
    return `${label} ${safeDone}/${safeTotal || '?'}`;
}

function selectVisibleSearchAnchor(candidates) {
    const visible = (Array.isArray(candidates) ? candidates : [])
        .filter((candidate) => {
            if (!candidate) return false;
            const rect = candidate.rect || {};
            return Number(rect.width) > 0 && Number(rect.height) > 0;
        });

    return visible.find((candidate) => Boolean(candidate.insideMain)) || visible[0] || null;
}

function shouldUpdateText(currentText, nextText) {
    return String(currentText || '') !== String(nextText || '');
}

function getImmediatePositioningEvents() {
    return ['scroll', 'resize'];
}

function getResultPanelUserCloseTriggers() {
    return ['close-button'];
}

function getResultPanelProtectedEvents() {
    return ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart'];
}

function shouldCloseResultPanelFromClick(targetInfo = {}) {
    return Boolean(targetInfo.closestCloseButton);
}

module.exports = {
    collectionNeedsReindex,
    extractCollectionList,
    extractCollectionMeta,
    extractCollectionMetaFromText,
    extractItemRecord,
    findCollectionsNeedingIndex,
    getImmediatePositioningEvents,
    getResultPanelProtectedEvents,
    getResultPanelUserCloseTriggers,
    htmlToText,
    makeIndexButtonLabel,
    makeIndexProgressText,
    makeResultTabLabel,
    selectVisibleSearchAnchor,
    shouldCloseResultPanelFromClick,
    shouldUpdateText,
    sumCollectionItemCount,
    searchRecords
};
