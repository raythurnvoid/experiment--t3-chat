// Address rules for the cloud web browser. The UI checks typed addresses with an empty deny list;
// the runner checks every navigation it starts with its own deny list. The provider's egress
// proxy is the real network boundary. These rules are UX and loop protection only.

export const browser_web_URL_MAX_CHARS = 8192;

export type browser_web_UrlRefusal = "empty" | "too_long" | "invalid" | "scheme" | "credentials" | "denied_host";

/**
 * Lowercase a host and drop one trailing dot, so `Example.COM.` and `example.com` compare equal.
 * `new URL` already turns Unicode hosts into punycode.
 */
export function browser_web_canonical_host(host: string) {
	const lower = host.toLowerCase();
	return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * True when `host` equals a listed host or is under it (`api.example.com` is under `example.com`).
 */
export function browser_web_host_matches(host: string, hosts: readonly string[]) {
	const canonical = browser_web_canonical_host(host);
	return hosts.some((listed) => {
		const item = browser_web_canonical_host(listed);
		return item !== "" && (canonical === item || canonical.endsWith(`.${item}`));
	});
}

/**
 * True when the host of `url` is one of `hosts` or under one. Addresses that do not parse never match.
 */
export function browser_web_url_host_matches(url: string, hosts: readonly string[]) {
	try {
		// URL keeps IPv6 hosts in brackets; the lists store plain names.
		return browser_web_host_matches(new URL(url).hostname.replace(/^\[|\]$/gu, ""), hosts);
	} catch {
		return false;
	}
}

/**
 * Turn a typed address into a URL the browser may open. No scheme means `https://`.
 */
export function browser_web_normalize_url(
	raw: string,
	deniedHosts: readonly string[],
): { ok: true; url: string } | { ok: false; reason: browser_web_UrlRefusal } {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: false, reason: "empty" };
	if (trimmed.length > browser_web_URL_MAX_CHARS) return { ok: false, reason: "too_long" };

	// Treat `example.com` and `localhost:3000` as hosts, not as a `localhost:` scheme.
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) || /^(?:about|data|javascript|file|blob|view-source):/iu.test(trimmed);
	let url: URL;
	try {
		url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
	} catch {
		return { ok: false, reason: "invalid" };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
	if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
	if (url.hostname === "") return { ok: false, reason: "invalid" };
	// URL keeps IPv6 hosts in brackets; the deny list stores plain names.
	if (browser_web_host_matches(url.hostname.replace(/^\[|\]$/gu, ""), deniedHosts)) {
		return { ok: false, reason: "denied_host" };
	}

	const href = url.href;
	if (href.length > browser_web_URL_MAX_CHARS) return { ok: false, reason: "too_long" };
	return { ok: true, url: href };
}
