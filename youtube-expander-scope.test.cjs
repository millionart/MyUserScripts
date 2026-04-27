const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'YouTube Subscription Category Manager.user.js');
const code = fs.readFileSync(scriptPath, 'utf8');

test('subscription expander lookup is scoped to the subscriptions section', () => {
  const functionStart = code.indexOf('function getSubscriptionsExpander(section)');
  const functionEnd = code.indexOf('async function ensureSubscriptionsExpanded()', functionStart);

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const functionBody = code.slice(functionStart, functionEnd);

  assert.equal(functionBody.includes('document'), false);
  assert.equal(functionBody.includes('const scopes'), false);
  assert.equal(functionBody.includes('for (const scope'), false);
  assert.equal(functionBody.includes('section.querySelector'), true);
  assert.equal(functionBody.includes('section.querySelectorAll'), true);
});
