const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHelpers() {
  const scriptPath = path.join(__dirname, 'Mixamo Download All.user.js');
  const code = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    document: {
      addEventListener() {},
      readyState: 'loading',
    },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: scriptPath });
  return sandbox.window.__mixamoDownloadAllTest;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('sanitizes names for download prefixes while preserving readable text', () => {
  const helpers = loadHelpers();

  assert.equal(helpers.sanitizeName('Action Adventure Pack'), 'Action Adventure Pack');
  assert.equal(helpers.sanitizeName('Turn / Pivot: Left?'), 'Turn Pivot Left');
  assert.equal(helpers.sanitizeName('  A   B   C  '), 'A B C');
  assert.equal(helpers.sanitizeName(''), 'Untitled');
});

test('builds stable queue entries for standalone motions', () => {
  const helpers = loadHelpers();
  const entry = helpers.createStandaloneEntry({
    id: 'motion-1',
    description: 'Jogging',
    type: 'Motion',
  });

  assert.deepEqual(plain(entry), {
    key: 'standalone/motion-1',
    id: 'motion-1',
    productId: 'motion-1',
    productType: 'Motion',
    packId: null,
    packName: 'Standalone',
    motionName: 'Jogging',
    downloadName: 'Standalone__Jogging',
  });
});

test('builds stable queue entries for motions expanded from a pack', () => {
  const helpers = loadHelpers();
  const entry = helpers.createPackEntry(
    { id: 'pack-1', description: 'Action Adventure Pack' },
    { id: 'motion-2', description: 'Standing 2H Magic Attack 01' },
  );

  assert.equal(entry.key, 'packs/pack-1/motion-2');
  assert.equal(entry.productId, 'motion-2');
  assert.equal(entry.packName, 'Action Adventure Pack');
  assert.equal(entry.downloadName, 'Action Adventure Pack__Standing 2H Magic Attack 01');
});

test('builds pack entries from Mixamo motion pack product_id fields', () => {
  const helpers = loadHelpers();
  const entry = helpers.createPackEntry(
    { id: 'pack-1', name: 'Longbow Locomotion Pack', type: 'MotionPack' },
    {
      motion_id: 'motion-runtime-1',
      product_id: 'product-download-1',
      name: 'standing run forward',
    },
  );

  assert.equal(entry.key, 'packs/pack-1/product-download-1');
  assert.equal(entry.id, 'motion-runtime-1');
  assert.equal(entry.productId, 'product-download-1');
  assert.equal(entry.downloadName, 'Longbow Locomotion Pack__standing run forward');
});

test('prefers pack motion names over long pack descriptions for download names', () => {
  const helpers = loadHelpers();
  const entry = helpers.createPackEntry(
    { id: 'pack-1', name: 'Longbow Locomotion Pack' },
    {
      id: 'motion-1',
      name: 'standing walk forward',
      description: 'standing run forward stop, standing idle, standing run back, standing run forward, standing run left, standing run right, standing turn 90 left, standing turn 90 right, standing walk back, standing walk forward',
    },
  );

  assert.equal(entry.motionName, 'standing walk forward');
  assert.equal(entry.downloadName, 'Longbow Locomotion Pack__standing walk forward');
});

test('prefers pack names over long pack descriptions for download names', () => {
  const helpers = loadHelpers();
  const entry = helpers.createPackEntry(
    {
      id: 'pack-1',
      name: 'Longbow Locomotion Pack',
      description: 'crouch idle, crouch to standing idle, standing block idle, standing block react large, standing disarm underarm, standing disarm over shoulder',
    },
    {
      id: 'motion-1',
      name: 'standing block idle',
    },
  );

  assert.equal(entry.packName, 'Longbow Locomotion Pack');
  assert.equal(entry.downloadName, 'Longbow Locomotion Pack__standing block idle');
});

test('repairs stale pack queue download names from product details at download time', () => {
  const helpers = loadHelpers();
  const downloadName = helpers.resolveEntryDownloadName(
    {
      packId: 'pack-1',
      packName: 'Longbow Locomotion Pack',
      downloadName: 'Longbow Locomotion Pack__standing run forward stop, standing idle, standing run back',
    },
    {
      name: 'standing walk forward',
      description: 'standing run forward stop, standing idle, standing run back',
    },
  );

  assert.equal(downloadName, 'Longbow Locomotion Pack__standing walk forward');
});

