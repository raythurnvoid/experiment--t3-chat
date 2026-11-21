// Plugin origin lists hold exact origins (`https://api.example.com`) and wildcard patterns
// (`https://*.example.com`). The app checks the syntax when a manifest is read. The plugin runner
// uses the matcher below for every backend fetch. The browser applies the same rule to the page CSP.

/**
 * Return the exact origin a wildcard entry is built on.
 * `https://*.example.com` gives `https://example.com`. An entry without `*.` gives null.
 */
export function origin_patterns_base_origin(entry: string) {
	const match = /^(https|wss):\/\/\*\.(.+)$/u.exec(entry);
	return match ? `${match[1]}://${match[2]}` : null;
}

/**
 * Check one request URL against a list of exact origins and wildcard patterns.
 * A pattern matches every subdomain of its base host, at any depth, and never the base host itself.
 * This is the same rule the browser uses for a CSP host source.
 */
export function origin_patterns_allows(entries: readonly string[], url: URL) {
	return entries.some((entry) => {
		const baseOrigin = origin_patterns_base_origin(entry);
		if (baseOrigin === null) {
			return entry === url.origin;
		}

		const base = new URL(baseOrigin);
		return url.protocol === base.protocol && url.port === base.port && url.hostname.endsWith(`.${base.hostname}`);
	});
}
