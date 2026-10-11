// happy-dom has no Popover API, and native-popovers calls `showPopover()` when a tooltip, a popover,
// or a menu opens. Give test elements empty versions, so they render their content like in the browser.
// happy-dom also has no rule that hides a closed popover, so content that stays mounted while
// closed is visible to queries here.
// happy-dom never matches `:popover-open`, so the library does not call `hidePopover()` today.
// Stub it too, so a later library change does not throw in tests.
HTMLElement.prototype.showPopover = function showPopover() {};
HTMLElement.prototype.hidePopover = function hidePopover() {};

// happy-dom has no `checkVisibility()`. The menu uses it to skip hidden items in the keys and
// typeahead. Treat an element as hidden when it or an ancestor has `hidden` or `display: none`.
Element.prototype.checkVisibility = function checkVisibility() {
	for (let element: Element | null = this; element; element = element.parentElement) {
		if (element.hasAttribute("hidden") || getComputedStyle(element).display === "none") {
			return false;
		}
	}
	return true;
};

// Ariakit also uses `checkVisibility()` when it exists. With it, Ariakit sees dialog content as
// visible, and its focus on show calls `scrollIntoView()`, which happy-dom does not have either.
Element.prototype.scrollIntoView = function scrollIntoView() {};