test('detects motion packs from Mixamo product metadata variants', () => {
  const helpers = loadHelpers();

  assert.equal(helpers.isPackProduct({ type: 'MotionPack', id: 'p1' }), true);
  assert.equal(helpers.isPackProduct({ type: 'Motion,MotionPack', id: 'p2' }), true);
  assert.equal(helpers.isPackProduct({ product_type: 'MotionPack', id: 'p3' }), true);
  assert.equal(helpers.isPackProduct({ description: 'Action Adventure Pack', num_animations: 22, id: 'p4' }), true);
  assert.equal(helpers.isPackProduct({ type: 'MotionPack', motions: [{ product_id: 'm1' }], id: 'p5' }), true);
  assert.equal(helpers.isPackProduct({ type: 'Motion', name: 'Pick Up Item', description: 'Right Item Pick Up Into Pack When Running', id: 'm0' }), false);
  assert.equal(helpers.isPackProduct({ type: 'Motion', description: 'Jogging', id: 'm1' }), false);
});

test('resume filtering skips completed items and keeps failures available for retry', () => {
  const helpers = loadHelpers();
  const queue = [
    { key: 'standalone/a' },
    { key: 'standalone/b' },
    { key: 'packs/p/c' },
  ];
  const state = {
    completed: { 'standalone/a': { at: 'now' } },
    failed: { 'standalone/b': { attempts: 1, reason: '429' } },
  };

  assert.deepEqual(helpers.filterPendingQueue(queue, state).map((item) => item.key), [
    'standalone/b',
    'packs/p/c',
  ]);
});

test('classifies retry delays with longer backoff for rate limits', () => {
  const helpers = loadHelpers();

  assert.equal(helpers.getRetryDelayMs({ status: 429 }, 0), 30000);
  assert.equal(helpers.getRetryDelayMs({ status: 429 }, 2), 120000);
  assert.equal(helpers.getRetryDelayMs(new Error('network'), 1), 10000);
});

test('keeps manual character and status UI hidden until needed', () => {
  const helpers = loadHelpers();
  const model = helpers.getInitialUiModel();

  assert.equal(model.characterInputVisible, false);
  assert.equal(model.statusVisible, false);
  assert.deepEqual(plain(model.buttonLabels), {
    crawl: 'Crawl',
    download: 'Download All',
    pause: 'Pause',
    reset: 'Reset',
    importDone: 'Import Done',
  });
});

test('extracts character id from Mixamo character API traffic', () => {
  const helpers = loadHelpers();
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  assert.equal(
    helpers.extractCharacterIdFromText(`https://www.mixamo.com/api/v1/products/motion-1?similar=0&character_id=${uuid}`),
    uuid,
  );
  assert.equal(
    helpers.extractCharacterIdFromText(`https://www.mixamo.com/api/v1/characters/${uuid}/monitor`),
    uuid,
  );
  assert.equal(
    helpers.extractCharacterIdFromText(JSON.stringify({ character_id: uuid, type: 'Motion' })),
    uuid,
  );
});

