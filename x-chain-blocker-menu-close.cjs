function createEscapeKeydownEvent() {
  return {
    type: 'keydown',
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true
  };
}

function getClosestMenuNode(target) {
  if (!target || typeof target.closest !== 'function') {
    return null;
  }
  return target.closest('div[role="menu"]') || target.closest('[role="menu"]');
}

function getDropdownOverlayRoot(target) {
  if (!target || typeof target.closest !== 'function') {
    return null;
  }
  return target.closest('div[data-testid="Dropdown"]') || target.closest('[data-testid="Dropdown"]');
}

function closeMenuFromEvent(event) {
  const target = event?.target || null;
  const dropdownRoot = getDropdownOverlayRoot(target);
  const menuNode = getClosestMenuNode(target);
  const removableContainer = dropdownRoot?.parentElement || menuNode?.parentElement || null;

  if (removableContainer && typeof removableContainer.remove === 'function') {
    removableContainer.remove();
    return true;
  }

  if (menuNode && typeof menuNode.dispatchEvent === 'function') {
    menuNode.dispatchEvent(createEscapeKeydownEvent());
    return true;
  }

  return false;
}

module.exports = {
  closeMenuFromEvent
};
