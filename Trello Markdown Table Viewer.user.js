// ==UserScript==
// @name         Trello Markdown Table Viewer
// @name:zh-CN   Trello Markdown 表格查看器
// @namespace    https://github.com/millionart
// @version      1.3.1
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

    const SCRIPT_VERSION = '1.3.1';
    const GLOBAL_STATE_KEY = '__trelloMarkdownTableViewer';
    const STYLE_ID = 'trello-markdown-table-viewer-styles';
    const DESCRIPTION_SELECTOR = '[data-testid="description-content-area"]';
    const EDITOR_SELECTOR = '[data-testid="editor-content-container"] [contenteditable="true"][role="textbox"]';
    const SOURCE_ATTRIBUTE = 'data-tmtv-source';
    const RENDERED_ATTRIBUTE = 'data-tmtv-rendered';
    const EDITOR_PREVIEW_ATTRIBUTE = 'data-tmtv-editor-preview';
    const LINE_BREAK_TOGGLE_ATTRIBUTE = 'data-tmtv-line-break-toggle';
    const LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE = 'data-tmtv-line-break-toggle-wrapper';
    const LINE_BREAK_TOGGLE_LABEL = '切换换行形式';
    const EDITOR_BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,pre,blockquote';
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

    function normalizeSelectedLines(text) {
        const lines = String(text ?? '')
            .replace(/\r\n?/g, '\n')
            .split(/\n+/);
        while (lines.length && lines[0] === '') lines.shift();
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines;
    }

    function getLineBreakSelectionLines(selectionText, rangeText) {
        const selectionLines = normalizeSelectedLines(selectionText);
        if (selectionLines.length >= 2) return selectionLines;
        return normalizeSelectedLines(rangeText);
    }

    function getLineBreakToggleTarget(hasBlockBreaks, hasSoftBreaks) {
        if (hasBlockBreaks) return 'soft';
        if (hasSoftBreaks) return 'paragraph';
        return null;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function buildLineBreakReplacementHtml(lines, target) {
        const safeLines = Array.isArray(lines) ? lines.map((line) => escapeHtml(line)) : [];
        if (!safeLines.length) return '';
        if (target === 'soft') return safeLines.join('<br>');
        if (target === 'paragraph') {
            return safeLines.map((line) => `<p>${line || '<br>'}</p>`).join('');
        }
        return '';
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

    function createLineBreakToggleIcon(documentObject) {
        const namespace = 'http://www.w3.org/2000/svg';
        const icon = documentObject.createElementNS(namespace, 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');

        const lines = documentObject.createElementNS(namespace, 'path');
        lines.setAttribute('fill', 'currentColor');
        lines.setAttribute('d', 'M4 5h12v2H4V5Zm0 6h7v2H4v-2Zm0 6h12v2H4v-2Z');

        const returnArrow = documentObject.createElementNS(namespace, 'path');
        returnArrow.setAttribute('fill', 'currentColor');
        returnArrow.setAttribute('d', 'M18 8v3a3 3 0 0 1-3 3h-1v2l-3-3 3-3v2h1a1 1 0 0 0 1-1V8h2Z');

        icon.append(lines, returnArrow);
        return icon;
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

            [${LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE}="true"] {
                display: flex;
                align-items: center;
            }

            [${LINE_BREAK_TOGGLE_ATTRIBUTE}="true"] {
                width: 24px !important;
                min-width: 24px !important;
                height: 24px !important;
                padding: 0 !important;
            }

            [${LINE_BREAK_TOGGLE_ATTRIBUTE}="true"] svg {
                width: 20px;
                height: 20px;
                pointer-events: none;
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
        for (const wrapper of documentObject.querySelectorAll(`[${LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE}="true"]`)) {
            wrapper.remove();
        }
        documentObject.documentElement.removeAttribute('data-tmtv-version');
        documentObject.documentElement.removeAttribute('data-tmtv-table-count');
        documentObject.documentElement.removeAttribute('data-tmtv-editor-table-count');
    }

    function createRuntime(documentObject, windowObject) {
        let sourceRecords = new WeakMap();
        let editorRecords = new WeakMap();
        let lineBreakButtonEditors = new WeakMap();
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

        function getLineBreakSelectionForEditor(editor) {
            const selection = windowObject.getSelection?.();
            if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
            const range = selection.getRangeAt(0);
            if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
            return {
                range: range.cloneRange(),
                text: selection.toString()
            };
        }

        function findEditorBlock(node, editor) {
            const element = node?.nodeType === 1 ? node : node?.parentElement;
            const block = element?.closest?.(EDITOR_BLOCK_SELECTOR);
            return block && editor.contains(block) ? block : null;
        }

        function analyzeLineBreakSelection(editor, selectionRecord) {
            const range = selectionRecord?.range;
            if (!range || range.collapsed) return null;
            const fragment = range.cloneContents();
            const startBlock = findEditorBlock(range.startContainer, editor);
            const endBlock = findEditorBlock(range.endContainer, editor);
            const fragmentBlockCount = fragment.querySelectorAll?.(EDITOR_BLOCK_SELECTOR).length || 0;
            const hasBlockBreaks = fragmentBlockCount > 1 || !!(startBlock && endBlock && startBlock !== endBlock);
            const hasSoftBreaks = !!fragment.querySelector?.('br');
            const target = getLineBreakToggleTarget(hasBlockBreaks, hasSoftBreaks);
            const lines = getLineBreakSelectionLines(selectionRecord.text, range.toString());
            if (!target || lines.length < 2) return null;
            return { lines, target };
        }

        function applyLineBreakToggle(editor, selectionRecord) {
            const range = selectionRecord?.range;
            const analysis = analyzeLineBreakSelection(editor, selectionRecord);
            if (!analysis || typeof documentObject.execCommand !== 'function') {
                return { changed: false, target: null };
            }

            const replacementHtml = buildLineBreakReplacementHtml(analysis.lines, analysis.target);
            if (!replacementHtml) return { changed: false, target: analysis.target };

            const selection = windowObject.getSelection?.();
            if (!selection) return { changed: false, target: analysis.target };
            editor.focus({ preventScroll: true });
            selection.removeAllRanges();
            selection.addRange(range);

            let changed = false;
            try {
                changed = documentObject.execCommand('insertHTML', false, replacementHtml) === true;
            } catch {
                changed = false;
            }
            return {
                changed,
                lineCount: analysis.lines.length,
                target: analysis.target
            };
        }

        function getLineBreakToggleTitle(editor) {
            const selectionRecord = getLineBreakSelectionForEditor(editor);
            const analysis = selectionRecord ? analyzeLineBreakSelection(editor, selectionRecord) : null;
            if (analysis?.target === 'soft') return '将选中的多个段落合并为段内换行';
            if (analysis?.target === 'paragraph') return '将选中的段内换行拆分为多个段落';
            return '请选择包含多个段落或段内换行的内容';
        }

        function updateLineBreakToggleButton(button, editor) {
            const selectionRecord = getLineBreakSelectionForEditor(editor);
            const analysis = selectionRecord ? analyzeLineBreakSelection(editor, selectionRecord) : null;
            button.disabled = !analysis;
            button.title = getLineBreakToggleTitle(editor);
        }

        function createLineBreakToggleButton(editor, insertButton) {
            const insertWrapper = insertButton.parentElement;
            if (!insertWrapper) return null;

            const wrapper = insertWrapper.cloneNode(false);
            wrapper.setAttribute(LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE, 'true');
            wrapper.setAttribute('data-tmtv-version', SCRIPT_VERSION);

            const button = insertButton.cloneNode(false);
            button.removeAttribute('aria-expanded');
            button.removeAttribute('aria-haspopup');
            button.removeAttribute('aria-keyshortcuts');
            button.setAttribute('aria-label', LINE_BREAK_TOGGLE_LABEL);
            button.setAttribute(LINE_BREAK_TOGGLE_ATTRIBUTE, 'true');
            button.setAttribute('data-tmtv-version', SCRIPT_VERSION);
            button.append(createLineBreakToggleIcon(documentObject));

            let savedSelection = null;
            button.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                const selectionRecord = getLineBreakSelectionForEditor(editor);
                if (!selectionRecord) return;
                savedSelection = selectionRecord;
                event.preventDefault();
            });
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const selectionRecord = savedSelection || getLineBreakSelectionForEditor(editor);
                savedSelection = null;
                if (!selectionRecord) return;

                const result = applyLineBreakToggle(editor, selectionRecord);
                button.setAttribute('data-tmtv-last-result', result.changed ? result.target : 'failed');
                scheduleRender();
            });

            wrapper.append(button);
            insertWrapper.after(wrapper);
            lineBreakButtonEditors.set(button, editor);
            updateLineBreakToggleButton(button, editor);
            return button;
        }

        function syncLineBreakToggleButtons() {
            const activeWrappers = new Set();
            for (const editor of getDescriptionEditors()) {
                const section = editor.closest('section');
                const toolbar = section
                    ? Array.from(section.querySelectorAll('[role="toolbar"]'))
                        .find((candidate) => candidate.getAttribute('aria-label') === '编辑器')
                    : null;
                const insertButton = toolbar
                    ? Array.from(toolbar.querySelectorAll('button'))
                        .find((candidate) => candidate.getAttribute('aria-label') === '插入元素')
                    : null;
                if (!toolbar || !insertButton?.parentElement) continue;

                let button = toolbar.querySelector(`[${LINE_BREAK_TOGGLE_ATTRIBUTE}="true"]`);
                if (!button) {
                    button = createLineBreakToggleButton(editor, insertButton);
                } else {
                    lineBreakButtonEditors.set(button, editor);
                    const wrapper = button.closest(`[${LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE}="true"]`);
                    if (wrapper && wrapper.previousElementSibling !== insertButton.parentElement) {
                        insertButton.parentElement.after(wrapper);
                    }
                    updateLineBreakToggleButton(button, editor);
                }
                const wrapper = button?.closest(`[${LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE}="true"]`);
                if (wrapper) activeWrappers.add(wrapper);
            }

            for (const wrapper of documentObject.querySelectorAll(`[${LINE_BREAK_TOGGLE_WRAPPER_ATTRIBUTE}="true"]`)) {
                if (!activeWrappers.has(wrapper)) wrapper.remove();
            }
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

            syncLineBreakToggleButtons();
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

        function onSelectionChange() {
            scheduleRender();
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
            documentObject.addEventListener('selectionchange', onSelectionChange);
        }

        function destroy() {
            observer?.disconnect();
            documentObject.removeEventListener('input', onDocumentInput, true);
            documentObject.removeEventListener('selectionchange', onSelectionChange);
            if (renderTimer) windowObject.clearTimeout(renderTimer);
            renderTimer = 0;

            for (const paragraph of documentObject.querySelectorAll(`[${SOURCE_ATTRIBUTE}="true"]`)) {
                const record = sourceRecords.get(paragraph);
                record?.renderedBlock.remove();
                restoreSourceParagraph(paragraph, record);
            }
            sourceRecords = new WeakMap();
            editorRecords = new WeakMap();
            lineBreakButtonEditors = new WeakMap();
            documentObject.getElementById(STYLE_ID)?.remove();
            resetGeneratedDom(documentObject);
        }

        return { destroy, renderAll, start };
    }

    const api = {
        SCRIPT_VERSION,
        COMPACT_COLUMN_CHARACTER_LIMIT,
        LINE_BREAK_TOGGLE_LABEL,
        buildLineBreakReplacementHtml,
        findMarkdownTableSegments,
        getCellMaximumLineWidth,
        getColumnAlignment,
        getMarkdownTablePreviewModel,
        getLineBreakSelectionLines,
        isCompactTableColumn,
        measureTextInChineseCharacterUnits,
        getLineBreakToggleTarget,
        normalizeSelectedLines,
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
