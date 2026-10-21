#!/usr/bin/env node
// Usage: node api.mjs <login | status | logout | call | upload> [options]
// Small Bonobo Senate public API client for agents and people on a PC. Node 22 or newer, no dependencies.
// Read references/setup.md in this skill folder before using it.
//
// Exit codes: 0 ok, 1 the API or an upload failed, 2 usage error, 4 no API key is set up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage:
  node api.mjs login --origin <api origin>     Read the key from stdin (a pipe or a hidden prompt), check it, save it.
  node api.mjs status                          Check the saved key. Prints the organization, workspace, and scopes.
  node api.mjs logout                          Delete the saved key file.
  node api.mjs call <route> [json | -]         POST one route, for example: call files/list '{"path":"/"}'
                                               Use - to read the JSON body from stdin.
  node api.mjs upload <local path>... --to <folder> [--overwrite replace|fail] [--skip-processing] [--dry-run]
                                               Upload files and folders. A folder keeps its own name under --to.`;

// Keep the key in the home folder, not in this skill folder and not in AppData.
// A reinstall of the skill replaces its folder, which would delete the key.
// Packaged Windows apps (such as the Claude desktop app) get a private copy of AppData,
// so a key saved there by an agent could be invisible to the user's own terminal.
const CREDENTIALS_PATH = path.join(
	process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
	"bonobo-senate",
	"credentials.json",
);

const KEY_PATTERN = /^pk_[0-9a-f]{32}\.[0-9a-f]{64}$/u;

// The server accepts at most 20 files per upload-urls call.
const UPLOAD_BATCH_SIZE = 20;

// Keep a few PUTs in flight. Each one holds its whole file in memory.
const UPLOAD_CONCURRENCY = 4;

const CONTENT_TYPES = {
	".md": "text/markdown",
	".txt": "text/plain",
	".csv": "text/csv",
	".json": "application/json",
	".html": "text/html",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".zip": "application/zip",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

class UsageError extends Error {}

class NoKeyError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// #region credentials
function load_credentials() {
	// An env key wins over the saved file, the same way GH_TOKEN wins in the gh CLI.
	if (process.env.T3_API_KEY) {
		if (!process.env.T3_API_ORIGIN) {
			throw new UsageError("T3_API_KEY is set, but T3_API_ORIGIN is not. Set both, or unset T3_API_KEY.");
		}
		return { source: "env", origin: process.env.T3_API_ORIGIN, key: process.env.T3_API_KEY };
	}

	if (!fs.existsSync(CREDENTIALS_PATH)) {
		throw new NoKeyError(
			`No API key is set up. Ask the user to run "node api.mjs login --origin <api origin>" in their own terminal. See references/setup.md.`,
		);
	}
	const saved = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
	if (typeof saved?.origin !== "string" || typeof saved?.key !== "string") {
		throw new NoKeyError(`The key file is damaged: ${CREDENTIALS_PATH}. Run login again.`);
	}
	return { source: "file", origin: saved.origin, key: saved.key };
}

function check_origin(origin) {
	let url;
	try {
		url = new URL(origin);
	} catch {
		throw new UsageError(`Not a valid URL: ${origin}`);
	}

	// Send the key only over HTTPS. Plain HTTP is fine only for a local server.
	const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
		throw new UsageError(`The API origin must use https: ${origin}`);
	}
	return url.origin;
}

function read_hidden(prompt) {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		let value = "";

		const finish = () => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
		};
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish();
					resolve(value);
					return;
				}
				// Ctrl+C
				if (char === "\u0003") {
					finish();
					reject(new UsageError("Canceled"));
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
				} else {
					value += char;
				}
			}
		};

		process.stderr.write(prompt);
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		stdin.on("data", onData);
	});
}

async function read_stdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}
// #endregion credentials

// #region requests
async function post(credentials, route, body) {
	const routePath = route.startsWith("/api/v1/") ? route : `/api/v1/${route.replace(/^\/+/u, "")}`;
	const response = await fetch(new URL(routePath, credentials.origin), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.key}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "error",
	});

	const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
	const bytes = Buffer.from(await response.arrayBuffer());
	return { status: response.status, ok: response.ok, isJson, bytes, json: isJson ? JSON.parse(bytes.toString("utf8")) : null };
}

// Wait and retry when the server says the rate limit is reached. Other errors return at once.
async function post_with_retry(credentials, route, body) {
	for (let attempt = 1; ; attempt++) {
		const result = await post(credentials, route, body);
		if (result.status !== 429 || attempt === 5) return result;

		const waitMs = result.json?.retryAfterMs ?? 2000;
		process.stderr.write(`Rate limited on ${route}. Waiting ${Math.ceil(waitMs / 1000)}s.\n`);
		await sleep(waitMs);
	}
}

function describe_error(result) {
	return `HTTP ${result.status}: ${result.json?.message ?? result.bytes.toString("utf8").slice(0, 500)}`;
}
// #endregion requests

// #region commands
async function command_login(args) {
	const { values } = parseArgs({ args, options: { origin: { type: "string" } } });
	if (!values.origin) {
		throw new UsageError(
			`--origin is required. Copy it from the "Use an API key" section of the API keys page (the T3_API_ORIGIN value).`,
		);
	}
	const origin = check_origin(values.origin);

	const typed = process.stdin.isTTY ? await read_hidden("Paste the API key (it stays hidden): ") : await read_stdin();
	// Terminals can wrap a paste in bracketed-paste markers. Drop them.
	const key = typed.replace(/\u001b\[20[01]~/gu, "").trim();
	if (!KEY_PATTERN.test(key)) {
		throw new UsageError("That is not an API key. A key looks like pk_<32 hex>.<64 hex>.");
	}

	const verified = await post({ origin, key }, "auth/verify");
	if (!verified.ok) {
		throw new Error(`The key was not saved. ${describe_error(verified)}`);
	}

	fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
	fs.writeFileSync(CREDENTIALS_PATH, `${JSON.stringify({ origin, key }, null, "\t")}\n`, { mode: 0o600 });
	// writeFileSync keeps the mode of an existing file, so set it again.
	fs.chmodSync(CREDENTIALS_PATH, 0o600);

	console.log(JSON.stringify({ saved: CREDENTIALS_PATH, origin, ...verified.json }, null, 2));
}

async function command_status() {
	const credentials = load_credentials();
	const verified = await post(credentials, "auth/verify");
	if (!verified.ok) {
		throw new Error(`The ${credentials.source === "env" ? "T3_API_KEY" : "saved"} key does not work. ${describe_error(verified)}`);
	}

	console.log(
		JSON.stringify(
			{
				source: credentials.source,
				...(credentials.source === "file" ? { path: CREDENTIALS_PATH } : {}),
				origin: credentials.origin,
				...verified.json,
			},
			null,
			2,
		),
	);
}

function command_logout() {
	if (!fs.existsSync(CREDENTIALS_PATH)) {
		console.log(JSON.stringify({ deleted: null }));
		return;
	}
	fs.rmSync(CREDENTIALS_PATH);
	// Deleting the file does not revoke the key. Revoke it on the API keys page too.
	console.log(JSON.stringify({ deleted: CREDENTIALS_PATH, note: "The key still works until you revoke it on the API keys page." }));
}

async function command_call(args) {
	const [route, bodyArg, ...extra] = args;
	if (!route || extra.length > 0) throw new UsageError(USAGE);

	let body;
	if (bodyArg !== undefined) {
		const text = bodyArg === "-" ? await read_stdin() : bodyArg;
		try {
			body = JSON.parse(text);
		} catch {
			throw new UsageError("The request body is not valid JSON.");
		}
	}

	const result = await post(load_credentials(), route, body);
	if (!result.ok) {
		process.stderr.write(`${describe_error(result)}\n`);
		if (result.json) process.stderr.write(`${JSON.stringify(result.json)}\n`);
		return 1;
	}

	// JSON goes out readable. Raw bytes (files/read-bytes) go out unchanged, so redirect them to a file.
	if (result.isJson) {
		console.log(JSON.stringify(result.json, null, 2));
	} else {
		process.stdout.write(result.bytes);
	}
	return 0;
}

async function command_upload(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			to: { type: "string" },
			overwrite: { type: "string" },
			"skip-processing": { type: "boolean" },
			"dry-run": { type: "boolean" },
		},
	});
	if (positionals.length === 0 || !values.to?.startsWith("/")) {
		throw new UsageError(`Give at least one local path and --to /<workspace folder>.\n\n${USAGE}`);
	}
	if (values.overwrite !== undefined && values.overwrite !== "replace" && values.overwrite !== "fail") {
		throw new UsageError("--overwrite must be replace or fail.");
	}

	// Build the list of files. A folder keeps its own name under --to, like "cp -R folder dest".
	const items = [];
	const failed = [];
	const remoteRoot = values.to.replace(/\/+$/u, "");
	for (const localArg of positionals) {
		const localRoot = path.resolve(localArg);
		const stat = fs.statSync(localRoot, { throwIfNoEntry: false });
		if (!stat) {
			failed.push({ local: localRoot, path: null, message: "Local path not found" });
			continue;
		}

		const files = stat.isDirectory()
			? fs
					.readdirSync(localRoot, { recursive: true, withFileTypes: true })
					.filter((entry) => entry.isFile())
					.map((entry) => path.join(entry.parentPath, entry.name))
			: [localRoot];
		for (const local of files) {
			const relative = path.relative(path.dirname(localRoot), local).split(path.sep).join("/");
			const size = fs.statSync(local).size;
			const item = {
				local,
				path: `${remoteRoot}/${relative}`,
				contentType: CONTENT_TYPES[path.extname(local).toLowerCase()] ?? "application/octet-stream",
				size,
			};
			if (size === 0) {
				failed.push({ ...item, message: "Empty file. An upload needs at least 1 byte. Use files/touch for an empty text file." });
			} else {
				items.push(item);
			}
		}
	}

	if (values["dry-run"]) {
		console.log(JSON.stringify({ wouldUpload: items, failed }, null, 2));
		return failed.length > 0 ? 1 : 0;
	}

	const credentials = load_credentials();
	const uploaded = [];
	let stopMessage = null;
	for (let start = 0; start < items.length; start += UPLOAD_BATCH_SIZE) {
		let batch = items.slice(start, start + UPLOAD_BATCH_SIZE);

		// After a refusal that hits every file, the later batches would fail the same way.
		if (stopMessage) {
			for (const item of batch) failed.push({ ...item, message: stopMessage });
			continue;
		}

		// The server checks the whole batch before it writes anything, and it names the path it refused.
		// Keep what worked: drop that one file and ask again for the rest.
		let targets = null;
		while (batch.length > 0) {
			const result = await post_with_retry(credentials, "files/upload-urls", {
				files: batch.map(({ path, contentType, size }) => ({ path, contentType, size })),
				overwrite: values.overwrite,
				skipProcessing: values["skip-processing"],
			});
			if (result.ok) {
				targets = result.json.files;
				break;
			}

			// A refusal without a path (a bad key, no upload plan, a rate limit that did not clear) hits every file.
			const refused = batch.find((item) => item.path === result.json?.path);
			if (!refused || result.status === 401 || result.status === 429) {
				stopMessage = describe_error(result);
				for (const item of batch) failed.push({ ...item, message: stopMessage });
				batch = [];
				break;
			}
			failed.push({ ...refused, message: describe_error(result) });
			batch = batch.filter((item) => item !== refused);
		}
		if (!targets) continue;

		const queue = targets.map((target, index) => ({ target, item: batch[index] }));
		await Promise.all(
			Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
				for (let next = queue.shift(); next; next = queue.shift()) {
					const { target, item } = next;
					const response = await fetch(target.uploadUrl, {
						method: "PUT",
						headers: target.headers,
						body: await fs.promises.readFile(item.local),
					}).catch((error) => ({ ok: false, status: 0, statusText: String(error) }));

					if (response.ok) {
						uploaded.push({ local: item.local, path: target.path, nodeId: target.nodeId });
						process.stderr.write(`Uploaded ${target.path}\n`);
					} else {
						failed.push({ ...item, message: `Upload PUT failed: ${response.status} ${response.statusText}` });
						process.stderr.write(`Failed ${target.path}\n`);
					}
				}
			}),
		);
	}

	// An accepted upload is not ready yet. The server confirms it later, and files/list then shows status "ready".
	console.log(JSON.stringify({ uploaded, failed }, null, 2));
	return failed.length > 0 ? 1 : 0;
}
// #endregion commands

const [command, ...rest] = process.argv.slice(2);
const commands = {
	login: command_login,
	status: command_status,
	logout: command_logout,
	call: command_call,
	upload: command_upload,
};

try {
	if (!commands[command]) throw new UsageError(USAGE);
	process.exitCode = (await commands[command](rest)) ?? 0;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = error instanceof UsageError ? 2 : error instanceof NoKeyError ? 4 : 1;
}
