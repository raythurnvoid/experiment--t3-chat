/**
 * Accept only the official share link or its lowercase ID.
 */
export function playwriter_parse_share(input: string) {
	const value = input.trim();
	if (/^[a-f0-9]{32}$/.test(value)) return value;
	return /^https:\/\/playwriter\.dev\/remote-control#([a-f0-9]{32})$/.exec(value)?.[1] ?? null;
}

/**
 * Keep possible share secrets out of chat before it is sent.
 */
export function playwriter_share_text_kind(text: string) {
	if (/https:\/\/playwriter\.dev\/remote-control#[a-f0-9]{32}\b/.test(text)) return "share" as const;
	if (/--remote(?:\s+|=)[a-f0-9]{32}\b/.test(text)) return "share" as const;
	if (/\b[a-f0-9]{32}\b/.test(text)) return "possible" as const;
	return null;
}
