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

test('dispatches Escape before removing legacy dropdown overlay container when menu exists', () => {
  const overlayParent = createNode('overlayParent');
  const menu = createNode('menu');
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
      'div[role="menu"]': menu,
      '[role="menu"]': menu
    }
  });

  const result = closeMenuFromEvent({ target: clickTarget });

  assert.equal(result, true);
  assert.equal(menu.dispatchedEvents.length, 1);
  assert.equal(overlayParent.removed, false);
});

test('dispatches Escape for modern role=menu overlays instead of removing them', () => {
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
  assert.equal(menu.dispatchedEvents.length, 1);
  assert.equal(overlay.removed, false);
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

test('removes overlay container when only dropdown ancestry exists', () => {
  const overlayParent = createNode('overlayParent');
  const legacyDropdown = createNode('legacyDropdown');
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
