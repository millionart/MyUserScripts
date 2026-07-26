// ==UserScript==
// @name         Trello Markdown Table Viewer
// @name:zh-CN   Trello Markdown 表格查看器
// @namespace    https://github.com/millionart
// @version      1.2.0
// @description  Render Markdown table source in Trello card descriptions as accessible, theme-aware HTML tables.
// @description:zh-CN 将 Trello 卡片描述中的 Markdown 表格源码渲染为可读、可横向滚动且适配主题的表格。
// @author       codex
// @license      MIT
// @match        https://trello.com/*
// @match        https://*.trello.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '1.2.0';
    const GLOBAL_STATE_KEY = '__trelloMarkdownTableViewer';
    const STYLE_ID = 'trello-markdown-table-viewer-styles';
    const DESCRIPTION_SELECTOR = '[data-testid="description-content-area"]';
    const EDITOR_SELECTOR = '[data-testid="editor-content-container"] [contenteditable="true"][role="textbox"]';
    const SOURCE_ATTRIBUTE = 'data-tmtv-source';
    const RENDERED_ATTRIBUTE = 'data-tmtv-rendered';
    const EDITOR_PREVIEW_ATTRIBUTE = 'data-tmtv-editor-preview';
    const COMPACT_COLUMN_CHARACTER_LIMIT = 4;
    const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

    function splitMarkdownTableRow(line) {
        const source = String(line ?? '').replace(/\u00a0/g, ' ').trim();
        if (!source) return null;

        const cells = [];
        let cell = '';
        let codeDelimiterLength = 0;
        let sawColumnSeparator = false;
        let endedWithColumnSeparator = false;

        for (let index = 0; index < source.length; index += 1) {
            const character = source[index];

            if (character === '\\' && index + 1 < source.length) {
                const nextCharacter = source[index + 1];
                if (nextCharacter === '|' || nextCharacter === '\\') {
                    cell += nextCharacter;
                    index += 1;
                    endedWithColumnSeparator = false;
                    continue;
                }
                cell += character;
                endedWithColumnSeparator = false;
                continue;
            }

            if (character === '`') {
                let runLength = 1;
                while (source[index + runLength] === '`') runLength += 1;
                if (codeDelimiterLength === 0) {
                    codeDelimiterLength = runLength;
                } else if (codeDelimiterLength === runLength) {
                    codeDelimiterLength = 0;
                }
                cell += source.slice(index, index + runLength);
                index += runLength - 1;
                endedWithColumnSeparator = false;
                continue;
            }

            if (character === '|' && codeDelimiterLength === 0) {
                cells.push(cell.trim());
                cell = '';
                sawColumnSeparator = true;
                endedWithColumnSeparator = true;
                continue;
            }

            cell += character;
            endedWithColumnSeparator = false;
        }

        if (!sawColumnSeparator) return null;
        cells.push(cell.trim());

        if (source.startsWith('|') && cells[0] === '') cells.shift();
        if (endedWithColumnSeparator && cells[cells.length - 1] === '') cells.pop();

        return cells;
    }

    function getColumnAlignment(separatorCell) {
        const cell = String(separatorCell ?? '').trim();
        if (!TABLE_SEPARATOR_CELL_PATTERN.test(cell)) return null;
        if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
        if (cell.endsWith(':')) return 'right';
        return 'left';
    }

    function normalizeRow(cells, columnCount) {
        const normalized = cells.slice(0, columnCount);
        while (normalized.length < columnCount) normalized.push('');
        return normalized;
    }

    function parseMarkdownTableAt(lines, startIndex) {
        if (!Array.isArray(lines) || startIndex < 0 || startIndex + 1 >= lines.length) return null;

        const header = splitMarkdownTableRow(lines[startIndex]);
        const separator = splitMarkdownTableRow(lines[startIndex + 1]);
        if (!header?.length || !separator || separator.length !== header.length) return null;

        const alignments = separator.map(getColumnAlignment);
        if (alignments.some((alignment) => alignment === null)) return null;

        const rows = [];
        let endIndex = startIndex + 2;
        while (endIndex < lines.length) {
            if (!String(lines[endIndex] ?? '').trim()) break;
            const row = splitMarkdownTableRow(lines[endIndex]);
            if (!row) break;
            rows.push(normalizeRow(row, header.length));
            endIndex += 1;
        }

        return {
            type: 'table',
            startIndex,
            endIndex,
            header,
            alignments,
            rows
        };
    }

    function findMarkdownTableSegments(lines) {
        const sourceLines = Array.isArray(lines) ? lines.map((line) => String(line ?? '')) : [];
        const segments = [];
        let textStartIndex = 0;
        let index = 0;

        while (index < sourceLines.length - 1) {
            const table = parseMarkdownTableAt(sourceLines, index);
            if (!table) {
                index += 1;
                continue;
            }

            if (index > textStartIndex) {
                segments.push({
                    type: 'text',
                    lines: sourceLines.slice(textStartIndex, index)
                });
            }
            segments.push(table);
            index = table.endIndex;
            textStartIndex = index;
        }

        if (textStartIndex < sourceLines.length) {
            segments.push({
                type: 'text',
                lines: sourceLines.slice(textStartIndex)
            });
        }

        return segments;
    }

    function parseMarkdownTableText(text) {
        return findMarkdownTableSegments(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'))
            .filter((segment) => segment.type === 'table');
    }

    function getMarkdownTablePreviewModel(text) {
        const sourceText = String(text ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ');
        const tables = parseMarkdownTableText(sourceText);
        return {
            sourceText,
            tableCount: tables.length,
            tables
        };
    }

    function measureTextInChineseCharacterUnits(value) {
        return Array.from(String(value ?? '')).reduce((width, character) => {
            if (/\p{Mark}/u.test(character)) return width;
            return width + (character.codePointAt(0) <= 0xff ? 0.5 : 1);
        }, 0);
    }

    function getCellMaximumLineWidth(value) {
        const lines = String(value ?? '').split(/(?:<br\s*\/?>|\r?\n)/i);
        return Math.max(
            0,
            ...lines.map((line) => measureTextInChineseCharacterUnits(line.trim()))
        );
    }

    function isCompactTableColumn(tableModel, columnIndex, limit = COMPACT_COLUMN_CHARACTER_LIMIT) {
        if (!tableModel || !Number.isInteger(columnIndex) || columnIndex < 0) return false;
        const values = [
            tableModel.header?.[columnIndex] ?? '',
            ...(tableModel.rows ?? []).map((row) => row[columnIndex] ?? '')
        ];
        return values.every((value) => getCellMaximumLineWidth(value) <= limit);
    }

    function readElementLines(element) {
        const clone = element.cloneNode(true);
        for (const breakElement of clone.querySelectorAll('br')) {
            breakElement.replaceWith('\n');
        }
        return String(clone.textContent ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ')
            .split('\n');
    }

    function readEditorText(editor) {
        return String(editor.innerText ?? editor.textContent ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ');
    }

    function trimBlankBoundaryLines(lines) {
        const trimmed = lines.slice();
        while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
        while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
        return trimmed;
    }

    function appendLines(documentObject, element, lines) {
        lines.forEach((line, index) => {
            if (index > 0) element.append(documentObject.createElement('br'));
            element.append(documentObject.createTextNode(line));
        });
    }

    function appendCellText(documentObject, cell, value) {
        const parts = String(value ?? '').split(/<br\s*\/?>/i);
        parts.forEach((part, index) => {
            if (index > 0) cell.append(documentObject.createElement('br'));
            cell.append(documentObject.createTextNode(part));
        });
    }

    function createTableRegion(documentObject, tableModel) {
        const region = documentObject.createElement('div');
        region.className = 'tmtv-table-region';
        region.setAttribute('role', 'region');
        region.setAttribute('tabindex', '0');
        region.setAttribute('data-tmtv-version', SCRIPT_VERSION);
        region.setAttribute(
            'aria-label',
            `Markdown 表格：${tableModel.header.filter(Boolean).join('、').slice(0, 120) || '未命名表格'}`
        );

        const table = documentObject.createElement('table');
        table.className = 'tmtv-table';
        const compactColumns = tableModel.header.map((_, columnIndex) =>
            isCompactTableColumn(tableModel, columnIndex)
        );

        const caption = documentObject.createElement('caption');
        caption.className = 'tmtv-visually-hidden';
        caption.textContent = `由 Trello Markdown Table Viewer ${SCRIPT_VERSION} 渲染`;
        table.append(caption);

        const columnGroup = documentObject.createElement('colgroup');
        compactColumns.forEach((isCompact) => {
            const column = documentObject.createElement('col');
            if (isCompact) column.className = 'tmtv-compact-column';
            columnGroup.append(column);
        });
        table.append(columnGroup);

        const tableHead = documentObject.createElement('thead');
        const headerRow = documentObject.createElement('tr');
        tableModel.header.forEach((value, columnIndex) => {
            const headerCell = documentObject.createElement('th');
            headerCell.scope = 'col';
            headerCell.className = `tmtv-align-${tableModel.alignments[columnIndex]}`;
            if (compactColumns[columnIndex]) {
                headerCell.classList.add('tmtv-compact-column');
                headerCell.setAttribute('data-tmtv-compact-column', 'true');
            }
            appendCellText(documentObject, headerCell, value);
            headerRow.append(headerCell);
        });
        tableHead.append(headerRow);
        table.append(tableHead);

        const tableBody = documentObject.createElement('tbody');
        tableModel.rows.forEach((row) => {
            const bodyRow = documentObject.createElement('tr');
            row.forEach((value, columnIndex) => {
                const bodyCell = documentObject.createElement('td');
                bodyCell.className = `tmtv-align-${tableModel.alignments[columnIndex]}`;
                if (compactColumns[columnIndex]) {
                    bodyCell.classList.add('tmtv-compact-column');
                    bodyCell.setAttribute('data-tmtv-compact-column', 'true');
                }
                appendCellText(documentObject, bodyCell, value);
                bodyRow.append(bodyCell);
            });
            tableBody.append(bodyRow);
        });
        table.append(tableBody);
        region.append(table);
        return region;
    }

    function createPreservedTextBlock(documentObject, sourceParagraph, lines) {
        const visibleLines = trimBlankBoundaryLines(lines);
        if (!visibleLines.length) return null;

        const paragraph = sourceParagraph.cloneNode(false);
        paragraph.removeAttribute('data-renderer-start-pos');
        paragraph.classList.add('tmtv-preserved-text');
        appendLines(documentObject, paragraph, visibleLines);
        return paragraph;
    }

    function createEditorPreview(documentObject, previewModel) {
        const preview = documentObject.createElement('div');
        preview.className = 'tmtv-editor-preview';
        preview.setAttribute(EDITOR_PREVIEW_ATTRIBUTE, 'true');
        preview.setAttribute('data-tmtv-version', SCRIPT_VERSION);
        preview.setAttribute('role', 'region');
        preview.setAttribute('aria-label', 'Markdown 表格实时预览');

        const header = documentObject.createElement('div');
        header.className = 'tmtv-editor-preview-header';

        const title = documentObject.createElement('span');
        title.textContent = 'Markdown 表格实时预览';

        const count = documentObject.createElement('span');
        count.className = 'tmtv-editor-preview-count';
        count.textContent = `${previewModel.tableCount} 个表格`;
        header.append(title, count);
        preview.append(header);

        const content = documentObject.createElement('div');
        content.className = 'tmtv-editor-preview-content';
        previewModel.tables.forEach((tableModel) => {
            content.append(createTableRegion(documentObject, tableModel));
        });
        preview.append(content);
        return preview;
    }

    function installStyles(documentObject) {
        if (documentObject.getElementById(STYLE_ID)) return;

        const style = documentObject.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            [${SOURCE_ATTRIBUTE}="true"] {
                display: none !important;
            }

            .tmtv-rendered-block {
                min-width: 0;
            }

            .tmtv-editor-preview {
                box-sizing: border-box;
                min-width: 0;
                margin: 12px 0;
                padding: 8px;
                color: var(--ds-text, #172b4d);
                background: var(--ds-background-neutral-subtle, #00000000);
                border: 1px solid var(--ds-border, #dfe1e6);
                border-radius: 3px;
            }

            .tmtv-editor-preview-header {
                display: flex;
                gap: 8px;
                align-items: center;
                justify-content: space-between;
                margin: 0 0 8px;
                color: var(--ds-text-subtle, #626f86);
                font-size: 12px;
                font-weight: 600;
                line-height: 16px;
            }

            .tmtv-editor-preview-count {
                font-weight: 400;
                white-space: nowrap;
            }

            .tmtv-editor-preview-content {
                min-width: 0;
            }

            .tmtv-editor-preview .tmtv-table-region {
                margin: 0 0 8px;
            }

            .tmtv-editor-preview .tmtv-table-region:last-child {
                margin-bottom: 0;
            }

            .tmtv-table-region {
                box-sizing: border-box;
                width: 100%;
                max-width: 100%;
                margin: 12px 0 4px;
                overflow-x: auto;
                color: var(--ds-text, #172b4d);
                background: var(--ds-surface, #ffffff);
                border: 1px solid var(--ds-border, #dfe1e6);
                border-radius: 3px;
                scrollbar-color: var(--ds-text-subtle, #626f86) transparent;
                scrollbar-width: thin;
            }

            .tmtv-table-region:focus-visible {
                outline: 2px solid var(--ds-border-focused, #388bff);
                outline-offset: 2px;
            }

            .tmtv-table {
                width: max-content;
                min-width: 100%;
                margin: 0;
                overflow: hidden;
                color: inherit;
                font: inherit;
                line-height: 20px;
                border: 0;
                border-collapse: separate;
                border-spacing: 0;
            }

            .tmtv-table th,
            .tmtv-table td {
                box-sizing: border-box;
                min-width: 80px;
                max-width: 240px;
                padding: 6px 8px;
                overflow-wrap: anywhere;
                vertical-align: top;
                background: transparent;
                border: 0;
                border-right: 1px solid var(--ds-border, #dfe1e6);
                border-bottom: 1px solid var(--ds-border, #dfe1e6);
            }

            .tmtv-table th {
                color: var(--ds-text, #172b4d);
                font-weight: 600;
                background: var(--ds-background-neutral, #f1f2f4);
            }

            .tmtv-table col.tmtv-compact-column {
                width: 1%;
            }

            .tmtv-table th.tmtv-compact-column,
            .tmtv-table td.tmtv-compact-column {
                width: 1%;
                min-width: 0;
                max-width: none;
                overflow-wrap: normal;
                white-space: nowrap;
            }

            .tmtv-table tbody tr:hover td {
                background: var(--ds-background-neutral-hovered, #091e4224);
            }

            .tmtv-table tr > :last-child {
                border-right: 0;
            }

            .tmtv-table tbody tr:last-child > td {
                border-bottom: 0;
            }

            .tmtv-align-left {
                text-align: left;
            }

            .tmtv-align-center {
                text-align: center;
            }

            .tmtv-align-right {
                text-align: right;
            }

            .tmtv-preserved-text {
                white-space: pre-wrap;
            }

            .tmtv-visually-hidden {
                position: absolute !important;
                width: 1px !important;
                height: 1px !important;
                padding: 0 !important;
                margin: -1px !important;
                overflow: hidden !important;
                clip: rect(0, 0, 0, 0) !important;
                white-space: nowrap !important;
                border: 0 !important;
            }
        `;
        (documentObject.head || documentObject.documentElement).append(style);
    }

    function restoreSourceParagraph(paragraph, record) {
        paragraph.classList.remove('tmtv-source');
        paragraph.removeAttribute(SOURCE_ATTRIBUTE);
        paragraph.hidden = record?.originalHidden ?? false;
        if (record?.originalAriaHidden === null || record?.originalAriaHidden === undefined) {
            paragraph.removeAttribute('aria-hidden');
        } else {
            paragraph.setAttribute('aria-hidden', record.originalAriaHidden);
        }
    }

    function resetGeneratedDom(documentObject) {
        for (const rendered of documentObject.querySelectorAll(`[${RENDERED_ATTRIBUTE}="true"]`)) {
            rendered.remove();
        }
        for (const source of documentObject.querySelectorAll(`[${SOURCE_ATTRIBUTE}="true"]`)) {
            source.hidden = false;
            source.classList.remove('tmtv-source');
            source.removeAttribute(SOURCE_ATTRIBUTE);
            source.removeAttribute('aria-hidden');
        }
        for (const preview of documentObject.querySelectorAll(`[${EDITOR_PREVIEW_ATTRIBUTE}="true"]`)) {
            preview.remove();
        }
        documentObject.documentElement.removeAttribute('data-tmtv-version');
        documentObject.documentElement.removeAttribute('data-tmtv-table-count');
        documentObject.documentElement.removeAttribute('data-tmtv-editor-table-count');
    }

    function createRuntime(documentObject, windowObject) {
        let sourceRecords = new WeakMap();
        let editorRecords = new WeakMap();
        let observer = null;
        let renderTimer = 0;

        function renderParagraph(paragraph) {
            const lines = readElementLines(paragraph);
            const segments = findMarkdownTableSegments(lines);
            const tableCount = segments.filter((segment) => segment.type === 'table').length;
            if (!tableCount) return 0;

            const renderedBlock = documentObject.createElement('div');
            renderedBlock.className = 'tmtv-rendered-block';
            renderedBlock.setAttribute(RENDERED_ATTRIBUTE, 'true');
            renderedBlock.setAttribute('data-tmtv-version', SCRIPT_VERSION);

            for (const segment of segments) {
                if (segment.type === 'table') {
                    renderedBlock.append(createTableRegion(documentObject, segment));
                    continue;
                }
                const textBlock = createPreservedTextBlock(documentObject, paragraph, segment.lines);
                if (textBlock) renderedBlock.append(textBlock);
            }

            const record = {
                originalAriaHidden: paragraph.getAttribute('aria-hidden'),
                originalHidden: paragraph.hidden,
                renderedBlock,
                sourceText: lines.join('\n')
            };
            sourceRecords.set(paragraph, record);
            paragraph.classList.add('tmtv-source');
            paragraph.setAttribute(SOURCE_ATTRIBUTE, 'true');
            paragraph.setAttribute('aria-hidden', 'true');
            paragraph.hidden = true;
            paragraph.after(renderedBlock);
            return tableCount;
        }

        function restoreChangedSources() {
            for (const paragraph of documentObject.querySelectorAll(`[${SOURCE_ATTRIBUTE}="true"]`)) {
                const record = sourceRecords.get(paragraph);
                const sourceText = readElementLines(paragraph).join('\n');
                if (record && record.sourceText === sourceText && record.renderedBlock.isConnected) continue;

                record?.renderedBlock.remove();
                restoreSourceParagraph(paragraph, record);
                sourceRecords.delete(paragraph);
            }
        }

        function getDescriptionEditors() {
            return Array.from(documentObject.querySelectorAll(EDITOR_SELECTOR)).filter((editor) => {
                const section = editor.closest('section');
                return !!section?.querySelector('[data-testid="description-save-button"]');
            });
        }

        function getEditorPreviewAnchor(editor) {
            const section = editor.closest('section');
            const saveButton = section?.querySelector('[data-testid="description-save-button"]');
            const controls = saveButton?.parentElement;
            if (!controls?.parentElement || !controls.parentElement.contains(editor)) return null;
            return controls;
        }

        function syncEditorPreview(editor) {
            const previewModel = getMarkdownTablePreviewModel(readEditorText(editor));
            const existingRecord = editorRecords.get(editor);

            if (!previewModel.tableCount) {
                existingRecord?.preview.remove();
                editorRecords.delete(editor);
                return 0;
            }

            const anchor = getEditorPreviewAnchor(editor);
            if (!anchor) {
                existingRecord?.preview.remove();
                editorRecords.delete(editor);
                return 0;
            }

            if (
                existingRecord
                && existingRecord.sourceText === previewModel.sourceText
                && existingRecord.preview.isConnected
            ) {
                if (existingRecord.preview.nextElementSibling !== anchor) {
                    anchor.before(existingRecord.preview);
                }
                return previewModel.tableCount;
            }

            const preview = createEditorPreview(documentObject, previewModel);
            const scrollPositions = existingRecord
                ? Array.from(existingRecord.preview.querySelectorAll('.tmtv-table-region'))
                    .map((region) => region.scrollLeft)
                : [];

            if (existingRecord?.preview.isConnected) {
                existingRecord.preview.replaceWith(preview);
            } else {
                anchor.before(preview);
            }

            Array.from(preview.querySelectorAll('.tmtv-table-region')).forEach((region, index) => {
                region.scrollLeft = scrollPositions[index] || 0;
            });
            editorRecords.set(editor, {
                preview,
                sourceText: previewModel.sourceText
            });
            return previewModel.tableCount;
        }

        function syncEditorPreviews() {
            const editors = getDescriptionEditors();
            const activeSections = new Set(editors.map((editor) => editor.closest('section')));

            for (const preview of documentObject.querySelectorAll(`[${EDITOR_PREVIEW_ATTRIBUTE}="true"]`)) {
                if (!activeSections.has(preview.closest('section'))) preview.remove();
            }

            return editors.reduce((count, editor) => count + syncEditorPreview(editor), 0);
        }

        function renderAll() {
            renderTimer = 0;
            installStyles(documentObject);
            restoreChangedSources();

            for (const area of documentObject.querySelectorAll(DESCRIPTION_SELECTOR)) {
                if (area.closest('[contenteditable="true"]')) continue;
                for (const paragraph of area.querySelectorAll('p')) {
                    if (
                        paragraph.hasAttribute(SOURCE_ATTRIBUTE)
                        || paragraph.closest(`[${RENDERED_ATTRIBUTE}="true"]`)
                        || paragraph.closest('[contenteditable="true"]')
                    ) {
                        continue;
                    }
                    renderParagraph(paragraph);
                }
            }

            const editorTableCount = syncEditorPreviews();
            const tableCount = documentObject.querySelectorAll('.tmtv-table-region').length;
            documentObject.documentElement.setAttribute('data-tmtv-version', SCRIPT_VERSION);
            documentObject.documentElement.setAttribute('data-tmtv-table-count', String(tableCount));
            documentObject.documentElement.setAttribute('data-tmtv-editor-table-count', String(editorTableCount));
            return tableCount;
        }

        function scheduleRender() {
            if (renderTimer) return;
            renderTimer = windowObject.setTimeout(renderAll, 40);
        }

        function onDocumentInput(event) {
            const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
            if (target?.closest?.(EDITOR_SELECTOR)) scheduleRender();
        }

        function start() {
            renderAll();
            observer = new MutationObserver(scheduleRender);
            observer.observe(documentObject.body || documentObject.documentElement, {
                childList: true,
                characterData: true,
                subtree: true
            });
            documentObject.addEventListener('input', onDocumentInput, true);
        }

        function destroy() {
            observer?.disconnect();
            documentObject.removeEventListener('input', onDocumentInput, true);
            if (renderTimer) windowObject.clearTimeout(renderTimer);
            renderTimer = 0;

            for (const paragraph of documentObject.querySelectorAll(`[${SOURCE_ATTRIBUTE}="true"]`)) {
                const record = sourceRecords.get(paragraph);
                record?.renderedBlock.remove();
                restoreSourceParagraph(paragraph, record);
            }
            sourceRecords = new WeakMap();
            editorRecords = new WeakMap();
            documentObject.getElementById(STYLE_ID)?.remove();
            resetGeneratedDom(documentObject);
        }

        return { destroy, renderAll, start };
    }

    const api = {
        SCRIPT_VERSION,
        COMPACT_COLUMN_CHARACTER_LIMIT,
        findMarkdownTableSegments,
        getCellMaximumLineWidth,
        getColumnAlignment,
        getMarkdownTablePreviewModel,
        isCompactTableColumn,
        measureTextInChineseCharacterUnits,
        normalizeRow,
        parseMarkdownTableAt,
        parseMarkdownTableText,
        splitMarkdownTableRow
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (typeof document === 'object' && document.documentElement) {
        const previousRuntime = globalThis[GLOBAL_STATE_KEY];
        if (previousRuntime?.destroy) {
            previousRuntime.destroy();
        } else {
            resetGeneratedDom(document);
        }

        const runtime = createRuntime(document, window);
        globalThis[GLOBAL_STATE_KEY] = {
            destroy: runtime.destroy,
            renderAll: runtime.renderAll,
            version: SCRIPT_VERSION
        };

        if (document.body) {
            runtime.start();
        } else {
            document.addEventListener('DOMContentLoaded', runtime.start, { once: true });
        }
    }
})();
