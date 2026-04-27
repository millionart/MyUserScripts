// ==UserScript==
// @name        YouTube Subscription Category Manager (v2.0.0 Rebuilt)
// @description 为 YouTube 左侧订阅列表添加分类管理、筛选和右键分类功能，兼容新版页面结构与 SPA 路由切换。
// @version     2.0.0
// @match       https://*.youtube.com/*
// @icon        https://www.youtube.com/s/desktop/0aaf30d6/img/favicon_32x32.png
// @grant       GM.setValue
// @grant       GM.getValue
// @grant       GM_addStyle
// @run-at      document-idle
// @namespace   http://tampermonkey.net/
// ==/UserScript==

(function() {
'use strict';

const STORAGE_KEY = 'yt_subscription_data';
const DEFAULT_CATEGORIES = ['技术', '娱乐', '教育', '游戏', '音乐', '新闻'];
const UI_ROOT_CLASS = 'yt-category-filter';
const CONTEXT_MENU_CLASS = 'yt-context-menu';
const ENTRY_SELECTOR = 'ytd-guide-entry-renderer';
const SIDEBAR_SECTION_SELECTOR = 'ytd-guide-section-renderer, ytd-guide-collapsible-section-entry-renderer';

let contextMenu = null;
let currentChannelInfo = null;
let currentFilter = 'all';
let observer = null;
let documentEventsBound = false;
let navigationEventsBound = false;

function log(...args) {
    console.log('[YT Category Manager]', ...args);
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function injectStyles() {
    const css = `
        .yt-category-filter{padding:12px 0;background-color:transparent;border-top:1px solid rgba(255,255,255,0.1);margin:0 12px;}
        .yt-category-filter-title{font-size:14px;font-weight:500;color:var(--yt-spec-text-primary);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;padding:0 12px;gap:8px;}
        .yt-category-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .yt-category-buttons{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px;}
        .yt-category-btn{padding:4px 10px;font-size:12px;border-radius:999px;border:1px solid rgba(255,255,255,0.2);background-color:transparent;color:var(--yt-spec-text-secondary);cursor:pointer;transition:all 0.2s;}
        .yt-category-btn:hover{background-color:rgba(255,255,255,0.1);color:var(--yt-spec-text-primary);}
        .yt-category-btn.active{background-color:#065fd4;color:#fff;border-color:#065fd4;}
        .yt-manage-btn{padding:2px 8px;font-size:11px;border-radius:999px;border:1px solid rgba(255,255,255,0.2);background-color:transparent;color:var(--yt-spec-text-secondary);cursor:pointer;transition:all 0.2s;white-space:nowrap;}
        .yt-manage-btn:hover{background-color:rgba(255,255,255,0.1);color:var(--yt-spec-text-primary);}
        .${CONTEXT_MENU_CLASS}{position:fixed;background-color:#282828;border:1px solid #3f3f3f;border-radius:8px;padding:8px 0;min-width:190px;box-shadow:0 8px 24px rgba(0,0,0,0.55);z-index:10000;display:none;}
        .${CONTEXT_MENU_CLASS}.show{display:block;}
        .yt-context-menu-item{padding:8px 16px;color:#fff;cursor:pointer;font-size:13px;transition:background-color 0.2s;user-select:none;}
        .yt-context-menu-item:hover{background-color:#3f3f3f;}
        .yt-context-menu-divider{height:1px;background-color:#3f3f3f;margin:4px 0;}
        .yt-dialog-overlay{position:fixed;inset:0;background-color:rgba(0,0,0,0.75);z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;}
        .yt-dialog{background-color:#282828;border-radius:12px;padding:24px;min-width:400px;max-width:520px;width:100%;box-shadow:0 12px 32px rgba(0,0,0,0.65);box-sizing:border-box;}
        .yt-dialog-title{font-size:18px;font-weight:500;color:#fff;margin-bottom:16px;}
        .yt-dialog-input{width:100%;padding:10px 12px;background-color:#121212;border:1px solid #3f3f3f;border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box;}
        .yt-dialog-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}
        .yt-dialog-btn{padding:8px 16px;border-radius:999px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:all 0.2s;}
        .yt-dialog-btn-primary{background-color:#065fd4;color:#fff;}
        .yt-dialog-btn-secondary{background-color:#3f3f3f;color:#fff;}
        .yt-category-list{margin-bottom:16px;max-height:320px;overflow-y:auto;}
        .yt-category-list-item{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background-color:#121212;border-radius:8px;margin-bottom:8px;transition:opacity 0.2s,border 0.2s;gap:10px;}
        .yt-category-list-item[draggable="true"]{cursor:move;}
        .yt-category-list-item.dragging{opacity:0.5;}
        .yt-category-list-item.drag-over-bottom{border-bottom:2px solid #065fd4;}
        .yt-category-list-item.drag-over-top{border-top:2px solid #065fd4;}
        .yt-category-list-item-name{color:#fff;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .yt-category-list-item-actions{display:flex;align-items:center;gap:6px;}
        .yt-category-list-item-btn{padding:4px 8px;background-color:transparent;border:1px solid #555;color:#aaa;border-radius:999px;cursor:pointer;font-size:12px;transition:all 0.2s;}
        .yt-category-list-item-btn:hover{background-color:#3f3f3f;color:#fff;}
        .yt-category-list-item-delete{border-color:#f44336;color:#f44336;}
        .yt-category-list-item-delete:hover{background-color:#f44336;color:#fff;}
    `;

    if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(css);
        return;
    }

    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
}

async function getData() {
    const rawData = await GM.getValue(STORAGE_KEY);
    if (rawData) {
        try {
            const parsed = JSON.parse(rawData);
            return {
                categoryOrder: Array.isArray(parsed.categoryOrder) && parsed.categoryOrder.length ? parsed.categoryOrder : [...DEFAULT_CATEGORIES],
                channelsByCategory: parsed.channelsByCategory && typeof parsed.channelsByCategory === 'object' ? parsed.channelsByCategory : {}
            };
        } catch (error) {
            console.error('[YT Category Manager] Failed to parse stored data:', error);
        }
    }

    return {
        categoryOrder: [...DEFAULT_CATEGORIES],
        channelsByCategory: {}
    };
}

async function saveData(data) {
    await GM.setValue(STORAGE_KEY, JSON.stringify(data));
}

async function getCategoriesList() {
    const data = await getData();
    return data.categoryOrder;
}

async function saveCategoriesList(categories) {
    const data = await getData();
    data.categoryOrder = [...categories];
    await saveData(data);
}

async function saveChannelCategory(channelInfoOrId, newCategory) {
    const channelInfo = normalizeChannelInfo(channelInfoOrId);
    if (!channelInfo || !channelInfo.ids.length) return;

    const data = await getData();
    if (!data.channelsByCategory) data.channelsByCategory = {};
    const lookups = buildStoredChannelLookups(data);
    const existingStoredId = resolveStoredIdForInfo(channelInfo, data, lookups);
    const idsToRemove = new Set([existingStoredId, ...channelInfo.ids].filter(Boolean));

    Object.keys(data.channelsByCategory).forEach((category) => {
        const channelIds = data.channelsByCategory[category];
        if (!Array.isArray(channelIds)) {
            delete data.channelsByCategory[category];
            return;
        }

        for (let index = channelIds.length - 1; index >= 0; index -= 1) {
            if (idsToRemove.has(normalizeChannelKey(channelIds[index]))) {
                channelIds.splice(index, 1);
            }
        }

        if (!channelIds.length) delete data.channelsByCategory[category];
    });

    if (newCategory) {
        if (!data.channelsByCategory[newCategory]) {
            data.channelsByCategory[newCategory] = [];
        }
        const storedId = existingStoredId || channelInfo.ids[0];
        if (!data.channelsByCategory[newCategory].some((existingId) => normalizeChannelKey(existingId) === storedId)) {
            data.channelsByCategory[newCategory].push(storedId);
        }
    }

    await saveData(data);
}

function normalizeUrl(rawUrl) {
    try {
        return new URL(rawUrl, location.origin);
    } catch {
        return null;
    }
}

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

function normalizeChannelInfo(channelInfoOrId) {
    if (!channelInfoOrId) return null;

    if (typeof channelInfoOrId === 'string') {
        const id = normalizeChannelKey(channelInfoOrId);
        return id ? { ids: [id], looseTokens: [normalizeLooseChannelToken(id)].filter(Boolean) } : null;
    }

    const ids = Array.isArray(channelInfoOrId.ids)
        ? [...new Set(channelInfoOrId.ids.map(normalizeChannelKey).filter(Boolean))]
        : [];
    const looseTokens = Array.isArray(channelInfoOrId.looseTokens)
        ? [...new Set(channelInfoOrId.looseTokens.map(normalizeLooseChannelToken).filter(Boolean))]
        : [];

    return { ids, looseTokens };
}

function buildStoredChannelLookups(data) {
    const exactCategoryMap = {};
    const exactToStoredId = {};
    const looseToStoredId = {};
    const storedIds = [];

    Object.entries(data.channelsByCategory || {}).forEach(([category, channelIds]) => {
        if (!Array.isArray(channelIds)) return;

        channelIds.forEach((channelId) => {
            const normalizedId = normalizeChannelKey(channelId);
            if (!normalizedId) return;

            exactCategoryMap[normalizedId] = category;
            exactToStoredId[normalizedId] = normalizedId;
            storedIds.push(normalizedId);

            const loose = normalizeLooseChannelToken(normalizedId);
            if (loose && !looseToStoredId[loose]) {
                looseToStoredId[loose] = normalizedId;
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

function collectEntryChannelInfo(entry) {
    if (!(entry instanceof Element)) return null;

    const ids = [];
    const looseTokens = [];
    const links = Array.from(entry.querySelectorAll('a[href]'));

    links.forEach((link) => {
        const id = extractChannelId(link.href);
        if (id) ids.push(id);

        const textCandidates = [
            link.getAttribute('title') || '',
            link.getAttribute('aria-label') || '',
            link.innerText || link.textContent || ''
        ];

        textCandidates.forEach((candidate) => {
            splitChannelTextCandidates(candidate).forEach((part) => {
                const token = normalizeLooseChannelToken(part);
                if (token) looseTokens.push(token);
            });
        });
    });

    splitChannelTextCandidates(entry.textContent || '').forEach((part) => {
        const token = normalizeLooseChannelToken(part);
        if (token) looseTokens.push(token);
    });

    return normalizeChannelInfo({ ids, looseTokens });
}

function resolveStoredIdForInfo(channelInfoOrId, data, lookups = buildStoredChannelLookups(data)) {
    const channelInfo = normalizeChannelInfo(channelInfoOrId);
    if (!channelInfo) return null;

    for (const id of channelInfo.ids) {
        if (lookups.exactToStoredId[id]) return lookups.exactToStoredId[id];
    }

    for (const token of channelInfo.looseTokens) {
        if (lookups.looseToStoredId[token]) return lookups.looseToStoredId[token];
    }

    const fuzzyMatch = findUniqueLooseSubstringMatch(channelInfo.looseTokens, lookups);
    if (fuzzyMatch) return fuzzyMatch;

    return null;
}

function resolveCategoryForInfo(channelInfoOrId, data, lookups = buildStoredChannelLookups(data)) {
    const storedId = resolveStoredIdForInfo(channelInfoOrId, data, lookups);
    if (!storedId) return null;
    return lookups.exactCategoryMap[storedId] || null;
}

function extractChannelId(urlLike) {
    const url = normalizeUrl(urlLike);
    if (!url || !url.hostname.includes('youtube.com')) return null;

    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return null;

    if (path.startsWith('/channel/')) return normalizeChannelKey(path.slice('/channel/'.length));
    if (path.startsWith('/@')) return normalizeChannelKey(path.slice(2));
    if (path.startsWith('/c/')) return normalizeChannelKey(path.slice('/c/'.length));
    if (path.startsWith('/user/')) return normalizeChannelKey(path.slice('/user/'.length));

    return null;
}

function isFeedUrl(urlLike) {
    const url = normalizeUrl(urlLike);
    return !!url && url.pathname.startsWith('/feed/');
}

function getGuideEntryElementFromNode(node) {
    if (!(node instanceof Element)) return null;
    return node.closest(ENTRY_SELECTOR);
}

function getChannelLinkFromEntry(entry) {
    if (!(entry instanceof Element)) return null;

    const links = Array.from(entry.querySelectorAll('a[href]'));
    return links.find((link) => {
        const channelId = extractChannelId(link.href);
        return !!channelId && !isFeedUrl(link.href);
    }) || null;
}

function getChannelEntries() {
    const entries = Array.from(document.querySelectorAll(ENTRY_SELECTOR));
    return entries
        .map((entry) => {
            const link = getChannelLinkFromEntry(entry);
            if (!link) return null;

            return {
                entry,
                link,
                channelInfo: collectEntryChannelInfo(entry)
            };
        })
        .filter(Boolean);
}

function findSubscriptionsGuideLink() {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const supportedPaths = ['/feed/channels', '/feed/subscriptions'];

    for (const path of supportedPaths) {
        const match = links.find((link) => {
            const url = normalizeUrl(link.href);
            if (!url || !url.hostname.includes('youtube.com')) return false;
            return url.pathname === path;
        });

        if (match) return match;
    }

    return null;
}

function findSidebarItemsContainer() {
    const subscriptionsLink = findSubscriptionsGuideLink();
    if (!subscriptionsLink) return null;

    const section = subscriptionsLink.closest(SIDEBAR_SECTION_SELECTOR);
    if (!section) return null;

    return section.querySelector('#items, #section-items, yt-formatted-string') ? section.querySelector('#items, #section-items') || section : section;
}

function findSubscriptionsSection() {
    const subscriptionsLink = findSubscriptionsGuideLink();
    return subscriptionsLink ? subscriptionsLink.closest(SIDEBAR_SECTION_SELECTOR) : null;
}

function getRenderedSubscriptionEntryCount() {
    return Array.from(document.querySelectorAll(ENTRY_SELECTOR)).filter((entry) => {
        const href = entry.querySelector('a[href]')?.getAttribute('href') || '';
        return href.startsWith('/@') || href.startsWith('/channel/') || href.startsWith('/c/') || href.startsWith('/user/');
    }).length;
}

function getSubscriptionsExpander(section) {
    const scopes = [
        section,
        document
    ].filter(Boolean);

    for (const scope of scopes) {
        const expanderItem = scope.querySelector('ytd-guide-entry-renderer#expander-item');
        if (expanderItem) return expanderItem;

        const candidates = Array.from(scope.querySelectorAll('#expander-item, button, a, tp-yt-paper-item'));
        const fallback = candidates.find((element) => {
            const text = (element.getAttribute('title') || element.getAttribute('aria-label') || element.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();

            if (!text) return false;
            if (/隐藏|收起|Hide/i.test(text)) return false;
            return /展开|更多|Show more/i.test(text);
        }) || null;

        if (fallback) return fallback;
    }

    return null;
}

async function ensureSubscriptionsExpanded() {
    const beforeCount = getRenderedSubscriptionEntryCount();
    if (beforeCount > 20) return false;

    const section = findSubscriptionsSection();
    const expander = getSubscriptionsExpander(section);
    if (!expander) return false;

    expander.click();

    const maxWaitMs = 2000;
    const stepMs = 100;
    let waited = 0;

    while (waited < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        if (getRenderedSubscriptionEntryCount() > beforeCount) {
            return true;
        }
        waited += stepMs;
    }

    return true;
}

async function waitForSubscriptionEntriesToSettle() {
    let previousCount = -1;
    let stableRounds = 0;
    const maxRounds = 20;

    for (let round = 0; round < maxRounds; round += 1) {
        const currentCount = getRenderedSubscriptionEntryCount();

        if (currentCount === previousCount) {
            stableRounds += 1;
        } else {
            stableRounds = 0;
            previousCount = currentCount;
        }

        if (currentCount > 20 && stableRounds >= 2) {
            return currentCount;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return getRenderedSubscriptionEntryCount();
}

async function filterSubscriptions(category) {
    currentFilter = category || 'all';
    await ensureSubscriptionsExpanded();
    await waitForSubscriptionEntriesToSettle();
    const data = await getData();
    const lookups = buildStoredChannelLookups(data);
    const entries = getChannelEntries();

    entries.forEach(({ entry, channelInfo }) => {
        const assignedCategory = resolveCategoryForInfo(channelInfo, data, lookups);
        let visible = true;

        if (currentFilter === 'uncategorized') {
            visible = !assignedCategory;
        } else if (currentFilter !== 'all') {
            visible = assignedCategory === currentFilter;
        }

        entry.style.display = visible ? '' : 'none';
    });
}

function createFilterButton(text, category) {
    const button = document.createElement('button');
    button.className = 'yt-category-btn';
    button.textContent = text;
    button.dataset.category = category;
    button.addEventListener('click', async () => {
        document.querySelectorAll('.yt-category-btn.active').forEach((el) => el.classList.remove('active'));
        button.classList.add('active');
        await filterSubscriptions(category);
    });
    return button;
}

async function updateCategoryUI() {
    const root = document.querySelector(`.${UI_ROOT_CLASS}`);
    if (!root) return;

    const buttonsDiv = root.querySelector('.yt-category-buttons');
    if (!buttonsDiv) return;

    const categories = await getCategoriesList();
    buttonsDiv.replaceChildren();
    buttonsDiv.appendChild(createFilterButton('全部', 'all'));
    categories.forEach((category) => buttonsDiv.appendChild(createFilterButton(category, category)));
    buttonsDiv.appendChild(createFilterButton('未分类', 'uncategorized'));

    const nextActive = Array.from(buttonsDiv.querySelectorAll('.yt-category-btn'))
        .find((button) => button.dataset.category === currentFilter) || buttonsDiv.querySelector('.yt-category-btn');

    if (nextActive) {
        nextActive.classList.add('active');
        await filterSubscriptions(nextActive.dataset.category);
    }

    if (contextMenu) {
        contextMenu.remove();
        contextMenu = null;
    }
}

function ensureContextMenuWithinViewport(x, y) {
    const width = contextMenu.offsetWidth || 190;
    const height = contextMenu.offsetHeight || 200;
    const left = Math.min(x, window.innerWidth - width - 8);
    const top = Math.min(y, window.innerHeight - height - 8);

    contextMenu.style.left = `${Math.max(8, left)}px`;
    contextMenu.style.top = `${Math.max(8, top)}px`;
}

function hideContextMenu() {
    if (contextMenu) contextMenu.classList.remove('show');
}

async function createContextMenu() {
    if (contextMenu) contextMenu.remove();

    const categories = await getCategoriesList();
    contextMenu = document.createElement('div');
    contextMenu.className = CONTEXT_MENU_CLASS;

    const createItem = (text, dataset) => {
        const item = document.createElement('div');
        item.className = 'yt-context-menu-item';
        item.textContent = text;
        item.dataset.rawText = text;
        Object.entries(dataset).forEach(([key, value]) => {
            item.dataset[key] = value;
        });

        item.addEventListener('click', async () => {
            if (dataset.category) {
                await saveChannelCategory(currentChannelInfo, dataset.category);
            } else if (dataset.action === 'remove-category') {
                await saveChannelCategory(currentChannelInfo, null);
            } else if (dataset.action === 'set-category') {
                hideContextMenu();
                showAddCategoryDialog();
                return;
            }

            await updateCategoryUI();
            hideContextMenu();
        });

        return item;
    };

    const createDivider = () => {
        const divider = document.createElement('div');
        divider.className = 'yt-context-menu-divider';
        return divider;
    };

    contextMenu.appendChild(createItem('设置分类...', { action: 'set-category' }));
    contextMenu.appendChild(createDivider());
    categories.forEach((category) => {
        contextMenu.appendChild(createItem(category, { category }));
    });
    contextMenu.appendChild(createDivider());
    contextMenu.appendChild(createItem('移除分类', { action: 'remove-category' }));
    document.body.appendChild(contextMenu);
}

async function showContextMenu(x, y, channelInfo) {
    const normalizedInfo = normalizeChannelInfo(channelInfo);
    if (!normalizedInfo || !normalizedInfo.ids.length) return;
    if (!contextMenu) await createContextMenu();

    currentChannelInfo = normalizedInfo;
    const data = await getData();
    const lookups = buildStoredChannelLookups(data);
    const currentCategory = resolveCategoryForInfo(normalizedInfo, data, lookups);

    contextMenu.querySelectorAll('.yt-context-menu-item').forEach((item) => {
        item.textContent = item.dataset.rawText;
        if (item.dataset.category === currentCategory || (!currentCategory && item.dataset.action === 'remove-category')) {
            item.textContent = `✓ ${item.dataset.rawText}`;
        }
    });

    contextMenu.classList.add('show');
    ensureContextMenuWithinViewport(x, y);
}

function showAddCategoryDialog() {
    if (document.querySelector('.yt-dialog-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'yt-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'yt-dialog';

    const title = document.createElement('div');
    title.className = 'yt-dialog-title';
    title.textContent = '添加新分类';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'yt-dialog-input';
    input.placeholder = '输入分类名称';

    const buttons = document.createElement('div');
    buttons.className = 'yt-dialog-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'yt-dialog-btn yt-dialog-btn-secondary';
    cancelBtn.textContent = '取消';

    const addBtn = document.createElement('button');
    addBtn.className = 'yt-dialog-btn yt-dialog-btn-primary';
    addBtn.textContent = '添加';

    const closeDialog = () => overlay.remove();

    addBtn.addEventListener('click', async () => {
        const categoryName = input.value.trim();
        if (!categoryName) return;

        const categories = await getCategoriesList();
        if (!categories.includes(categoryName)) {
            categories.push(categoryName);
            await saveCategoriesList(categories);
        }

        if (currentChannelInfo) {
            await saveChannelCategory(currentChannelInfo, categoryName);
        }

        await updateCategoryUI();
        closeDialog();
    });

    cancelBtn.addEventListener('click', closeDialog);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeDialog();
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addBtn.click();
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(addBtn);
    dialog.appendChild(title);
    dialog.appendChild(input);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
}

async function showManageCategoriesDialog() {
    if (document.querySelector('.yt-dialog-overlay')) return;

    let categories = await getCategoriesList();

    const overlay = document.createElement('div');
    overlay.className = 'yt-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'yt-dialog';

    const title = document.createElement('div');
    title.className = 'yt-dialog-title';
    title.textContent = '管理分类（拖拽排序）';

    const listEl = document.createElement('div');
    listEl.className = 'yt-category-list';

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'yt-dialog-input';
    inputEl.placeholder = '添加新分类...（回车确认）';

    const buttons = document.createElement('div');
    buttons.className = 'yt-dialog-buttons';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'yt-dialog-btn yt-dialog-btn-primary';
    closeBtn.textContent = '关闭';

    buttons.appendChild(closeBtn);
    dialog.appendChild(title);
    dialog.appendChild(listEl);
    dialog.appendChild(inputEl);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    let draggedItem = null;

    const render = () => {
        listEl.replaceChildren();

        categories.forEach((category, index) => {
            const item = document.createElement('div');
            item.className = 'yt-category-list-item';
            item.dataset.categoryName = category;
            item.dataset.index = String(index);
            item.draggable = true;

            const name = document.createElement('span');
            name.className = 'yt-category-list-item-name';
            name.textContent = category;

            const actions = document.createElement('div');
            actions.className = 'yt-category-list-item-actions';

            const renameBtn = document.createElement('button');
            renameBtn.className = 'yt-category-list-item-btn';
            renameBtn.textContent = '重命名';
            renameBtn.dataset.action = 'rename';

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'yt-category-list-item-btn yt-category-list-item-delete';
            deleteBtn.textContent = '删除';
            deleteBtn.dataset.action = 'delete';

            actions.appendChild(renameBtn);
            actions.appendChild(deleteBtn);
            item.appendChild(name);
            item.appendChild(actions);
            listEl.appendChild(item);
        });
    };

    const persistCategoryOrder = async (nextCategories) => {
        categories = [...nextCategories];
        await saveCategoriesList(categories);
        render();
    };

    listEl.addEventListener('dragstart', (event) => {
        const target = event.target.closest('.yt-category-list-item');
        if (!target) return;

        draggedItem = target;
        event.dataTransfer.effectAllowed = 'move';
        setTimeout(() => target.classList.add('dragging'), 0);
    });

    listEl.addEventListener('dragend', () => {
        listEl.querySelectorAll('.yt-category-list-item').forEach((item) => {
            item.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
        });
        draggedItem = null;
    });

    listEl.addEventListener('dragover', (event) => {
        event.preventDefault();
        const target = event.target.closest('.yt-category-list-item');
        if (!target || target === draggedItem) return;

        const rect = target.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;

        listEl.querySelectorAll('.yt-category-list-item').forEach((item) => {
            item.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        target.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    });

    listEl.addEventListener('drop', async (event) => {
        event.preventDefault();
        const target = event.target.closest('.yt-category-list-item');
        if (!draggedItem || !target || target === draggedItem) return;

        const fromIndex = Number(draggedItem.dataset.index);
        const targetIndex = Number(target.dataset.index);
        const rect = target.getBoundingClientRect();
        const insertBefore = event.clientY < rect.top + rect.height / 2;
        const nextCategories = [...categories];
        const [moved] = nextCategories.splice(fromIndex, 1);

        let destination = targetIndex;
        if (!insertBefore) destination += 1;
        if (fromIndex < destination) destination -= 1;

        nextCategories.splice(destination, 0, moved);
        await persistCategoryOrder(nextCategories);
    });

    listEl.addEventListener('click', async (event) => {
        const button = event.target.closest('.yt-category-list-item-btn');
        if (!button) return;

        const item = button.closest('.yt-category-list-item');
        if (!item) return;

        const oldName = item.dataset.categoryName;
        const data = await getData();
        const nextCategories = [...categories];

        if (button.dataset.action === 'delete') {
            const index = nextCategories.indexOf(oldName);
            if (index >= 0) nextCategories.splice(index, 1);
            delete data.channelsByCategory[oldName];
        } else if (button.dataset.action === 'rename') {
            const newName = prompt(`重命名分类 "${oldName}"：`, oldName);
            if (!newName) return;

            const normalizedName = newName.trim();
            if (!normalizedName || normalizedName === oldName || nextCategories.includes(normalizedName)) return;

            const index = nextCategories.indexOf(oldName);
            if (index >= 0) nextCategories[index] = normalizedName;
            data.channelsByCategory[normalizedName] = data.channelsByCategory[oldName] || [];
            delete data.channelsByCategory[oldName];
        }

        data.categoryOrder = nextCategories;
        await saveData(data);
        categories = nextCategories;
        render();
    });

    inputEl.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();

        const newCategory = inputEl.value.trim();
        if (!newCategory || categories.includes(newCategory)) return;

        const nextCategories = [...categories, newCategory];
        inputEl.value = '';
        await persistCategoryOrder(nextCategories);
    });

    const closeDialog = async () => {
        overlay.remove();
        await updateCategoryUI();
    };

    closeBtn.addEventListener('click', closeDialog);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeDialog();
    });

    document.body.appendChild(overlay);
    render();
    inputEl.focus();
}

async function injectCategoryPanel() {
    const sidebarContainer = findSidebarItemsContainer();
    if (!sidebarContainer) return;
    await ensureSubscriptionsExpanded();
    await waitForSubscriptionEntriesToSettle();

    const existingRoot = document.querySelector(`.${UI_ROOT_CLASS}`);
    if (existingRoot && sidebarContainer.contains(existingRoot)) return;
    if (existingRoot && !document.body.contains(existingRoot)) {
        existingRoot.remove();
    }

    const panel = document.createElement('div');
    panel.className = UI_ROOT_CLASS;

    const title = document.createElement('div');
    title.className = 'yt-category-filter-title';

    const titleText = document.createElement('span');
    titleText.className = 'yt-category-title-text';
    titleText.textContent = '订阅分类';

    const manageBtn = document.createElement('button');
    manageBtn.className = 'yt-manage-btn';
    manageBtn.textContent = '管理';
    manageBtn.addEventListener('click', showManageCategoriesDialog);

    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'yt-category-buttons';

    title.appendChild(titleText);
    title.appendChild(manageBtn);
    panel.appendChild(title);
    panel.appendChild(buttonsDiv);

    const subscriptionsLink = findSubscriptionsGuideLink();
    const subscriptionsEntry = subscriptionsLink ? getGuideEntryElementFromNode(subscriptionsLink) : null;

    if (subscriptionsEntry && subscriptionsEntry.parentElement === sidebarContainer) {
        subscriptionsEntry.insertAdjacentElement('afterend', panel);
    } else if (sidebarContainer.firstElementChild) {
        sidebarContainer.insertBefore(panel, sidebarContainer.firstElementChild);
    } else {
        sidebarContainer.appendChild(panel);
    }

    await updateCategoryUI();
}

function bindDocumentEvents() {
    if (documentEventsBound) return;
    documentEventsBound = true;

    document.addEventListener('click', (event) => {
        if (contextMenu && !contextMenu.contains(event.target)) {
            hideContextMenu();
        }
    }, true);

    document.addEventListener('contextmenu', async (event) => {
        const entry = getGuideEntryElementFromNode(event.target);
        if (!entry) return;

        const link = getChannelLinkFromEntry(entry);
        if (!link) return;

        const channelInfo = collectEntryChannelInfo(entry);
        if (!channelInfo || !channelInfo.ids.length) return;

        event.preventDefault();
        event.stopPropagation();
        await showContextMenu(event.clientX, event.clientY, channelInfo);
    }, true);
}

function bindNavigationEvents() {
    if (navigationEventsBound) return;
    navigationEventsBound = true;

    const trigger = () => {
        scheduleRefresh();
    };

    window.addEventListener('yt-navigate-finish', trigger, true);
    window.addEventListener('yt-page-data-updated', trigger, true);
    window.addEventListener('popstate', trigger, true);
    window.addEventListener('resize', () => {
        if (contextMenu && contextMenu.classList.contains('show')) hideContextMenu();
    });
}

const scheduleRefresh = debounce(async () => {
    await injectCategoryPanel();
    await filterSubscriptions(currentFilter);
}, 150);

function startObservers() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
        scheduleRefresh();
    });

    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
    });
}

function startBootstrapPolling() {
    let attempts = 0;
    const timer = setInterval(() => {
        scheduleRefresh();
        attempts += 1;
        if (attempts >= 20) clearInterval(timer);
    }, 1000);
}

async function init() {
    injectStyles();
    bindDocumentEvents();
    bindNavigationEvents();
    await createContextMenu();
    await injectCategoryPanel();
    await filterSubscriptions(currentFilter);
    startObservers();
    startBootstrapPolling();
    log('v2.0.0 initialized');
}

init().catch((error) => {
    console.error('[YT Category Manager] Initialization failed:', error);
});

})();
