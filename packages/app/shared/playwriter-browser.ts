/**
 * Accept only the official share link or its lowercase ID.
 */
export function playwriter_parse_share(input: string) {
	const value = input.trim();
	if (/^[a-f0-9]{32}$/.test(value)) return value;
	return /^https:\/\/playwriter\.dev\/remote-control#([a-f0-9]{32})$/.exec(value)?.[1] ?? null;
}
