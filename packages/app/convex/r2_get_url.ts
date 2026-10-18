// Sign R2 GET URLs without the AWS SDK.
//
// Hand-written request signing is unusual, so here is why it exists. `r2_client.ts` signs with the
// AWS SDK, which adds about 750 KB to every module that imports it. Convex loads all of it on every
// action call and on every cold query, even to sign one URL. Every file open calls the snapshot
// action in `files_yjs_load.ts`, so it paid this each time. With this module the action got about
// 10ms faster at the median and 20ms faster at the fastest tenth (A/B on 2026-10-18).
//
// Choices:
// - No new dependency. A small signing package such as `aws4fetch` would also work, but the code
//   below is the standard SigV4 query signing and is about 40 lines.
// - The test at the bottom checks the result against the presigned URL example in the AWS S3 docs.
//   Keep that test passing when you change this code. A wrong signature makes R2 refuse every URL.
// - Scope: GET only, signed `host` header only, no `response-content-*` overrides, region `auto`,
//   and the same bucket host as the AWS SDK. R2 accepts at most 7 days for `expiresIn`.
// - Use `r2_client.ts` for everything else: uploads, deletes, metadata, copies, and read URLs that
//   pin the served type or file name (`responseContentType`, `responseContentDisposition`).
//
// Import this module instead of `r2_client.ts` only when a module needs a plain read URL and its
// imports are kept small on purpose, like the file open path in `files_yjs_load.ts`.

import { convex_error } from "../server/convex-utils.ts";

if (!process.env.R2_BUCKET_FILES) {
	throw convex_error({ message: "R2_BUCKET_FILES is not set in Convex env" });
}

const R2_BUCKET_FILES = process.env.R2_BUCKET_FILES;

if (!process.env.R2_ENDPOINT) {
	throw convex_error({ message: "R2_ENDPOINT is not set in Convex env" });
}

const R2_ENDPOINT = process.env.R2_ENDPOINT;

if (!process.env.R2_ACCESS_KEY_ID) {
	throw convex_error({ message: "R2_ACCESS_KEY_ID is not set in Convex env" });
}

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;

if (!process.env.R2_SECRET_ACCESS_KEY) {
	throw convex_error({ message: "R2_SECRET_ACCESS_KEY is not set in Convex env" });
}

const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

// Use the same bucket host as the AWS SDK: `https://<bucket>.<account>.r2.cloudflarestorage.com`.
const R2_BUCKET_ORIGIN = `https://${R2_BUCKET_FILES}.${new URL(R2_ENDPOINT).host}`;

const text_encoder = new TextEncoder();

function to_hex(bytes: ArrayBuffer) {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac_sha256(key: BufferSource, text: string) {
	const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return await crypto.subtle.sign("HMAC", cryptoKey, text_encoder.encode(text));
}

/**
 * Encode a URL part the way SigV4 wants: every byte except `A-Z a-z 0-9 - . _ ~`.
 * `encodeURIComponent` leaves `! ' ( ) *` as they are, so encode those too.
 */
function encode_sigv4(text: string) {
	return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build a presigned GET URL with SigV4 query parameters. Only the `host` header is signed, and the
 * body hash is `UNSIGNED-PAYLOAD`, like the AWS SDK presigner.
 */
async function sign_get_url(args: {
	origin: string;
	key: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	expiresIn: number;
	now: Date;
}) {
	// `2013-05-24T00:00:00.000Z` becomes `20130524T000000Z`.
	const amzDate = args.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const date = amzDate.slice(0, 8);
	const scope = `${date}/${args.region}/s3/aws4_request`;
	const path = `/${args.key.split("/").map(encode_sigv4).join("/")}`;

	// SigV4 needs the query parameters sorted by name. This list is already in that order.
	const query = [
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", `${args.accessKeyId}/${scope}`],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(args.expiresIn)],
		["X-Amz-SignedHeaders", "host"],
	]
		.map(([name, value]) => `${name}=${encode_sigv4(value)}`)
		.join("&");

	const host = new URL(args.origin).host;
	const canonicalRequest = ["GET", path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		to_hex(await crypto.subtle.digest("SHA-256", text_encoder.encode(canonicalRequest))),
	].join("\n");

	let signingKey = await hmac_sha256(text_encoder.encode(`AWS4${args.secretAccessKey}`), date);
	for (const part of [args.region, "s3", "aws4_request"]) {
		signingKey = await hmac_sha256(signingKey, part);
	}
	const signature = to_hex(await hmac_sha256(signingKey, stringToSign));

	return `${args.origin}${path}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * Return a signed URL that reads one object from the files bucket for `expiresIn` seconds.
 */
export async function r2_get_url(key: string, options: { expiresIn: number }) {
	return await sign_get_url({
		origin: R2_BUCKET_ORIGIN,
		key,
		region: "auto",
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
		expiresIn: options.expiresIn,
		now: new Date(),
	});
}

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("sign_get_url", () => {
		test("matches the presigned URL example in the AWS S3 docs", async () => {
			// From "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
			const url = await sign_get_url({
				origin: "https://examplebucket.s3.amazonaws.com",
				key: "test.txt",
				region: "us-east-1",
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				expiresIn: 86400,
				now: new Date("2013-05-24T00:00:00Z"),
			});

			expect(url).toBe(
				"https://examplebucket.s3.amazonaws.com/test.txt" +
					"?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
					"&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
					"&X-Amz-Date=20130524T000000Z" +
					"&X-Amz-Expires=86400" +
					"&X-Amz-SignedHeaders=host" +
					"&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
			);
		});
	});
}
