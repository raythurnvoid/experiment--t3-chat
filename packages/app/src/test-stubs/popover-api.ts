// happy-dom has no Popover API, and native-popovers calls `showPopover()` when a tooltip or a
// popover opens. Give test elements empty versions, so they render their content like in the browser.
// happy-dom also has no rule that hides a closed popover, so content that stays mounted while
// closed is visible to queries here.
// happy-dom never matches `:popover-open`, so the library does not call `hidePopover()` today.
// Stub it too, so a later library change does not throw in tests.
HTMLElement.prototype.showPopover = function showPopover() {};
HTMLElement.prototype.hidePopover = function hidePopover() {};
