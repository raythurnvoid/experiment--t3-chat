// happy-dom has no Popover API, and native-popovers calls `showPopover()` when a tooltip, a popover,
// or a menu opens. Give test elements empty versions, so they render their content like in the browser.
// happy-dom also has no rule that hides a closed popover, so content that stays mounted while
// closed is visible to queries here.
// happy-dom never matches `:popover-open`, so the library does not call `hidePopover()` today.
// Stub it too, so a later library change does not throw in tests.
HTMLElement.prototype.showPopover = function showPopover() {};
HTMLElement.prototype.hidePopover = function hidePopover() {};

// This file also runs for the jsdom test files. jsdom 29 has no Popover API either, but its default
// stylesheet hides every `[popover]` that does not match `:popover-open`, and that never matches.
// Undo that rule there, so jsdom shows an open list like happy-dom does. `hidden` still hides a
// closed list that stays mounted. jsdom ranks rules only by selector specificity, even against its
// own stylesheet, so this selector repeats jsdom's selector and adds `:not([hidden])` to win.
if (navigator.userAgent.includes("jsdom")) {
	const style = document.createElement("style");
	style.textContent = "[popover]:not([hidden]):not(:popover-open):not(dialog[open]) { display: block; }";
	document.head.append(style);
}

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
