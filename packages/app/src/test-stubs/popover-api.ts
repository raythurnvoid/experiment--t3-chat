// happy-dom has no Popover API, and native-popovers calls `showPopover()` when a tooltip opens.
// Give test elements empty versions, so a tooltip renders its content like in the browser.
// happy-dom never matches `:popover-open`, so the library does not call `hidePopover()` today.
// Stub it too, so a later library change does not throw in tests.
HTMLElement.prototype.showPopover = function showPopover() {};
HTMLElement.prototype.hidePopover = function hidePopover() {};