test('does not treat unrelated product uuids as character ids', () => {
  const helpers = loadHelpers();

  assert.equal(
    helpers.extractCharacterIdFromText('https://www.mixamo.com/api/v1/products/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    '',
  );
});

test('builds GM_download request names with fbx extension', () => {
  const helpers = loadHelpers();

  assert.deepEqual(plain(helpers.createDownloadRequest('https://example.test/file', 'Pack__Jump')), {
    url: 'https://example.test/file',
    name: 'Pack__Jump.fbx',
  });
  assert.deepEqual(plain(helpers.createDownloadRequest('https://example.test/file', 'Pack__Jump.fbx')), {
    url: 'https://example.test/file',
    name: 'Pack__Jump.fbx',
  });
});

test('formats retry status with the underlying error reason', () => {
  const helpers = loadHelpers();

  assert.equal(
    helpers.formatRetryStatus('Standalone__Jump', new Error('GM_download failed: not_whitelisted'), 20000),
    'Retrying Standalone__Jump in 20s: GM_download failed: not_whitelisted',
  );
});

test('builds manifest export with expected missing entries', () => {
  const helpers = loadHelpers();
  const manifest = helpers.buildManifestExport({
    queue: [
      { key: 'standalone/a', downloadName: 'Standalone__A' },
      { key: 'standalone/b', downloadName: 'Standalone__B' },
    ],
    completed: { 'standalone/a': { at: 'now' } },
    failed: { 'standalone/b': { reason: 'failed' } },
  });

  assert.equal(manifest.totalQueued, 2);
  assert.equal(manifest.totalCompleted, 1);
  assert.equal(manifest.totalFailed, 1);
  assert.deepEqual(plain(manifest.missingFromCompleted).map((item) => item.key), ['standalone/b']);
});

test('matches downloaded file names to queue entries for skip import', () => {
  const helpers = loadHelpers();
  const queue = [
    { key: 'standalone/a', downloadName: 'Standalone__Jogging', packName: 'Standalone', motionName: 'Jogging' },
    { key: 'packs/p/b', downloadName: 'Action Pack__Jump', packName: 'Action Pack', motionName: 'Jump' },
    { key: 'standalone/c', downloadName: 'Standalone__Run', packName: 'Standalone', motionName: 'Run' },
  ];
  const result = helpers.matchDownloadedFilesToQueue(
    ['Standalone__Jogging.fbx', 'Action Pack__Jump.FBX', 'Unknown__Missing.fbx'],
    queue,
  );

  assert.deepEqual(plain(result.matchedKeys), ['standalone/a', 'packs/p/b']);
  assert.deepEqual(plain(result.unmatchedFiles), ['Unknown__Missing.fbx']);
});

test('matches organized pack paths and unique motion file names for skip import', () => {
  const helpers = loadHelpers();
  const queue = [
    { key: 'standalone/a', downloadName: 'Standalone__Jogging', packName: 'Standalone', motionName: 'Jogging' },
    { key: 'packs/p/b', downloadName: 'Action Pack__Jump', packName: 'Action Pack', motionName: 'Jump' },
    { key: 'standalone/c', downloadName: 'Standalone__Run', packName: 'Standalone', motionName: 'Run' },
  ];
  const result = helpers.matchDownloadedFilesToQueue(
    ['Action Pack/Jump.fbx', 'Run.fbx'],
    queue,
  );

  assert.deepEqual(plain(result.matchedKeys), ['packs/p/b', 'standalone/c']);
  assert.deepEqual(plain(result.unmatchedFiles), []);
});

test('does not match bare motion names when they are ambiguous', () => {
  const helpers = loadHelpers();
  const queue = [
    { key: 'standalone/a', downloadName: 'Standalone__Jump', packName: 'Standalone', motionName: 'Jump' },
    { key: 'packs/p/b', downloadName: 'Action Pack__Jump', packName: 'Action Pack', motionName: 'Jump' },
  ];
  const result = helpers.matchDownloadedFilesToQueue(['Jump.fbx'], queue);

  assert.deepEqual(plain(result.matchedKeys), []);
  assert.deepEqual(plain(result.unmatchedFiles), ['Jump.fbx']);
});

test('imports downloaded files into completed without deleting existing completed entries', () => {
  const helpers = loadHelpers();
  const state = {
    completed: { 'standalone/existing': { source: 'download' } },
    failed: { 'standalone/a': { reason: 'old failure' } },
    retryCounts: { 'standalone/a': 2 },
  };
  const queue = [
    { key: 'standalone/a', downloadName: 'Standalone__Jogging', packName: 'Standalone', motionName: 'Jogging' },
  ];

  const updated = helpers.importDownloadedFilesIntoState(state, ['Standalone__Jogging.fbx'], queue);

  assert.equal(Boolean(updated.state.completed['standalone/existing']), true);
  assert.equal(updated.state.completed['standalone/a'].source, 'imported-file');
  assert.equal(Boolean(updated.state.failed['standalone/a']), false);
  assert.equal(Boolean(updated.state.retryCounts['standalone/a']), false);
  assert.equal(updated.importedCount, 1);
});

test('import flow uses an existing crawled queue without rebuilding', async () => {
  const helpers = loadHelpers();
  const events = [];
  const result = await helpers.planImportDoneFlow({
    state: {
      queue: [
        { key: 'standalone/a', downloadName: 'Standalone__Jogging', packName: 'Standalone', motionName: 'Jogging' },
      ],
    },
    selectFiles: async () => {
      events.push('select');
      return ['Standalone__Jogging.fbx'];
    },
    buildQueue: async () => {
      events.push('build');
      return [];
    },
  });

  assert.deepEqual(events, ['select']);
  assert.equal(result.importedCount, 1);
});

test('download button label shows remaining over total', () => {
  const helpers = loadHelpers();

  assert.equal(
    helpers.formatDownloadButtonLabel({
      queue: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      completed: { a: {}, b: {} },
    }),
    'Download All (1/3)',
  );
  assert.equal(helpers.formatDownloadButtonLabel({ queue: [], completed: {} }), 'Download All');
});

test('uses default download concurrency of two and clamps custom values', () => {
  const helpers = loadHelpers();

  assert.equal(helpers.getDownloadConcurrency({}), 2);
  assert.equal(helpers.getDownloadConcurrency({ concurrency: 1 }), 1);
  assert.equal(helpers.getDownloadConcurrency({ concurrency: 3 }), 3);
  assert.equal(helpers.getDownloadConcurrency({ concurrency: 0 }), 1);
  assert.equal(helpers.getDownloadConcurrency({ concurrency: 99 }), 8);
  assert.equal(helpers.getDownloadConcurrency({ concurrency: 'bad' }), 2);
});

test('runs queue entries with bounded concurrency', async () => {
  const helpers = loadHelpers();
  const activeCounts = [];
  let active = 0;
  const completed = [];

  await helpers.runConcurrentQueue({
    entries: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }],
    concurrency: 2,
    isPaused: () => false,
    onProgress() {},
    runEntry: async (entry) => {
      active += 1;
      activeCounts.push(active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(entry.key);
      active -= 1;
    },
    onEntryError() {},
  });

  assert.equal(Math.max(...activeCounts), 2);
  assert.deepEqual(completed.sort(), ['a', 'b', 'c', 'd']);
});

