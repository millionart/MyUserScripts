const test = require('node:test');
const assert = require('node:assert/strict');

const { closeMenuFromEvent } = require('./x-chain-blocker-menu-close.cjs');

function createNode(label, options = {}) {
  const node = {
    label,
    parentElement: null,
    removed: false,
    dispatchedEvents: [],
    closestSelectors: options.closestSelectors || {},
    closest(selector) {
      return this.closestSelectors[selector] || null;
    },
    remove() {
      this.removed = true;
    },
    dispatchEvent(event) {
      this.dispatchedEvents.push(event);
      return true;
    }
  };
  return node;
}

test('removes legacy dropdown overlay container when present', () => {
  const overlayParent = createNode('overlayParent');
  const legacyDropdown = createNode('legacyDropdown', {
    closestSelectors: {
      '[data-testid="Dropdown"]': null
    }
  });
  legacyDropdown.parentElement = overlayParent;

  const clickTarget = createNode('clickTarget', {
    closestSelectors: {
      'div[data-testid="Dropdown"]': legacyDropdown,
      '[data-testid="Dropdown"]': legacyDropdown,
      'div[role="menu"]': null,
      '[role="menu"]': null
    }
  });

  const result = closeMenuFromEvent({ target: clickTarget });

  assert.equal(result, true);
  assert.equal(overlayParent.removed, true);
});

test('removes modern menu overlay container via role=menu ancestry', () => {
  const overlay = createNode('overlay');
  const menu = createNode('menu', {
    closestSelectors: {
      '[data-testid="Dropdown"]': null
    }
  });
  menu.parentElement = overlay;

  const clickTarget = createNode('clickTarget', {
    closestSelectors: {
      'div[data-testid="Dropdown"]': null,
      '[data-testid="Dropdown"]': null,
      'div[role="menu"]': menu,
      '[role="menu"]': menu
    }
  });

  const result = closeMenuFromEvent({ target: clickTarget });

  assert.equal(result, true);
  assert.equal(overlay.removed, true);
});

test('falls back to Escape when no removable overlay container exists', () => {
  const menu = createNode('menu');
  const clickTarget = createNode('clickTarget', {
    closestSelectors: {
      'div[data-testid="Dropdown"]': null,
      '[data-testid="Dropdown"]': null,
      'div[role="menu"]': menu,
      '[role="menu"]': menu
    }
  });

  const result = closeMenuFromEvent({ target: clickTarget });

  assert.equal(result, true);
  assert.equal(menu.dispatchedEvents.length, 1);
  assert.equal(menu.dispatchedEvents[0].type, 'keydown');
  assert.equal(menu.dispatchedEvents[0].key, 'Escape');
});
