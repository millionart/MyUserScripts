// ==UserScript==
// @name         Zhihu Collections Full Text Search
// @namespace    https://github.com/milli/zhihu-collections-full-text-search
// @version      0.1.8
// @description  在知乎个人主页“我创建的收藏夹”中缓存收藏内容并提供全文搜索。
// @author       Codex
// @license      MIT
// @match        https://www.zhihu.com/people/*/collections*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      www.zhihu.com
// @connect      zhihu.com
// ==/UserScript==

(function() {
    'use strict';

    const APP_ID = 'zcfts';
    const DB_NAME = 'zhihu-collections-full-text-search';
    const DB_VERSION = 1;
    const COLLECTION_STORE = 'collections';
    const PAGE_LIMIT = 20;
    const AUTO_CHECK_DELAY = 1800;
    const REQUEST_DELAY = 120;
    const PANEL_EVENT_GUARD_VERSION = '2';

    const state = {
        db: null,
        routeKey: '',
        userToken: '',
        syncing: false,
        checking: false,
        checkStartedForRoute: '',
        pendingCollections: [],
        collections: [],
        records: [],
        query: '',
        results: [],
        statusText: '',
        panelOpen: false,
        mutationObserver: null,
        uiUpdateScheduled: false,
        positionUpdateScheduled: false,
        positioningListenersInstalled: false,
        routeTimer: null,
        positioningTimer: null
    };

    function normalizeSpace(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function htmlToText(html) {
        if (!html) return '';
        const doc = new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
        doc.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
        return normalizeSpace(doc.body ? doc.body.textContent : '');
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

    function normalizeUrl(url) {
        if (!url) return '';
        try {
            return new URL(String(url), location.origin).href;
        } catch (error) {
            return '';
        }
    }

    function extractItemRecord({ collectionId, collectionTitle, item }) {
        const content = item && item.content ? item.content : item || {};
        const title = normalizeSpace(
            content.title ||
            (content.question && content.question.title) ||
            content.excerpt_title ||
            content.excerpt ||
            '无标题'
        );
        const text = htmlToText(content.content || content.excerpt || content.description || content.text || '');
        const url = normalizeUrl(content.url || content.link || '');
        const id = String(content.id || item.id || `${collectionId}:${url || title}`);

        return {
            id,
            collectionId: String(collectionId),
            collectionTitle: normalizeSpace(collectionTitle || '未命名收藏夹'),
            title,
            text,
            url,
            createdTime: item.created_time || item.created || content.created_time || 0,
            type: content.type || item.type || ''
        };
    }

    function makeSnippet(record, terms, radius = 58) {
        const haystack = normalizeSpace(`${record.title} ${record.text}`);
        const lower = haystack.toLowerCase();
        const firstIndex = terms.reduce((best, term) => {
            const index = lower.indexOf(term);
            if (index < 0) return best;
            return best < 0 ? index : Math.min(best, index);
        }, -1);

        if (firstIndex < 0) {
            return normalizeSpace(record.text || record.title).slice(0, radius * 2);
        }

        const start = Math.max(0, firstIndex - radius);
        const end = Math.min(haystack.length, firstIndex + radius);
        return `${start > 0 ? '...' : ''}${haystack.slice(start, end)}${end < haystack.length ? '...' : ''}`;
    }

    function getSearchTerms(query) {
        return normalizeSpace(query).toLowerCase().split(' ').filter(Boolean);
    }

    function searchRecords(records, query) {
        const terms = getSearchTerms(query);
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

    function getElementFromEventTarget(target) {
        if (!target) return null;
        if (target.nodeType === Node.ELEMENT_NODE) return target;
        return target.parentElement || null;
    }

    function getResultPanelClickInfo(target) {
        const element = getElementFromEventTarget(target);
        return {
            closestCloseButton: Boolean(element && element.closest(`#${APP_ID}-panel-close`))
        };
    }

    function setTextIfChanged(element, text) {
        if (element && shouldUpdateText(element.textContent, text)) {
            element.textContent = text;
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function yieldToBrowser() {
        return new Promise((resolve) => {
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => resolve(), { timeout: 120 });
            } else {
                setTimeout(resolve, 0);
            }
        });
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
        });
    }

    async function openDb() {
        if (state.db) return state.db;

        state.db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(COLLECTION_STORE)) {
                    db.createObjectStore(COLLECTION_STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB'));
        });

        return state.db;
    }

    async function withCollectionStore(mode, action) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(COLLECTION_STORE, mode);
            const store = tx.objectStore(COLLECTION_STORE);
            let actionResult;

            tx.oncomplete = () => resolve(actionResult);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));

            try {
                actionResult = action(store);
            } catch (error) {
                tx.abort();
                reject(error);
            }
        });
    }

    async function getAllCachedCollections() {
        await openDb();
        return requestToPromise(state.db.transaction(COLLECTION_STORE, 'readonly').objectStore(COLLECTION_STORE).getAll());
    }

    async function putCachedCollection(collection) {
        await withCollectionStore('readwrite', (store) => {
            store.put(collection);
        });
    }

    async function deleteCachedCollection(id) {
        await withCollectionStore('readwrite', (store) => {
            store.delete(String(id));
        });
    }

    async function apiFetch(path) {
        const url = new URL(path, location.origin).href;

        if (typeof GM_xmlhttpRequest !== 'function') {
            throw new Error('后台请求不可用：请确认脚本管理器已授予 GM_xmlhttpRequest 权限');
        }

        return gmJsonRequest(url);
    }

    function gmJsonRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'json',
                headers: {
                    accept: 'application/json, text/plain, */*'
                },
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`知乎 API 请求失败：${response.status}`));
                        return;
                    }

                    if (response.response && typeof response.response === 'object') {
                        resolve(response.response);
                        return;
                    }

                    try {
                        resolve(JSON.parse(response.responseText || '{}'));
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: () => reject(new Error('知乎 API 后台请求失败')),
                ontimeout: () => reject(new Error('知乎 API 后台请求超时'))
            });
        });
    }

    function getUserToken() {
        const match = location.pathname.match(/^\/people\/([^/]+)\/collections(?:\/following)?\/?$/);
        return match ? decodeURIComponent(match[1]) : '';
    }

    function isCreatedCollectionsRoute() {
        return /^\/people\/[^/]+\/collections\/?$/.test(location.pathname);
    }

    async function fetchCreatedCollections(userToken) {
        const collections = [];
        let offset = 0;

        while (true) {
            const response = await apiFetch(`/api/v4/members/${encodeURIComponent(userToken)}/favlists?offset=${offset}&limit=${PAGE_LIMIT}`);
            collections.push(...extractCollectionList(response));

            const paging = response && response.paging ? response.paging : {};
            if (paging.is_end || !Array.isArray(response.data) || response.data.length === 0) break;
            offset += PAGE_LIMIT;
            await yieldToBrowser();
            await sleep(REQUEST_DELAY);
        }

        return collections;
    }

    async function fetchCollectionMeta(collection) {
        const response = await apiFetch(`/api/v4/collections/${encodeURIComponent(collection.id)}`);
        return extractCollectionMeta(response, collection);
    }

    async function fetchCollectionRecords(meta, onProgress) {
        const records = [];
        let offset = 0;
        let total = Number(meta.itemCount) || 0;

        while (true) {
            const response = await apiFetch(`/api/v4/collections/${encodeURIComponent(meta.id)}/items?offset=${offset}&limit=${PAGE_LIMIT}`);
            const data = Array.isArray(response.data) ? response.data : [];
            const paging = response && response.paging ? response.paging : {};
            total = Number(paging.totals ?? total) || total;

            for (const item of data) {
                records.push(extractItemRecord({
                    collectionId: meta.id,
                    collectionTitle: meta.title,
                    item
                }));

                if (records.length % 5 === 0) {
                    onProgress(records.length, total);
                    await yieldToBrowser();
                }
            }

            onProgress(records.length, total);
            if (paging.is_end || data.length === 0 || records.length >= total) break;

            offset += data.length || PAGE_LIMIT;
            await yieldToBrowser();
            await sleep(REQUEST_DELAY);
        }

        return records;
    }

    function getRenderedCreatedCollectionMetas() {
        const main = document.querySelector('main') || document.body;
        const links = Array.from(main.querySelectorAll('a[href^="/collection/"], a[href*="zhihu.com/collection/"]'));
        const seen = new Set();
        const metas = [];

        for (const link of links) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/collection\/(\d+)/);
            if (!match || seen.has(match[1])) continue;

            const detailText = findCollectionRowText(link);
            const meta = extractCollectionMetaFromText({
                id: match[1],
                title: link.textContent,
                detailText
            });

            if (meta) {
                seen.add(meta.id);
                metas.push(meta);
            }
        }

        return metas;
    }

    function findCollectionRowText(link) {
        let node = link.parentElement;

        for (let depth = 0; node && depth < 8; depth += 1) {
            const text = normalizeSpace(node.textContent || '');
            if (/\d{4}-\d{2}-\d{2}\s*更新\s*·\s*[\d,]+\s*条内容/.test(text) && text.length < 360) {
                return text;
            }
            node = node.parentElement;
        }

        return normalizeSpace(link.parentElement ? link.parentElement.textContent : '');
    }

    async function loadCachedIndex() {
        const collections = await getAllCachedCollections();
        state.collections = collections
            .filter((collection) => collection && Array.isArray(collection.records))
            .filter((collection) => !collection.ownerToken || collection.ownerToken === state.userToken)
            .sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
        state.records = state.collections.flatMap((collection) => collection.records.map((record) => ({
            ...record,
            collectionTitle: record.collectionTitle || collection.title
        })));
        updateSearchResults();
        updateStatusText(state.statusText || `已缓存 ${state.records.length} 条内容`);
    }

    function updateStatusText(text) {
        state.statusText = text;
        const status = document.getElementById(`${APP_ID}-status`);
        setTextIfChanged(status, text);
        const button = document.getElementById(`${APP_ID}-index-button`);
        if (button) {
            button.disabled = state.syncing;
            setTextIfChanged(button, makeIndexButtonLabel({
                syncing: state.syncing,
                pendingCount: state.pendingCollections.length
            }));
        }
        updateResultTab();
    }

    function updateSearchResults() {
        state.results = searchRecords(state.records, state.query);
        updateResultTab();
        if (state.panelOpen) renderPanel();
    }

    async function syncCollections({ force = false, precheckedMetas = null } = {}) {
        if (state.syncing || !state.userToken || !isCreatedCollectionsRoute()) return;

        state.syncing = true;
        const hasPrecheckedMetas = Array.isArray(precheckedMetas) && precheckedMetas.length > 0;
        updateStatusText(hasPrecheckedMetas
            ? makeIndexProgressText('indexing', 0, sumCollectionItemCount(precheckedMetas))
            : makeIndexProgressText('checking', 0, 0));

        try {
            await openDb();
            let cached = await getAllCachedCollections();
            let metasToIndex = Array.isArray(precheckedMetas) ? precheckedMetas.slice() : [];
            let reindexed = 0;
            const failures = [];

            if (!metasToIndex.length || force) {
                const created = await fetchCreatedCollections(state.userToken);
                cached = await getAllCachedCollections();
                const cachedById = new Map(cached.map((collection) => [String(collection.id), collection]));
                const currentIds = new Set(created.map((collection) => String(collection.id)));
                const currentMetas = [];
                let checked = 0;

                for (const collection of created) {
                    checked += 1;
                    updateStatusText(makeIndexProgressText('checking', checked, created.length));

                    try {
                        const meta = await fetchCollectionMeta(collection);
                        currentMetas.push(meta);
                        const cachedCollection = cachedById.get(meta.id);

                        if (force || collectionNeedsReindex(cachedCollection, meta)) {
                            metasToIndex.push(meta);
                        } else if (cachedCollection.title !== meta.title) {
                            await putCachedCollection({
                                ...cachedCollection,
                                ...meta,
                                ownerToken: state.userToken,
                                records: cachedCollection.records || []
                            });
                        }
                    } catch (error) {
                        failures.push(`${collection.title}: ${error.message}`);
                        console.warn('[Zhihu Collections Full Text Search] 检查收藏夹失败', collection, error);
                    }

                    await yieldToBrowser();
                    await sleep(REQUEST_DELAY);
                }

                for (const collection of cached) {
                    if ((!collection.ownerToken || collection.ownerToken === state.userToken) && !currentIds.has(String(collection.id))) {
                        await deleteCachedCollection(collection.id);
                    }
                }

                if (force) {
                    metasToIndex = currentMetas;
                }
            }

            const totalItems = sumCollectionItemCount(metasToIndex);
            let processedItems = 0;
            updateStatusText(makeIndexProgressText('indexing', processedItems, totalItems));

            for (const meta of metasToIndex) {
                try {
                    const records = await fetchCollectionRecords(meta, (done) => {
                        updateStatusText(makeIndexProgressText('indexing', processedItems + done, totalItems));
                    });
                    processedItems += records.length;
                    await putCachedCollection({
                        ...meta,
                        ownerToken: state.userToken,
                        indexedAt: Date.now(),
                        records
                    });
                    reindexed += 1;
                    updateStatusText(makeIndexProgressText('indexing', processedItems, totalItems));
                } catch (error) {
                    failures.push(`${meta.title}: ${error.message}`);
                    console.warn('[Zhihu Collections Full Text Search] 索引收藏夹失败', meta, error);
                }

                await yieldToBrowser();
                await sleep(REQUEST_DELAY);
            }

            await loadCachedIndex();
            const indexedIds = new Set(metasToIndex.map((meta) => String(meta.id)));
            state.pendingCollections = state.pendingCollections.filter((meta) => !indexedIds.has(String(meta.id)));

            if (failures.length) {
                updateStatusText(`部分失败 ${failures.length} 个，已缓存 ${state.records.length} 条`);
            } else if (reindexed) {
                updateStatusText(`已更新 ${reindexed} 个收藏夹，共 ${state.records.length} 条`);
            } else {
                updateStatusText(`缓存已是最新，共 ${state.records.length} 条`);
            }
        } catch (error) {
            console.error('[Zhihu Collections Full Text Search] 自动索引失败', error);
            updateStatusText(`索引失败：${error.message}`);
        } finally {
            state.syncing = false;
            updateStatusText(state.statusText);
        }
    }

    async function checkCollectionUpdates() {
        if (state.syncing || state.checking || !state.userToken || !isCreatedCollectionsRoute()) return;

        state.checking = true;
        updateStatusText(makeIndexProgressText('checking', 0, 0));

        try {
            await openDb();
            const cached = await getAllCachedCollections();
            const currentMetas = getRenderedCreatedCollectionMetas();

            if (!currentMetas.length) {
                updateStatusText(makeIndexProgressText('checking', 0, 0));
                setTimeout(checkCollectionUpdates, 1000);
                return;
            }

            updateStatusText(makeIndexProgressText('checking', currentMetas.length, currentMetas.length));
            const currentIds = new Set(currentMetas.map((meta) => String(meta.id)));
            for (const collection of cached) {
                if ((!collection.ownerToken || collection.ownerToken === state.userToken) && !currentIds.has(String(collection.id))) {
                    await deleteCachedCollection(collection.id);
                }
            }

            state.pendingCollections = findCollectionsNeedingIndex(cached, currentMetas, state.userToken);
            await refreshFreshCachedCollectionTitles(cached, currentMetas);
            await loadCachedIndex();

            if (state.pendingCollections.length) {
                updateStatusText(makeIndexProgressText('indexing', 0, sumCollectionItemCount(state.pendingCollections)));
                const metasToIndex = state.pendingCollections.slice();
                setTimeout(() => syncCollections({ precheckedMetas: metasToIndex }), 0);
            } else {
                updateStatusText(`缓存已是最新，共 ${state.records.length} 条`);
            }
        } catch (error) {
            console.error('[Zhihu Collections Full Text Search] 检查收藏夹更新失败', error);
            updateStatusText(`检查失败：${error.message}`);
        } finally {
            state.checking = false;
            updateStatusText(state.statusText);
        }
    }

    async function refreshFreshCachedCollectionTitles(cached, currentMetas) {
        const cachedById = new Map(cached.map((collection) => [String(collection.id), collection]));

        for (const meta of currentMetas) {
            const cachedCollection = cachedById.get(meta.id);
            if (cachedCollection && !collectionNeedsReindex(cachedCollection, meta) && cachedCollection.title !== meta.title) {
                await putCachedCollection({
                    ...cachedCollection,
                    ...meta,
                    ownerToken: state.userToken,
                    records: cachedCollection.records || []
                });
            }
        }
    }

    function installStyles() {
        if (document.getElementById(`${APP_ID}-style`)) return;

        const style = document.createElement('style');
        style.id = `${APP_ID}-style`;
        style.textContent = `
#${APP_ID}-inline-controls {
    align-items: center;
    display: flex;
    gap: 8px;
    position: fixed;
    z-index: 1000;
}
#${APP_ID}-inline-controls[hidden] {
    display: none !important;
}
#${APP_ID}-index-button,
#${APP_ID}-result-tab,
#${APP_ID}-panel-close {
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
}
#${APP_ID}-index-button {
    border: 1px solid #1772f6;
    border-radius: 16px;
    color: #1772f6;
    height: 32px;
    padding: 0 12px;
    white-space: nowrap;
}
#${APP_ID}-index-button:disabled {
    border-color: #b8c4d6;
    color: #8491a5;
    cursor: default;
}
#${APP_ID}-status {
    color: #8590a6;
    font-size: 12px;
    max-width: 170px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#${APP_ID}-result-tab {
    color: #121212;
    display: inline-flex;
    align-items: center;
    height: 50px;
    margin-left: 40px;
    padding: 0;
    position: relative;
    white-space: nowrap;
}
#${APP_ID}-result-tab:hover {
    color: #1772f6;
}
#${APP_ID}-result-tab.${APP_ID}-active::after {
    background: #1772f6;
    bottom: 0;
    content: '';
    height: 3px;
    left: 0;
    position: absolute;
    right: 0;
}
#${APP_ID}-backdrop {
    align-items: center;
    background: rgba(18, 18, 18, 0.32);
    bottom: 0;
    display: flex;
    justify-content: center;
    left: 0;
    padding: 24px;
    position: fixed;
    right: 0;
    top: 0;
    z-index: 10000;
}
#${APP_ID}-backdrop[hidden] {
    display: none !important;
}
#${APP_ID}-panel {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(18, 18, 18, 0.18);
    color: #121212;
    display: flex;
    flex-direction: column;
    max-height: min(760px, calc(100vh - 48px));
    overflow: hidden;
    width: min(760px, calc(100vw - 48px));
}
#${APP_ID}-panel-header {
    align-items: center;
    border-bottom: 1px solid #ebebeb;
    display: flex;
    gap: 12px;
    padding: 14px 18px;
}
#${APP_ID}-panel-title {
    font-size: 16px;
    font-weight: 600;
    margin-right: auto;
}
#${APP_ID}-panel-search {
    border: 1px solid #d3d7de;
    border-radius: 16px;
    box-sizing: border-box;
    font-size: 14px;
    height: 32px;
    outline: none;
    padding: 0 13px;
    width: 260px;
}
#${APP_ID}-panel-close {
    color: #8590a6;
    font-size: 22px;
    line-height: 1;
    padding: 0 4px;
}
#${APP_ID}-panel-body {
    overflow: auto;
    padding: 8px 0;
}
.${APP_ID}-empty {
    color: #8590a6;
    padding: 28px 20px;
    text-align: center;
}
.${APP_ID}-result {
    border-bottom: 1px solid #f0f2f7;
    padding: 14px 18px;
}
.${APP_ID}-result:last-child {
    border-bottom: 0;
}
.${APP_ID}-result-title {
    color: #175199;
    display: inline-block;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.45;
    text-decoration: none;
}
.${APP_ID}-result-title:hover {
    text-decoration: underline;
}
.${APP_ID}-collection {
    background: #f6f8fb;
    border-radius: 4px;
    color: #5c667a;
    display: inline-block;
    font-size: 12px;
    margin-left: 8px;
    padding: 2px 6px;
    vertical-align: 1px;
}
.${APP_ID}-snippet {
    color: #444;
    font-size: 14px;
    line-height: 1.65;
    margin-top: 7px;
}
.${APP_ID}-snippet mark {
    background: #fff3bf;
    border-radius: 2px;
    color: inherit;
    padding: 0 1px;
}
@media (max-width: 900px) {
    #${APP_ID}-inline-controls {
        bottom: 16px;
        left: 12px !important;
        right: 12px;
        top: auto !important;
    }
    #${APP_ID}-status {
        display: none;
    }
    #${APP_ID}-result-tab {
        margin-left: 20px;
    }
    #${APP_ID}-panel-header {
        align-items: stretch;
        flex-wrap: wrap;
    }
    #${APP_ID}-panel-title {
        width: calc(100% - 34px);
    }
    #${APP_ID}-panel-search {
        width: 100%;
    }
}`;
        document.head.appendChild(style);
    }

    function ensureInlineControls() {
        let controls = document.getElementById(`${APP_ID}-inline-controls`);
        if (controls) return controls;

        controls = document.createElement('div');
        controls.id = `${APP_ID}-inline-controls`;
        controls.hidden = true;

        const indexButton = document.createElement('button');
        indexButton.id = `${APP_ID}-index-button`;
        indexButton.type = 'button';
        setTextIfChanged(indexButton, makeIndexButtonLabel({
            syncing: state.syncing,
            pendingCount: state.pendingCollections.length
        }));
        indexButton.addEventListener('click', () => {
            if (state.pendingCollections.length) {
                syncCollections({ precheckedMetas: state.pendingCollections.slice() });
            } else {
                syncCollections({ force: true });
            }
        });

        const status = document.createElement('span');
        status.id = `${APP_ID}-status`;
        setTextIfChanged(status, state.statusText);

        controls.append(indexButton, status);
        document.body.appendChild(controls);
        return controls;
    }

    function positionInlineControls() {
        const controls = ensureInlineControls();
        const nativeSearch = findVisibleNativeCollectionSearchInput();
        if (!nativeSearch || !isCreatedCollectionsRoute()) {
            controls.hidden = true;
            return;
        }

        const inputRect = nativeSearch.getBoundingClientRect();
        const card = nativeSearch.closest('.Card') || document.querySelector('.Profile-mainColumn') || document.querySelector('main') || document.body;
        const cardRect = card.getBoundingClientRect();
        controls.hidden = false;
        controls.style.left = `${Math.max(12, cardRect.left + 22)}px`;
        controls.style.top = `${inputRect.top}px`;
        controls.style.maxWidth = `${Math.max(260, inputRect.left - cardRect.left - 36)}px`;
    }

    function findVisibleNativeCollectionSearchInput() {
        const inputs = Array.from(document.querySelectorAll('input[placeholder="搜索你的收藏"]'));
        const selected = selectVisibleSearchAnchor(inputs.map((input) => ({
            element: input,
            insideMain: Boolean(input.closest('main')),
            rect: input.getBoundingClientRect()
        })));

        return selected ? selected.element : null;
    }

    function findFollowingCollectionLink() {
        return Array.from(document.querySelectorAll('a[href*="/collections/following"]'))
            .find((link) => normalizeSpace(link.textContent) === '我关注的收藏夹');
    }

    function ensureResultTab() {
        if (!isCreatedCollectionsRoute()) return null;

        const following = findFollowingCollectionLink();
        if (!following) return null;

        let tab = document.getElementById(`${APP_ID}-result-tab`);
        if (!tab) {
            tab = document.createElement('button');
            tab.id = `${APP_ID}-result-tab`;
            tab.type = 'button';
            tab.addEventListener('click', openPanel);
            following.insertAdjacentElement('afterend', tab);
        } else if (tab.previousElementSibling !== following) {
            following.insertAdjacentElement('afterend', tab);
        }

        updateResultTab();
        return tab;
    }

    function updateResultTab() {
        const tab = document.getElementById(`${APP_ID}-result-tab`);
        if (!tab) return;
        setTextIfChanged(tab, makeResultTabLabel(state.statusText));
        tab.classList.toggle(`${APP_ID}-active`, state.panelOpen);
    }

    function ensurePanel() {
        let backdrop = document.getElementById(`${APP_ID}-backdrop`);
        if (backdrop && backdrop.dataset.zcftsPanelGuardVersion === PANEL_EVENT_GUARD_VERSION) {
            return backdrop;
        }
        if (backdrop) {
            backdrop.remove();
        }

        backdrop = document.createElement('div');
        backdrop.id = `${APP_ID}-backdrop`;
        backdrop.hidden = true;
        backdrop.dataset.zcftsPanelGuardVersion = PANEL_EVENT_GUARD_VERSION;

        const panel = document.createElement('section');
        panel.id = `${APP_ID}-panel`;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');

        const header = document.createElement('header');
        header.id = `${APP_ID}-panel-header`;

        const title = document.createElement('div');
        title.id = `${APP_ID}-panel-title`;

        const search = document.createElement('input');
        search.id = `${APP_ID}-panel-search`;
        search.type = 'search';
        search.placeholder = '全文搜索收藏';
        search.autocomplete = 'off';
        search.value = state.query;
        search.addEventListener('input', () => {
            state.query = search.value;
            const inline = document.getElementById(`${APP_ID}-query`);
            if (inline) inline.value = state.query;
            updateSearchResults();
        });

        const close = document.createElement('button');
        close.id = `${APP_ID}-panel-close`;
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.textContent = '×';
        close.addEventListener('click', closePanel);

        const body = document.createElement('div');
        body.id = `${APP_ID}-panel-body`;

        header.append(title, search, close);
        panel.append(header, body);
        backdrop.append(panel);
        installResultPanelEventGuards(backdrop, panel);
        document.body.appendChild(backdrop);
        return backdrop;
    }

    function installResultPanelEventGuards(backdrop, panel) {
        const stopProtectedEvent = (event) => {
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
        };

        const stopBackdropEvent = (event) => {
            event.stopPropagation();
            if (event.type === 'click' && shouldCloseResultPanelFromClick(getResultPanelClickInfo(event.target))) {
                closePanel(event);
            }
        };

        for (const eventName of getResultPanelProtectedEvents()) {
            panel.addEventListener(eventName, stopProtectedEvent);
            backdrop.addEventListener(eventName, stopBackdropEvent);
        }
    }

    function openPanel() {
        state.panelOpen = true;
        const backdrop = ensurePanel();
        backdrop.hidden = false;
        renderPanel();
        updateResultTab();
        const search = document.getElementById(`${APP_ID}-panel-search`);
        if (search) search.focus();
    }

    function closePanel(event) {
        if (event && typeof event === 'object' && 'target' in event && !shouldCloseResultPanelFromClick(getResultPanelClickInfo(event.target))) {
            event.stopPropagation?.();
            return;
        }
        event?.preventDefault?.();
        event?.stopPropagation?.();
        state.panelOpen = false;
        const backdrop = document.getElementById(`${APP_ID}-backdrop`);
        if (backdrop) backdrop.hidden = true;
        updateResultTab();
    }

    function syncPanelSearchValue() {
        const panelSearch = document.getElementById(`${APP_ID}-panel-search`);
        if (panelSearch && panelSearch.value !== state.query) {
            panelSearch.value = state.query;
        }
    }

    function renderPanel() {
        const title = document.getElementById(`${APP_ID}-panel-title`);
        const body = document.getElementById(`${APP_ID}-panel-body`);
        const search = document.getElementById(`${APP_ID}-panel-search`);
        if (!title || !body) return;

        setTextIfChanged(title, `搜索结果(${state.results.length})`);
        if (search && search.value !== state.query) search.value = state.query;
        body.replaceChildren();

        if (!normalizeSpace(state.query)) {
            body.append(createEmptyMessage(state.records.length ? '输入关键词后显示全文搜索结果。' : '还没有本地索引，请先点击“全文索引”。'));
            return;
        }

        if (!state.records.length) {
            body.append(createEmptyMessage(state.syncing ? '正在建立索引，完成后会显示结果。' : '还没有本地索引，请先点击“全文索引”。'));
            return;
        }

        if (!state.results.length) {
            body.append(createEmptyMessage('没有匹配结果。'));
            return;
        }

        const terms = getSearchTerms(state.query);
        state.results.slice(0, 200).forEach((record) => {
            body.append(createResultElement(record, terms));
        });

        if (state.results.length > 200) {
            body.append(createEmptyMessage(`仅显示前 200 条，共 ${state.results.length} 条结果。`));
        }
    }

    function createEmptyMessage(text) {
        const empty = document.createElement('div');
        empty.className = `${APP_ID}-empty`;
        setTextIfChanged(empty, text);
        return empty;
    }

    function createResultElement(record, terms) {
        const item = document.createElement('article');
        item.className = `${APP_ID}-result`;

        const title = document.createElement(record.url ? 'a' : 'span');
        title.className = `${APP_ID}-result-title`;
        setTextIfChanged(title, record.title || '无标题');
        if (record.url) {
            title.href = record.url;
            title.target = '_blank';
            title.rel = 'noopener noreferrer';
        }

        const collection = document.createElement('span');
        collection.className = `${APP_ID}-collection`;
        setTextIfChanged(collection, record.collectionTitle || '未命名收藏夹');

        const snippet = document.createElement('div');
        snippet.className = `${APP_ID}-snippet`;
        appendHighlightedText(snippet, record.snippet || record.text || record.title || '', terms);

        item.append(title, collection, snippet);
        return item;
    }

    function appendHighlightedText(parent, text, terms) {
        const source = String(text || '');
        const lower = source.toLowerCase();
        let cursor = 0;

        while (cursor < source.length) {
            let bestIndex = -1;
            let bestTerm = '';

            for (const term of terms) {
                const index = lower.indexOf(term, cursor);
                if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
                    bestIndex = index;
                    bestTerm = term;
                }
            }

            if (bestIndex < 0) {
                parent.append(document.createTextNode(source.slice(cursor)));
                break;
            }

            if (bestIndex > cursor) {
                parent.append(document.createTextNode(source.slice(cursor, bestIndex)));
            }

            const mark = document.createElement('mark');
            mark.textContent = source.slice(bestIndex, bestIndex + bestTerm.length);
            parent.append(mark);
            cursor = bestIndex + bestTerm.length;
        }
    }

    async function setupForRoute() {
        const token = getUserToken();
        const routeKey = `${location.pathname}|${token}`;

        if (!token || !isCreatedCollectionsRoute()) {
            hideRouteUi();
            return;
        }

        if (state.routeKey !== routeKey) {
            state.routeKey = routeKey;
            state.userToken = token;
            state.checkStartedForRoute = '';
            state.pendingCollections = [];
            state.query = '';
            state.results = [];
            closePanel();
            updateResultTab();
        }

        installStyles();
        ensureInlineControls();
        ensureResultTab();
        positionInlineControls();

        try {
            await loadCachedIndex();
        } catch (error) {
            console.warn('[Zhihu Collections Full Text Search] 读取缓存失败', error);
            updateStatusText(`读取缓存失败：${error.message}`);
        }

        if (state.checkStartedForRoute !== routeKey) {
            state.checkStartedForRoute = routeKey;
            setTimeout(checkCollectionUpdates, AUTO_CHECK_DELAY);
        }
    }

    function hideRouteUi() {
        const controls = document.getElementById(`${APP_ID}-inline-controls`);
        if (controls) controls.hidden = true;
        const tab = document.getElementById(`${APP_ID}-result-tab`);
        if (tab) tab.remove();
        closePanel();
    }

    function scheduleSetup() {
        clearTimeout(state.routeTimer);
        state.routeTimer = setTimeout(setupForRoute, 120);
    }

    function installNavigationHooks() {
        if (window.__zcftsNavigationHooked) return;
        window.__zcftsNavigationHooked = true;

        const wrapHistoryMethod = (methodName) => {
            const original = history[methodName];
            history[methodName] = function(...args) {
                const result = original.apply(this, args);
                window.dispatchEvent(new Event(`${APP_ID}:routechange`));
                return result;
            };
        };

        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');
        window.addEventListener('popstate', scheduleSetup);
        window.addEventListener(`${APP_ID}:routechange`, scheduleSetup);
    }

    function installMutationObserver() {
        if (state.mutationObserver) return;

        state.mutationObserver = new MutationObserver((mutations) => {
            if (mutations.length && mutations.every(isOwnMutation)) return;
            scheduleUiUpdate();
        });
        state.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function isOwnMutation(mutation) {
        const nodes = [
            mutation.target,
            ...Array.from(mutation.addedNodes || []),
            ...Array.from(mutation.removedNodes || [])
        ];

        return nodes.every((node) => {
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return true;
            return isOwnElement(node);
        });
    }

    function isOwnElement(element) {
        if (!element || typeof element.closest !== 'function') return false;
        return Boolean(
            element.closest(`#${APP_ID}-inline-controls`) ||
            element.closest(`#${APP_ID}-result-tab`) ||
            element.closest(`#${APP_ID}-backdrop`) ||
            element.closest(`#${APP_ID}-style`)
        );
    }

    function scheduleUiUpdate() {
        if (state.uiUpdateScheduled) return;
        state.uiUpdateScheduled = true;

        const run = () => {
            state.uiUpdateScheduled = false;
            ensureResultTab();
            positionInlineControls();
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 50);
        }
    }

    function schedulePositionUpdate() {
        if (state.positionUpdateScheduled) return;
        state.positionUpdateScheduled = true;

        const run = () => {
            state.positionUpdateScheduled = false;
            positionInlineControls();
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 16);
        }
    }

    function installViewportPositioningListeners() {
        if (state.positioningListenersInstalled) return;
        state.positioningListenersInstalled = true;

        const options = { passive: true, capture: true };
        for (const eventName of getImmediatePositioningEvents()) {
            window.addEventListener(eventName, schedulePositionUpdate, options);
            document.addEventListener(eventName, schedulePositionUpdate, options);
        }

        if (window.visualViewport) {
            window.visualViewport.addEventListener('scroll', schedulePositionUpdate, { passive: true });
            window.visualViewport.addEventListener('resize', schedulePositionUpdate, { passive: true });
        }
    }

    function startPositioningLoop() {
        if (state.positioningTimer) return;
        state.positioningTimer = setInterval(positionInlineControls, 2000);
    }

    function init() {
        installNavigationHooks();
        installMutationObserver();
        installViewportPositioningListeners();
        startPositioningLoop();
        scheduleSetup();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