test('import flow requires a crawled queue before matching files', async () => {
  const helpers = loadHelpers();
  await assert.rejects(
    () => helpers.planImportDoneFlow({
      state: { queue: [] },
      selectFiles: async () => ['Standalone__Jogging.fbx'],
    }),
    /Crawl first/,
  );
});

test('stores crawled queue while preserving imported completed items', () => {
  const helpers = loadHelpers();
  const state = {
    completed: { old: { source: 'imported-file' } },
    failed: { stale: {} },
    retryCounts: { stale: 2 },
  };
  const updated = helpers.applyCrawledQueueToState(state, [{ key: 'new', downloadName: 'Standalone__New' }], 'char-1');

  assert.deepEqual(plain(Object.keys(updated.completed)), ['old']);
  assert.deepEqual(plain(updated.queue.map((entry) => entry.key)), ['new']);
  assert.deepEqual(plain(updated.failed), {});
  assert.deepEqual(plain(updated.retryCounts), {});
  assert.equal(updated.characterId, 'char-1');
});

test('summarizes crawled queue pack and standalone counts', () => {
  const helpers = loadHelpers();
  const summary = helpers.summarizeQueue([
    { key: 'standalone/a', packId: null },
    { key: 'packs/p/b', packId: 'p' },
    { key: 'packs/p/c', packId: 'p' },
  ]);

  assert.deepEqual(plain(summary), {
    total: 3,
    standalone: 1,
    packAnimations: 2,
    packs: 1,
  });
  assert.equal(helpers.formatCrawlStatus(summary), 'Crawled 3 animation(s): 1 standalone, 2 from 1 pack(s).');
});
