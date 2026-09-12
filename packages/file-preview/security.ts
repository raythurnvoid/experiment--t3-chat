export function file_preview_security_config(value: string | undefined, local: boolean) {
	const origins =
		value?.split(",").map((origin) => origin.trim()) ??
		(local ? ["http://localhost:5173", "http://127.0.0.1:5173"] : []);
	if (origins.length === 0) throw new Error("Set FILE_PREVIEW_PARENT_ORIGINS to the exact Press origins.");
	for (const origin of origins) {
		const url = new URL(origin);
		const localOrigin = local && (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173");
		if (url.origin !== origin || url.hostname.includes("*") || (local ? !localOrigin : url.protocol !== "https:")) {
			throw new Error("FILE_PREVIEW_PARENT_ORIGINS must contain exact HTTPS origins, or the documented local origins.");
		}
	}

	const csp = [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline' https://esm.sh",
		"style-src 'self' 'unsafe-inline'",
		"connect-src https://esm.sh",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"font-src 'self' data:",
		"worker-src 'none'",
		"frame-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors 'self' ${origins.join(" ")}`,
		...(!local ? ["upgrade-insecure-requests"] : []),
	].join("; ");
	const headers = {
		"Content-Security-Policy": csp,
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Permissions-Policy":
			"camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(), publickey-credentials-create=(), identity-credentials-get=()",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Origin-Agent-Cluster": "?1",
	};

	const headerLines = Object.entries(headers).map(([name, content]) => `  ${name}: ${content}`);
	if (headerLines.some((line) => line.length > 2_000))
		throw new Error("The preview header exceeds the static host limit.");
	return { origins, headers, staticHeaders: `/*\n${headerLines.join("\n")}\n` };
}
