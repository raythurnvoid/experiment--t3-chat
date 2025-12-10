export function objects_equal_shallow(a: Record<string, unknown> | unknown[], b: Record<string, unknown> | unknown[]) {
	if (Object.is(a, b)) {
		return true;
	}

	// typeof `null` is "object" in js so we need to check for it
	// to avoid let it enter the object/array comparison.
	if (typeof a !== "object" || a === null) {
		return false;
	}
	if (typeof b !== "object" || b === null) {
		return false;
	}

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) {
			return false;
		}

		if (a.length !== b.length) {
			return false;
		}

		for (let i = 0; i < a.length; i++) {
			// Arrays are deterministic by index order; no sorting needed.
			if (a[i] !== b[i]) {
				return false;
			}
		}

		return true;
	}

	// Sort for deterministic comparison.
	const aKeys = Object.keys(a).sort();
	const bKeys = Object.keys(b).sort();

	if (aKeys.length !== bKeys.length) {
		return false;
	}

	for (let i = 0; i < aKeys.length; i++) {
		const key = aKeys[i];

		// Deterministic: compare sorted keys first (same keys, same order),
		// then compare values shallowly.
		if (key !== bKeys[i]) {
			return false;
		}

		if (!Object.is(a[key], b[key])) {
			return false;
		}
	}

	return true;
}

export function objects_equal_deep(a: Record<string, unknown> | unknown[], b: Record<string, unknown> | unknown[]) {
	const stack: Array<[unknown, unknown]> = [[a, b]];

	while (stack.length > 0) {
		const pair = stack.pop();
		if (!pair) {
			break;
		}

		const [left, right] = pair;

		if (Object.is(left, right)) {
			continue;
		}

		// typeof `null` is "object" in js so we need to check for it
		// to avoid let it enter the object/array comparison.
		if (typeof left !== "object" || left === null) {
			return false;
		}
		if (typeof right !== "object" || right === null) {
			return false;
		}

		if (Array.isArray(left) || Array.isArray(right)) {
			if (!Array.isArray(left) || !Array.isArray(right)) {
				return false;
			}

			if (left.length !== right.length) {
				return false;
			}

			// DFS (LIFO): push children in reverse so index 0 is processed first.
			// We need to add the items in reverse order so that pop() returns
			// the items to compare in the natural order (index 0 first).
			for (let i = left.length - 1; i >= 0; i--) {
				stack.push([left[i], right[i]]);
			}

			continue;
		}

		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;

		// Sort for deterministic comparison.
		const leftKeys = Object.keys(leftRecord).sort();
		const rightKeys = Object.keys(rightRecord).sort();

		if (leftKeys.length !== rightKeys.length) {
			return false;
		}

		// Check that the keys are the same.
		for (let i = 0; i < leftKeys.length; i++) {
			const key = leftKeys[i];
			if (key !== rightKeys[i]) {
				return false;
			}
		}

		// DFS (LIFO): push children in reverse so the first key is processed first.
		// We need to add the keys in reverse order so that pop() returns
		// the fields to compare in the natural order (index 0 first).
		for (let i = leftKeys.length - 1; i >= 0; i--) {
			const key = leftKeys[i];
			stack.push([leftRecord[key], rightRecord[key]]);
		}
	}

	return true;
}
