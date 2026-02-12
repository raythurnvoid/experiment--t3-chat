export type AppElementId =
	| "root"
	| "app_tiptap_hoisting_container"
	| "app_monaco_hoisting_container"
	| "app_page_editor_sidebar_tabs_comments"
	| "app_page_editor_sidebar_tabs_agent";

/**
 * Global class names defined in app.css that can be used across components.
 * Use with `satisfies AppClassName` for type-safe class name usage.
 */
export type AppClassName = "app-doc" | "app-font-monospace";

export type AppDataTestId = "";

export class dom_TypedAttributeAccessor<CustomAttributes extends Record<string, string>> {
	get<AttributeName extends keyof CustomAttributes & string>(
		attributeName: AttributeName,
		element: Element,
	): CustomAttributes[AttributeName] | null {
		return element.getAttribute(attributeName) as CustomAttributes[AttributeName] | null;
	}
}

export function dom_find_first_element_overflowing_element(
	scrollEl: Element,
	elements: readonly Element[],
	direction: "up" | "down",
): Element | null {
	const scrollRect = scrollEl.getBoundingClientRect();

	if (direction === "down") {
		for (const element of elements) {
			if (element.getBoundingClientRect().bottom > scrollRect.bottom) {
				return element;
			}
		}

		return null;
	}

	for (let index = elements.length - 1; index >= 0; index -= 1) {
		const element = elements[index];
		if (element && element.getBoundingClientRect().top < scrollRect.top) {
			return element;
		}
	}

	return null;
}
