import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

const cliPath = fileURLToPath(new URL("../../../.agents/skills/press-api/scripts/api.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scratchRoot = path.resolve(
	repoRoot,
	"..",
	`${path.basename(repoRoot)}-+personal`,
	"+ai",
	`press-api-download-tests-${new Date().toISOString().slice(0, 10)}`,
);
const apiKey = "pk_download_test_secret";
const signature = "private-test-signature";

function row(name: string, kind: "file" | "folder" = "file", locked = false) {
	return {
		path: `/notes/${name}`,
		name: path.posix.basename(name),
		kind,
		nodeId: name,
		locked,
		status: kind === "file" && !locked ? "ready" : null,
		contentType: kind === "file" ? "application/octet-stream" : null,
		readOnly: locked ? null : false,
		size: null,
		updatedAt: 100,
	};
}

function json(response: ServerResponse, body: unknown, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function listen(answer: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
	const server = createServer((request, response) => {
		void answer(request, response).catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Body = { fileNodeIds?: string[]; cursor?: string | null; path?: string; paths?: string[]; recursive?: boolean };

async function fixture(items: ReturnType<typeof row>[]) {
	mkdirSync(scratchRoot, { recursive: true });
	const folder = mkdtempSync(path.join(scratchRoot, "folder-"));
	onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
	const target = path.join(folder, "copy");
	const calls: { route: string; body: Body; bearer?: string }[] = [];
	const gets: { id: string; bearer?: string; cookie?: string }[] = [];
	const remote = {
		key: {
			organizationId: "o1",
			organizationName: "studio",
			workspaceId: "w1",
			workspaceName: "design",
			sponsorUserId: "u1",
			serviceAccountId: null as string | null,
			scopes: ["files:list", "files:download"],
		},
		root: { ...row("notes", "folder"), path: "/notes" },
		items,
		api: undefined as ((route: string, body: Body, response: ServerResponse) => boolean) | undefined,
		storage: undefined as ((id: string, response: ServerResponse) => void) | undefined,
	};
	const storage = await listen(async (request, response) => {
		const url = new URL(request.url!, "http://127.0.0.1");
		const id = decodeURIComponent(url.pathname.slice(1));
		gets.push({ id, bearer: request.headers.authorization, cookie: request.headers.cookie });
		if (url.searchParams.get("signature") !== signature) {
			response.writeHead(403).end();
			return;
		}
		if (remote.storage) remote.storage(id, response);
		else response.end(`bytes of ${id}`);
	});
	const signed = (id: string) => ({
		fileNodeId: id,
		name: path.posix.basename(id),
		contentType: "application/octet-stream",
		expiresAt: Date.now() + 900_000,
		url: `${storage}/${encodeURIComponent(id)}?signature=${signature}`,
	});
	const api = await listen(async (request, response) => {
		let text = "";
		for await (const chunk of request) text += chunk;
		const body: Body = text ? JSON.parse(text) : {};
		const route = request.url!.slice("/api/v1/".length);
		calls.push({ route, body, bearer: request.headers.authorization });
		if (remote.api?.(route, body, response)) return;
		if (route === "auth/verify") json(response, remote.key);
		else if (route === "files/stat")
			json(response, { items: [{ path: "/notes", item: remote.root, status: "found" }] });
		else if (route === "files/list") json(response, { items: remote.items, isDone: true, cursor: null });
		else if (route === "files/download-urls")
			json(response, { items: body.fileNodeIds!.map(signed).reverse(), errors: [], truncated: false });
		else json(response, { message: "Unknown route" }, 404);
	});

	function cli(args: string[], nodeArgs: string[] = [], destination = target) {
		const child = spawn(process.execPath, [...nodeArgs, cliPath, ...args, "--to", destination], {
			env: { ...process.env, T3_API_ORIGIN: api, T3_API_KEY: apiKey },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (part) => (stdout += part));
		child.stderr.setEncoding("utf8").on("data", (part) => (stderr += part));
		const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr });
			});
		});
		return { child, result };
	}
	const start = () => cli(["download", "/notes"]).result;
	const resume = () => cli(["download", "/notes", "--resume"]).result;
	return { folder, target, remote, calls, gets, signed, cli, start, resume };
}

