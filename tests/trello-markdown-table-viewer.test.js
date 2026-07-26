const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    COMPACT_COLUMN_CHARACTER_LIMIT,
    SCRIPT_VERSION,
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
} = require('../Trello Markdown Table Viewer.user.js');

const scriptPath = path.join(__dirname, '..', 'Trello Markdown Table Viewer.user.js');
const script = fs.readFileSync(scriptPath, 'utf8');

test('userscript metadata targets Trello and exposes an unambiguous version', () => {
    assert.equal(SCRIPT_VERSION, '1.2.0');
    assert.equal(COMPACT_COLUMN_CHARACTER_LIMIT, 4);
    assert.match(script, /@name\s+Trello Markdown Table Viewer/);
    assert.match(script, /@match\s+https:\/\/trello\.com\/\*/);
    assert.match(script, /@version\s+1\.2\.0/);
    assert.match(script, /data-tmtv-editor-preview/);
    assert.match(script, /addEventListener\('input', onDocumentInput, true\)/);
});

test('splits rows with outer pipes, escaped pipes, and inline-code pipes', () => {
    assert.deepEqual(
        splitMarkdownTableRow('| Name | A \\| B | `x | y` |'),
        ['Name', 'A | B', '`x | y`']
    );
    assert.deepEqual(splitMarkdownTableRow('Name | Value'), ['Name', 'Value']);
    assert.equal(splitMarkdownTableRow('ordinary text'), null);
});

test('recognizes left, center, and right alignment markers', () => {
    assert.equal(getColumnAlignment('---'), 'left');
    assert.equal(getColumnAlignment(':---'), 'left');
    assert.equal(getColumnAlignment(':---:'), 'center');
    assert.equal(getColumnAlignment('---:'), 'right');
    assert.equal(getColumnAlignment('--'), null);
});

test('parses the Markdown table used by the Trello NPC card', () => {
    const source = [
        '| 年纪 | 体型 | 特征 | 性别 | 职业 | 触发条件 | 用途1 | 用途2 | 用途3 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 年轻 |  | 白皙金发 | 男 | 生物学家 | 挖灌木随机遇到 | 开启抓捕 | 生物图鉴 |  |',
        '| 中年 | 壮 | 黑皮 | 男 | 建筑师 | 通关第一个地牢后解救 | 开启建造 |  |  |'
    ];

    const table = parseMarkdownTableAt(source, 0);
    assert.ok(table);
    assert.equal(table.header.length, 9);
    assert.deepEqual(table.header.slice(0, 3), ['年纪', '体型', '特征']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0][4], '生物学家');
    assert.equal(table.rows[1][6], '开启建造');
    assert.deepEqual(table.alignments, Array(9).fill('left'));
});

test('rejects prose and malformed separator rows', () => {
    assert.equal(parseMarkdownTableAt(['A | B', '-- | ---', '1 | 2'], 0), null);
    assert.equal(parseMarkdownTableAt(['A | B', '--- | --- | ---', '1 | 2'], 0), null);
    assert.deepEqual(parseMarkdownTableText('This | is prose\nwithout a separator'), []);
});

test('normalizes short and long body rows to the header width', () => {
    assert.deepEqual(normalizeRow(['A'], 3), ['A', '', '']);
    assert.deepEqual(normalizeRow(['A', 'B', 'C', 'D'], 3), ['A', 'B', 'C']);

    const table = parseMarkdownTableAt([
        '| A | B | C |',
        '| --- | --- | --- |',
        '| 1 | 2 |',
        '| 3 | 4 | 5 | 6 |'
    ], 0);
    assert.deepEqual(table.rows, [
        ['1', '2', ''],
        ['3', '4', '5']
    ]);
});

test('keeps surrounding description text as separate segments', () => {
    const segments = findMarkdownTableSegments([
        'Intro',
        '',
        '| A | B |',
        '| :--- | ---: |',
        '| 1 | 2 |',
        '',
        'Outro'
    ]);

    assert.deepEqual(segments.map((segment) => segment.type), ['text', 'table', 'text']);
    assert.deepEqual(segments[0].lines, ['Intro', '']);
    assert.deepEqual(segments[1].alignments, ['left', 'right']);
    assert.deepEqual(segments[2].lines, ['', 'Outro']);
});

test('live preview appears, updates, and disappears as an editor changes', () => {
    const headerOnly = getMarkdownTablePreviewModel('| Name | Role |');
    assert.equal(headerOnly.tableCount, 0);

    const complete = getMarkdownTablePreviewModel([
        '| Name | Role |',
        '| --- | --- |',
        '| Ada | Builder |'
    ].join('\n'));
    assert.equal(complete.tableCount, 1);
    assert.deepEqual(complete.tables[0].header, ['Name', 'Role']);
    assert.deepEqual(complete.tables[0].rows, [['Ada', 'Builder']]);

    const updated = getMarkdownTablePreviewModel([
        '| Name | Role |',
        '| --- | --- |',
        '| Ada | Architect |'
    ].join('\n'));
    assert.equal(updated.tables[0].rows[0][1], 'Architect');
    assert.notEqual(updated.sourceText, complete.sourceText);

    const removed = getMarkdownTablePreviewModel('The table has been removed.');
    assert.equal(removed.tableCount, 0);
    assert.deepEqual(removed.tables, []);
});

test('measures text in four-Chinese-character visual units', () => {
    assert.equal(measureTextInChineseCharacterUnits('一二三四'), 4);
    assert.equal(measureTextInChineseCharacterUnits('ABCDEFGH'), 4);
    assert.equal(measureTextInChineseCharacterUnits('用途1'), 2.5);
    assert.equal(getCellMaximumLineWidth('一二三四<br>甲乙'), 4);
    assert.equal(getCellMaximumLineWidth('一二三四五<br>甲乙'), 5);
});

test('only columns whose header and every cell fit four Chinese characters are compact', () => {
    const tableModel = {
        header: ['年纪', '职业', '触发条件', 'ASCII'],
        rows: [
            ['年轻', '生物学家', '挖灌木随机遇到', 'ABCDEFGH'],
            ['中年', '考古学家', '通关地牢', 'ABCDEFGHI']
        ]
    };

    assert.equal(isCompactTableColumn(tableModel, 0), true);
    assert.equal(isCompactTableColumn(tableModel, 1), true);
    assert.equal(isCompactTableColumn(tableModel, 2), false);
    assert.equal(isCompactTableColumn(tableModel, 3), false);
    assert.equal(isCompactTableColumn(tableModel, -1), false);
});
