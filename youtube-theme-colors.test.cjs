const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'YouTube Subscription Category Manager.user.js');
const code = fs.readFileSync(scriptPath, 'utf8');

test('category panel text uses script-owned theme colors instead of naked YouTube variables', () => {
  assert.equal(code.includes('--ytscm-text-primary'), true);
  assert.equal(code.includes('--ytscm-text-secondary'), true);
  assert.equal(code.includes('color:var(--yt-spec-text-primary);'), false);
  assert.equal(code.includes('color:var(--yt-spec-text-secondary);'), false);
});