describe("download", () => {
	test("follows an empty intermediate page, copies bytes by ID and keeps empty folders", async () => {
		const f = await fixture([row("zero"), row("binary"), row("empty", "folder")]);
		f.remote.api = (route, body, response) => {
			if (route !== "files/list" || body.cursor) return false;
			json(response, { items: [], isDone: false, cursor: "next" });
			return true;
		};
		f.remote.storage = (id, res) => res.end(id === "zero" ? Buffer.alloc(0) : Buffer.from([0, 255, 13, 10]));
		const result = await f.start();
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "complete", filesSeen: 2, saved: 2 });
		expect(f.calls.filter((call) => call.route === "files/list").map((call) => call.body.cursor)).toEqual([
			null,
			"next",
		]);
		expect(f.calls.every((call) => call.bearer === `Bearer ${apiKey}`)).toBe(true);
		expect(f.gets.map((get) => get.id).sort()).toEqual(["binary", "zero"]);
		expect(f.gets.every((get) => !get.bearer && !get.cookie)).toBe(true);
		expect(readFileSync(path.join(f.target, "zero"))).toEqual(Buffer.alloc(0));
		expect(readFileSync(path.join(f.target, "binary"))).toEqual(Buffer.from([0, 255, 13, 10]));
		expect(readdirSync(path.join(f.target, "empty"))).toEqual([]);
	});

	test("reports a named locked folder and a signing refusal while saving a sibling", async () => {
		const f = await fixture([row("locked", "folder", true), row("revoked"), row("allowed")]);
		f.remote.api = (route, body, response) => {
			if (route !== "files/download-urls") return false;
			json(response, {
				items: body.fileNodeIds!.filter((id) => id !== "revoked").map(f.signed),
				errors: [{ fileNodeId: "revoked", message: "Permission denied", errorCode: "permission_denied" }],
				truncated: false,
			});
			return true;
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report).toMatchObject({ status: "partial", saved: 1, denied: 2 });
		const attempts = readFileSync(report.errors, "utf8");
		expect(attempts).toContain("/notes/locked");
		expect(attempts).toContain("/notes/revoked");
		expect(f.gets.map((get) => get.id)).toEqual(["allowed"]);
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).not.toContain("locked");
		expect(readdirSync(f.target)).toEqual(["allowed"]);
	});

	test("keeps the error history after rate limiting and a failed storage attempt", async () => {
		const f = await fixture([row("retry")]);
		let limited = false;
		f.remote.api = (route, _body, response) => {
			if (route !== "files/download-urls" || limited) return false;
			limited = true;
			json(response, { errorCode: "rate_limited", message: "Wait", retryAfterMs: 1 }, 429);
			return true;
		};
		f.remote.storage = (_id, response) => {
			if (f.gets.length === 1) response.writeHead(503).end(`trace ${signature} ${apiKey}`);
			else response.end("complete");
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report).toMatchObject({ status: "complete", saved: 1, failed: 0 });
		const attempts = readFileSync(report.errors, "utf8");
		expect(attempts).toContain("503");
		expect(attempts).toContain("/notes/retry");
		expect(readFileSync(path.join(f.target, "retry"), "utf8")).toBe("complete");
		const state = path.dirname(report.errors);
		const persisted = readdirSync(state, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
		for (const text of [result.stdout, result.stderr, ...persisted]) {
			expect(text).not.toContain(apiKey);
			expect(text).not.toContain(signature);
		}
	});

	test("checks the user, service account, workspace, root and scopes again before resuming", async () => {
		const f = await fixture([row("ok")]);
		const first = await f.start();
		expect(first.code, first.stderr).toBe(0);
		const oldKey = { ...f.remote.key };
		for (const change of [
			{ organizationId: "another-org" },
			{ workspaceId: "another-space" },
			{ sponsorUserId: "another-user" },
			{ serviceAccountId: "service" },
			{ scopes: ["files:read", "files:list"] },
		]) {
			f.remote.key = { ...oldKey, ...change };
			const refused = await f.resume();
			expect(refused.code, JSON.stringify(change)).toBe(1);
		}
		f.remote.key = oldKey;
		f.remote.root.nodeId = "replacement";
		expect((await f.resume()).code).toBe(1);
		expect(f.gets).toHaveLength(1);
		expect(readFileSync(path.join(f.target, "ok"), "utf8")).toBe("bytes of ok");
	});

	test("recognizes the same destination with a different case on a case-insensitive volume", async (context) => {
		const f = await fixture([row("ok")]);
		expect((await f.start()).code).toBe(0);
		const upper = path.join(f.folder, "COPY");
		context.skip(!existsSync(upper), "The destination volume distinguishes uppercase and lowercase names.");
		f.calls.length = 0;
		const result = await f.cli(["download", "/notes", "--resume"], [], upper).result;
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "complete", verified: 1, saved: 0 });
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).toEqual([]);
	});

	test("rounds a fractional rate-limit wait up to the next millisecond", async () => {
		const f = await fixture([row("retry")]);
		let limited = false;
		f.remote.api = (route, _body, response) => {
			if (route !== "files/download-urls" || limited) return false;
			limited = true;
			json(response, { errorCode: "rate_limited", message: "Wait", retryAfterMs: 987.4 }, 429);
			return true;
		};
		const clock = `
			import timers from 'node:timers/promises';
			import { syncBuiltinESMExports } from 'node:module';
			timers.setTimeout = async (ms) => { process.stderr.write('wait=' + ms + '\\n'); };
			syncBuiltinESMExports();
		`;
		const result = await f.cli(
			["download", "/notes"],
			["--import", `data:text/javascript,${encodeURIComponent(clock)}`],
		).result;
		expect(result.stderr.split(/\r?\n/u)).toContain("wait=988");
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "complete", saved: 1 });
	});

	test("rechecks a refused batch and saves its readable files", async () => {
		const f = await fixture([row("lost-access"), row("still-open")]);
		f.remote.api = (route, body, response) => {
			if (route !== "files/download-urls" || !body.fileNodeIds?.includes("lost-access")) return false;
			if (body.fileNodeIds.length > 1)
				json(response, { errorCode: "permission_denied", message: "Permission denied" }, 403);
			else
				json(response, {
					items: [],
					errors: [{ fileNodeId: "lost-access", errorCode: "permission_denied", message: "Permission denied" }],
					truncated: false,
				});
			return true;
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", denied: 1, saved: 1 });
		expect(f.gets.map((get) => get.id)).toEqual(["still-open"]);
		expect(f.calls.filter((call) => call.route === "auth/verify").length).toBeGreaterThan(1);
	});

	test("does not report success when a signing answer drops a requested ID", async () => {
		const f = await fixture([row("dropped")]);
		f.remote.api = (route, _body, response) => {
			if (route !== "files/download-urls") return false;
			json(response, { items: [], errors: [], truncated: true });
			return true;
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(1);
		expect(f.gets).toHaveLength(0);
		expect(existsSync(path.join(f.target, "dropped"))).toBe(false);
	});

	test("renews an expired link and waits for a pending file on a later resume", async () => {
		const f = await fixture([row("available"), { ...row("upload"), status: "pending" }]);
		let expired = true;
		f.remote.api = (route, body, response) => {
			if (route !== "files/download-urls" || !expired) return false;
			expired = false;
			json(response, {
				items: body.fileNodeIds!.map((id) => ({ ...f.signed(id), expiresAt: 1 })),
				errors: [],
				truncated: false,
			});
			return true;
		};
		const partial = await f.start();
		expect(partial.code, partial.stderr).toBe(1);
		expect(JSON.parse(partial.stdout)).toMatchObject({ saved: 1, failed: 1, retries: 1 });
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).toEqual(["available", "available"]);
		expect(f.gets.map((get) => get.id)).toEqual(["available"]);
		f.remote.items = [row("available"), row("upload")];
		const resumed = await f.resume();
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "complete", saved: 1, verified: 1 });
		expect(f.gets.map((get) => get.id)).toEqual(["available", "upload"]);
	});

	test("checks the workspace root through list and stops before writing a denied source", async () => {
		const f = await fixture([]);
		f.remote.api = (route, _body, response) => {
			if (route !== "files/list") return false;
			json(response, { errorCode: "permission_denied", message: "Permission denied" }, 403);
			return true;
		};
		const result = await f.cli(["download", "/"]).result;
		expect(result.code, result.stderr).toBe(1);
		expect(f.calls.map((call) => call.route)).toEqual(["auth/verify", "files/list"]);
		expect(existsSync(f.target)).toBe(false);
		expect(f.gets).toHaveLength(0);
	});

	test("reports a changed timestamp and a disappeared entry on resume and keeps their local bytes", async () => {
		const f = await fixture([row("changed"), row("gone")]);
		expect((await f.start()).code).toBe(0);
		f.remote.items = [{ ...row("changed"), updatedAt: 200 }];
		f.calls.length = 0;
		const result = await f.resume();
		expect(result.code, result.stderr).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ conflicts: 2 });
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).toEqual([]);
		expect(readFileSync(path.join(f.target, "changed"), "utf8")).toBe("bytes of changed");
		expect(readFileSync(path.join(f.target, "gone"), "utf8")).toBe("bytes of gone");
	});

	test("keeps downloaded files and observed failures when continuation becomes unsafe", async () => {
		const f = await fixture([row("first"), row("second")]);
		let invalidated = false;
		f.remote.api = (route, body, response) => {
			if (route !== "files/list" || invalidated) return false;
			if (body.cursor === "moved") {
				invalidated = true;
				json(response, { errorCode: "invalid_cursor", message: "List again" }, 400);
			} else
				json(response, { items: [row("first"), { ...row("locked"), locked: true }], isDone: false, cursor: "moved" });
			return true;
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", filesSeen: 2, saved: 1, denied: 1 });
		expect(f.calls.filter((call) => call.route === "files/list").map((call) => call.body.cursor)).toEqual([
			null,
			"moved",
		]);
		const attempts = readFileSync(JSON.parse(result.stdout).errors, "utf8").trim().split("\n");
		expect(attempts.map((line) => JSON.parse(line))).toContainEqual(
			expect.objectContaining({ stage: "files/list", code: "invalid_cursor", retry: false }),
		);
		expect(readFileSync(path.join(f.target, "first"), "utf8")).toBe("bytes of first");
		expect(f.gets.map((get) => get.id)).toEqual(["first"]);
	});

	test("reports an invalid first page without a second scan", async () => {
		const f = await fixture([row("retry")]);
		let invalidated = false;
		f.remote.api = (route, _body, response) => {
			if (route !== "files/list" || invalidated) return false;
			invalidated = true;
			json(response, { errorCode: "invalid_cursor", message: "List again" }, 400);
			return true;
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(1);
		expect(f.calls.filter((call) => call.route === "files/list").map((call) => call.body.cursor)).toEqual([null]);
		expect(JSON.parse(result.stdout)).not.toHaveProperty("pathsChecked");
		expect(f.gets).toEqual([]);
	});

	test("retries a busy listing with the same cursor and records the reason", async () => {
		const f = await fixture([row("first"), row("second")]);
		let busy = true;
		f.remote.api = (route, body, response) => {
			if (route !== "files/list") return false;
			if (body.cursor === null) {
				json(response, { items: [row("first")], isDone: false, cursor: "next" });
			} else if (busy) {
				busy = false;
				json(response, { errorCode: "listing_busy", retryAfterMs: 0 }, 503);
			} else {
				json(response, { items: [row("second")], isDone: true, cursor: null });
			}
			return true;
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ saved: 2, retries: 1 });
		expect(f.calls.filter((call) => call.route === "files/list").map((call) => call.body.cursor)).toEqual([
			null,
			"next",
			"next",
		]);
		const attempts = readFileSync(JSON.parse(result.stdout).errors, "utf8").trim().split("\n");
		expect(attempts.map((line) => JSON.parse(line))).toContainEqual(
			expect.objectContaining({ stage: "files/list", code: "listing_busy", retry: true }),
		);
	});

	test("stops when a new folder replaces the source between stat and the first page", async () => {
		const f = await fixture([row("replacement-file")]);
		f.remote.api = (route) => {
			if (route === "files/list") f.remote.root.nodeId = "replacement";
			return false;
		};
		const result = await f.start();
		expect(f.gets).toHaveLength(0);
		expect(existsSync(path.join(f.target, "replacement-file"))).toBe(false);
		expect(result.code, result.stderr).toBe(1);
	});

	test("prints the run error even when a full disk prevents saving the error log", async () => {
		const f = await fixture([row("never-saved")]);
		// The manifest fits. Once progress starts, both the progress write and the error log hit ENOSPC.
		const noSpace = `
			import fs from 'node:fs';
			const full = () => { throw Object.assign(new Error('full disk'), { code: 'ENOSPC' }); };
			const write = fs.writeFileSync.bind(fs);
			fs.writeFileSync = (file, ...args) => String(file).includes('progress.json') ? full() : write(file, ...args);
			const append = fs.appendFileSync.bind(fs);
			fs.appendFileSync = (file, ...args) => String(file).endsWith('errors.jsonl') ? full() : append(file, ...args);
		`;
		const result = await f.cli(
			["download", "/notes"],
			["--import", `data:text/javascript,${encodeURIComponent(noSpace)}`],
		).result;
		expect(result.stdout, result.stderr).toContain('"runError"');
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", runError: { code: "ENOSPC" } });
		expect(result.code, result.stderr).toBe(1);
		expect(f.gets).toHaveLength(0);
	});

	test("prints the original storage error when appending its error log fails", async () => {
		const f = await fixture([row("refused")]);
		f.remote.storage = (_id, response) => response.writeHead(503).end();
		const failAppend = `
			import fs from 'node:fs';
			const append = fs.appendFileSync.bind(fs);
			fs.appendFileSync = (file, ...args) => {
				if (String(file).endsWith('errors.jsonl')) throw Object.assign(new Error('full disk'), { code: 'ENOSPC' });
				return append(file, ...args);
			};
		`;
		const result = await f.cli(
			["download", "/notes"],
			["--import", `data:text/javascript,${encodeURIComponent(failAppend)}`],
		).result;
		const entries = result.stderr.split("\n").filter((line) => line.startsWith("{"));
		expect(entries.map((line) => JSON.parse(line))).toContainEqual(
			expect.objectContaining({ path: "/notes/refused", stage: "storage GET", status: 503 }),
		);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", runError: { code: "ENOSPC" } });
		expect(result.code, result.stderr).toBe(1);
	});

	test("checks previous paths on resume and reports a file that disappeared", async () => {
		const f = await fixture([row("kept"), row("removed")]);
		const first = await f.start();
		expect(JSON.parse(first.stdout)).not.toHaveProperty("pathsChecked");
		f.remote.items = [row("kept")];
		f.gets.length = 0;
		const resumed = await f.resume();
		expect(resumed.code, resumed.stderr).toBe(1);
		expect(resumed.stderr).toContain("Checking previous paths");
		expect(JSON.parse(resumed.stdout)).toMatchObject({ pathsChecked: 2, conflicts: 1, verified: 1 });
		expect(readFileSync(path.join(f.target, "removed"), "utf8")).toBe("bytes of removed");
		expect(f.gets).toHaveLength(0);
	});

	test("refuses to replace a deleted local copy with a newer version from the server", async () => {
		const f = await fixture([row("changed")]);
		expect((await f.start()).code).toBe(0);
		unlinkSync(path.join(f.target, "changed"));
		f.remote.items = [{ ...row("changed"), updatedAt: 200 }];
		f.gets.length = 0;
		const result = await f.resume();
		expect(f.gets).toHaveLength(0);
		expect(existsSync(path.join(f.target, "changed"))).toBe(false);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", conflicts: 1 });
		expect(result.code, result.stderr).toBe(1);
	});

	test("recovers after the storage connection drops in the middle of a binary file", async () => {
		const f = await fixture([row("lost")]);
		f.remote.storage = (_id, response) => {
			if (f.gets.length === 1) {
				response.writeHead(200, { "content-length": "1000" });
				response.write("partial", () => response.socket?.destroy());
			} else response.end(Buffer.from([0, 255, 13]));
		};
		const result = await f.start();
		expect(result.code, result.stderr).toBe(0);
		expect(f.gets).toHaveLength(2);
		const attempts = readFileSync(JSON.parse(result.stdout).errors, "utf8");
		expect(attempts).toContain("/notes/lost");
		expect(readFileSync(path.join(f.target, "lost"))).toEqual(Buffer.from([0, 255, 13]));
	});

	test("preserves a local edit, an existing file and a replaced source, and redownloads a missing output", async () => {
		const f = await fixture([row("edit"), row("replace"), row("gone"), row("intact")]);
		expect((await f.start()).code).toBe(0);
		writeFileSync(path.join(f.target, "edit"), "my changes");
		writeFileSync(path.join(f.target, "existing"), "personal file");
		unlinkSync(path.join(f.target, "gone"));
		f.remote.items = [row("edit"), { ...row("replace"), nodeId: "new" }, row("gone"), row("intact"), row("existing")];
		f.calls.length = 0;
		const result = await f.resume();
		expect(result.code, result.stderr).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", saved: 1, verified: 1, conflicts: 3 });
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).toEqual(["gone"]);
		expect(readFileSync(path.join(f.target, "edit"), "utf8")).toBe("my changes");
		expect(readFileSync(path.join(f.target, "existing"), "utf8")).toBe("personal file");
		expect(readFileSync(path.join(f.target, "replace"), "utf8")).toBe("bytes of replace");
		expect(readFileSync(path.join(f.target, "gone"), "utf8")).toBe("bytes of gone");
	});

	test("never writes through a directory junction or an escaping path", async () => {
		const f = await fixture([row("link/escaped"), row("../escape"), row("good")]);
		const other = path.join(f.folder, "elsewhere");
		mkdirSync(other);
		mkdirSync(f.target);
		symlinkSync(other, path.join(f.target, "link"), process.platform === "win32" ? "junction" : "dir");
		const result = await f.start();
		expect(result.code, result.stderr).toBe(1);
		expect(existsSync(path.join(f.folder, "escape"))).toBe(false);
		expect(readdirSync(other)).toEqual([]);
		expect(readFileSync(path.join(f.target, "good"), "utf8")).toBe("bytes of good");
	});

	test("keeps a competing file created between listing and publication", async () => {
		const f = await fixture([row("race")]);
		f.remote.storage = (_id, response) => {
			writeFileSync(path.join(f.target, "race"), "created by another program", { flag: "wx" });
			response.end("downloaded copy");
		};
		const result = await f.start();
		expect(readFileSync(path.join(f.target, "race"), "utf8")).toBe("created by another program");
		expect(result.code, result.stderr).toBe(1);
		expect(f.gets).toHaveLength(1);
	});

	test("recovers a file installed just before a hard kill without requesting a new link", async () => {
		const f = await fixture([row("published")]);
		const target = path.join(f.target, "published");
		// Kill the real writer after the successful filesystem call, before it can mark the receipt complete.
		const stopAfterLink = `
			import fs from 'node:fs';
			import { syncBuiltinESMExports } from 'node:module';
			const kill = (to) => { if (to === ${JSON.stringify(target)}) process.kill(process.pid, 'SIGKILL'); };
			const link = fs.promises.link.bind(fs.promises);
			const linkSync = fs.linkSync.bind(fs);
			fs.promises.link = async (from, to) => { await link(from, to); kill(to); };
			fs.linkSync = (from, to) => { linkSync(from, to); kill(to); };
			syncBuiltinESMExports();
		`;
		const stopped = await f.cli(
			["download", "/notes"],
			["--import", `data:text/javascript,${encodeURIComponent(stopAfterLink)}`],
		).result;
		expect(stopped.code, stopped.stderr).not.toBe(0);
		expect(readFileSync(target, "utf8")).toBe("bytes of published");
		f.calls.length = 0;
		const resumed = await f.resume();
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("bytes of published");
	});

	test("can show status and resume after a hard kill during a storage GET", async () => {
		const f = await fixture([row("first"), row("partial")]);
		let held = false;
		f.remote.storage = (id, response) => {
			if (id === "first") response.end("kept bytes");
			else {
				held = true;
				response.writeHead(200, { "content-length": "2048" });
				response.write(Buffer.alloc(128));
			}
		};
		const active = f.cli(["download", "/notes"]);
		try {
			await expect.poll(() => held && existsSync(path.join(f.target, "first")), { timeout: 5000 }).toBe(true);
			expect(existsSync(path.join(f.target, "partial"))).toBe(false);
			const status = await f.cli(["download-status"]).result;
			expect(status.code, status.stderr).toBe(0);
			expect(JSON.parse(status.stdout)).toMatchObject({ status: "running" });
			const second = await f.resume();
			expect(second.code, second.stderr).toBe(1);
			expect(f.gets).toHaveLength(2);
		} finally {
			active.child.kill("SIGKILL");
			await active.result;
		}
		const stopped = await f.cli(["download-status"]).result;
		expect(stopped.code, stopped.stderr).toBe(0);
		expect(JSON.parse(stopped.stdout)).toMatchObject({ status: "interrupted" });
		f.remote.storage = (_id, response) => response.end("whole file");
		f.calls.length = 0;
		const resumed = await f.resume();
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(JSON.parse(resumed.stdout)).toMatchObject({ saved: 1, verified: 1 });
		expect(f.calls.flatMap((call) => call.body.fileNodeIds ?? [])).toEqual(["partial"]);
		expect(readFileSync(path.join(f.target, "partial"), "utf8")).toBe("whole file");
		expect(readFileSync(path.join(f.target, "first"), "utf8")).toBe("kept bytes");
	});
});
