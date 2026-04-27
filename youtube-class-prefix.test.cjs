const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'YouTube Subscription Category Manager.user.js');
const code = fs.readFileSync(scriptPath, 'utf8');

test('does not use generic dialog overlay class names that can collide with YouTube UI', () => {
  assert.equal(code.includes('.yt-dialog-overlay'), false);
  assert.equal(code.includes("querySelector('.yt-dialog-overlay')"), false);
  assert.equal(code.includes("overlay.className = 'yt-dialog-overlay'"), false);
});

test('uses namespaced dialog classes for custom overlay UI', () => {
  assert.equal(code.includes('.ytscm-dialog-overlay'), true);
  assert.equal(code.includes("querySelector('.ytscm-dialog-overlay')"), true);
  assert.equal(code.includes("overlay.className = 'ytscm-dialog-overlay'"), true);
});
