import type { IconNode } from "lucide-react";

/**
 * Creates an SVG element from a Lucide icon node array.
 *
 * @param iconNode - Array of icon node tuples [tagName, attrs]
 * @param className - Optional CSS class name to apply to the SVG element
 *
 * @returns An SVG element with the icon paths rendered
 */
export function icons_create_svg_from_lucide_node(iconNode: IconNode, className?: string): SVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	if (className) {
		svg.classList.add(className);
	}

	for (const [tagName, attrs] of iconNode) {
		const el = document.createElementNS("http://www.w3.org/2000/svg", tagName);
		for (const [attrName, attrValue] of Object.entries(attrs)) {
			// Lucide includes a React-only `key` value in the node data.
			if (attrName === "key") continue;
			el.setAttribute(attrName, attrValue);
		}
		svg.appendChild(el);
	}

	return svg;
}
