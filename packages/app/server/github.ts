// Shared GitHub fetch helpers for server-side importers (plugin publishing, repo mirror sync).
// All requests carry the shared import token when `GITHUB_TOKEN_IMPORT` is set; without it GitHub
// serves anonymous rate limits (60 requests/hour per IP).

import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { delay } from "../shared/async-utils.ts";

const GITHUB_TOKEN_IMPORT = process.env.GITHUB_TOKEN_IMPORT;

const GITHUB_FETCH_USER_AGENT = "t3-chat-github-import";

/** Bounded retry for transient GitHub/codeload failures (429/403-rate/5xx/transient-404 after a push). */
const GITHUB_FETCH_MAX_ATTEMPTS = 4;
const GITHUB_FETCH_BACKOFF_BASE_MS = 600;

if (!GITHUB_TOKEN_IMPORT) {
	console.warn("GITHUB_TOKEN_IMPORT is not set; GitHub imports run anonymous (60 requests/hour rate limit)");
}

function github_headers(accept?: string) {
	const headers: Record<string, string> = { "User-Agent": GITHUB_FETCH_USER_AGENT };
	if (accept) {
		headers.Accept = accept;
	}

	if (GITHUB_TOKEN_IMPORT) {
		headers.Authorization = `Bearer ${GITHUB_TOKEN_IMPORT}`;
	}

	return headers;
}

/** Build the raw-content URL for one commit-pinned file. */
export function github_raw_url(args: { owner: string; repo: string; commitSha: string; path: string }) {
	const path = args.path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");

	return `https://raw.githubusercontent.com/${args.owner}/${args.repo}/${args.commitSha}/${path}`;
}

/** Build the commit-pinned codeload archive URL. */
export function github_codeload_url(args: { owner: string; repo: string; commitSha: string }) {
	return `https://codeload.github.com/${args.owner}/${args.repo}/zip/${args.commitSha}`;
}

/**
 * Fetch with bounded backoff for transient GitHub/codeload failures. `allowTransient404` covers codeload
 * archive lag immediately after a push. Returns the first 2xx response or a `_nay` describing the failure.
 */
export async function github_fetch_with_retry(
	url: string,
	options?: { accept?: string; allowTransient404?: boolean },
) {
	let lastStatus = 0;
	for (let attempt = 0; attempt < GITHUB_FETCH_MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await delay(GITHUB_FETCH_BACKOFF_BASE_MS * 2 ** (attempt - 1));
		}
		let response: Response;
		try {
			response = await fetch(url, { headers: github_headers(options?.accept) });
		} catch {
			lastStatus = 0;
			continue;
		}
		if (response.ok) {
			return Result({ _yay: response });
		}
		lastStatus = response.status;
		const isTransient =
			response.status === 429 ||
			response.status === 403 ||
			response.status >= 500 ||
			(response.status === 404 && (options?.allowTransient404 ?? false));
		// Drain the body so the connection can be reused before the next attempt.
		await response.text().catch(() => undefined);
		if (!isTransient) {
			break;
		}
	}
	return Result({ _nay: { message: `Request to ${url} failed after retries (last status ${lastStatus})` } });
}

/** Fetch a GitHub REST endpoint and validate the JSON payload. */
async function github_fetch_json<T>(url: string, schema: z.ZodSchema<T>) {
	const response = await github_fetch_with_retry(url, { accept: "application/vnd.github+json" });
	if (response._nay) {
		return response;
	}

	let json: unknown;
	try {
		json = await response._yay.json();
	} catch (error) {
		return Result({
			_nay: {
				message: `GitHub response was invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				cause: error,
			},
		});
	}

	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return Result({ _nay: { message: parsed.error.issues[0]?.message ?? "GitHub response was invalid" } });
	}

	return Result({ _yay: parsed.data });
}

/**
 * Resolve a repo's default branch and the head commit (+ tree) of `ref`, which defaults to the
 * default branch. The commits endpoint accepts branch names, tags, and SHAs.
 */
export async function github_fetch_repo_head(args: { owner: string; repo: string; ref?: string }) {
	const repo = await github_fetch_json(
		`https://api.github.com/repos/${args.owner}/${args.repo}`,
		z.object({ default_branch: z.string().min(1) }),
	);
	if (repo._nay) {
		return repo;
	}

	const defaultBranch = repo._yay.default_branch;
	const commit = await github_fetch_json(
		`https://api.github.com/repos/${args.owner}/${args.repo}/commits/${encodeURIComponent(args.ref ?? defaultBranch)}`,
		z.object({ sha: z.string().min(1), commit: z.object({ tree: z.object({ sha: z.string().min(1) }) }) }),
	);
	if (commit._nay) {
		return commit;
	}

	return Result({
		_yay: { defaultBranch, commitSha: commit._yay.sha, treeSha: commit._yay.commit.tree.sha },
	});
}
