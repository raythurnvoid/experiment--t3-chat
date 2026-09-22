const FILE_REFERENCE_SCHEME = "bonobo-file://";
const PRIVATE_REFERENCE_PREFIX = "private/";
const PRIVATE_REFERENCE_INVALID_ID_REGEX = /[/\\?#%\s]/;
const EXTERNAL_URL_REGEX = /^https?:\/\//i;

export function files_media_build_file_src(fileNodeId: string) {
	return `${FILE_REFERENCE_SCHEME}${fileNodeId}`;
}

export function files_media_build_private_src(privateNodeId: string) {
	return `${FILE_REFERENCE_SCHEME}${PRIVATE_REFERENCE_PREFIX}${privateNodeId}`;
}

/**
 * Read an embed reference. IDs stay untrusted strings until the backend normalizes them.
 */
export function files_media_parse_src(src: string) {
	if (src.startsWith(FILE_REFERENCE_SCHEME)) {
		const reference = src.slice(FILE_REFERENCE_SCHEME.length);
		if (reference === "private") return { kind: "unsupported" as const };
		if (reference.startsWith(PRIVATE_REFERENCE_PREFIX)) {
			const privateNodeId = reference.slice(PRIVATE_REFERENCE_PREFIX.length);
			// Private references name one ID, with no URL decoding or path normalization.
			if (
				!privateNodeId ||
				privateNodeId === "." ||
				privateNodeId === ".." ||
				PRIVATE_REFERENCE_INVALID_ID_REGEX.test(privateNodeId)
			) {
				return { kind: "unsupported" as const };
			}
			return { kind: "private" as const, privateNodeId };
		}
		return { kind: "file" as const, fileNodeId: reference };
	}

	if (EXTERNAL_URL_REGEX.test(src)) {
		return { kind: "external" as const, url: src };
	}

	return { kind: "unsupported" as const };
}
