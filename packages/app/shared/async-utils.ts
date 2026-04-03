/**
 * Resolve after a given number of milliseconds.
 */
export function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
