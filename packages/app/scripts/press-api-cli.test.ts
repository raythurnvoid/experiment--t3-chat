import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../../../.agents/skills/press-api/scripts/api.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scratchRoot = path.resolve(
	repoRoot,
	"..",
	`${path.basename(repoRoot)}-+personal`,
	"+ai",
	`press-api-cli-tests-${new Date().toISOString().slice(0, 10)}`,
);

/**
 * Make an empty folder for local files, outside the repo.
 */
function make_fixture_folder() {
	mkdirSync(scratchRoot, { recursive: true });
	return mkdtempSync(path.join(scratchRoot, "fixture-"));
}

type ApiRequest = { route: string; body: Record<string, unknown> };

/**
 * Start a fake API on a free local port. `answer` writes the response to each request.
 */
async function start_api(answer: (request: ApiRequest, response: ServerResponse) => void | Promise<void>) {
	const requests: ApiRequest[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((incoming, response) => {
		let text = "";
		incoming.setEncoding("utf8");
		incoming.on("data", (chunk: string) => (text += chunk));
		incoming.on("end", () => {
			const request = { route: incoming.url ?? "", body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
			requests.push(request);
			Promise.resolve(answer(request, response)).catch(() => response.destroy());
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: () => {
			for (const socket of sockets) socket.destroy();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * Run the CLI against the fake API and wait until it ends.
 */
function run_cli(origin: string, args: string[], options: { onStdout?: (child: ChildProcess) => void } = {}) {
	return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			env: { ...process.env, T3_API_KEY: "pk_test", T3_API_ORIGIN: origin },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			options.onStdout?.(child);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", reject);

		// A broken CLI can wait forever for a page the fake API never sends. Stop it before the Vitest
		// timeout, so the test still reaches its finally block and closes the server.
		let timedOut = false;
		const deadline = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 4000);
		child.on("close", (code) => {
			clearTimeout(deadline);
			if (timedOut) reject(new Error(`The CLI did not end within 4 seconds: ${args.join(" ")}`));
			else resolve({ code, stdout: Buffer.concat(stdout), stderr });
		});
	});
}

// The UTF-8 bytes of "é" (c3 a9) are split between the two pages, next to bytes that are not text.
const PAGE_1 = Buffer.from([0x00, 0xff, 0x63, 0x61, 0x66, 0xc3]);
const PAGE_2 = Buffer.from([0xa9, 0x0d, 0x0a]);
const FACTS = {
	path: "/notes/a.bin",
	contentType: "application/octet-stream",
	revision: "r1",
	size: PAGE_1.length + PAGE_2.length,
	isLatest: true,
};

function send_page(response: ServerResponse, bytes: Buffer, nextCursor: string | null) {
	response.writeHead(200, {
		"content-type": "application/octet-stream",
		"x-file-content-type": FACTS.contentType,
		"x-file-revision": FACTS.revision,
		"x-file-size": String(FACTS.size),
		"x-file-is-latest": "true",
		...(nextCursor ? { "x-file-next-cursor": nextCursor } : {}),
	});
	response.end(bytes);
}

describe("read", () => {
	test("follows every page to stdout, and to --to over an existing file", async () => {
		const api = await start_api((request, response) =>
			request.body.cursor === null ? send_page(response, PAGE_1, "c1") : send_page(response, PAGE_2, null),
		);
		const folder = make_fixture_folder();
		try {
			const raw = await run_cli(api.origin, ["read", FACTS.path]);
			expect(raw.code, raw.stderr).toBe(0);
			expect(raw.stdout.equals(Buffer.concat([PAGE_1, PAGE_2]))).toBe(true);
			expect(JSON.parse(raw.stderr)).toEqual(FACTS);
			expect(api.requests.map((request) => request.body)).toEqual([
				{ path: FACTS.path, cursor: null },
				{ path: FACTS.path, cursor: "c1" },
			]);

			const target = path.join(folder, "a.bin");
			writeFileSync(target, "old");
			const saved = await run_cli(api.origin, ["read", FACTS.path, "--to", target]);
			expect(saved.code, saved.stderr).toBe(0);
			expect(JSON.parse(saved.stdout.toString("utf8"))).toEqual(FACTS);
			expect(readFileSync(target).equals(Buffer.concat([PAGE_1, PAGE_2]))).toBe(true);
			expect(readdirSync(folder)).toEqual(["a.bin"]);
		} finally {
			await api.close();
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test("prints no facts, keeps the old --to file, and stops on a refused page, a lost answer, or a closed stdout", async () => {
		let pipeClosed: Promise<void> = Promise.resolve();
		let secondPage: "refused" | "lost" | "held" = "refused";
		const api = await start_api(async (request, response) => {
			if (request.body.cursor === null) return send_page(response, PAGE_1, "c1");
			if (request.body.cursor !== "c1") return send_page(response, PAGE_2, null);

			if (secondPage === "refused") {
				response.writeHead(409, { "content-type": "application/json" });
				response.end(JSON.stringify({ message: "The file changed.", errorCode: "file_changed" }));
			} else if (secondPage === "lost") {
				// Send the headers and part of the body, then drop the connection.
				response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100" });
				response.write(Buffer.alloc(10), () => response.socket?.destroy());
			} else {
				// Answer only after the reader closed stdout. A next cursor that the CLI must not follow comes with it.
				await pipeClosed;
				send_page(response, PAGE_2, "c2");
			}
		});
		const folder = make_fixture_folder();
		const target = path.join(folder, "a.bin");
		try {
			for (const [failure, exitCode] of [
				["refused", 1],
				["lost", 3],
			] as const) {
				secondPage = failure;

				const raw = await run_cli(api.origin, ["read", FACTS.path]);
				expect(raw.code, `${failure}: ${raw.stderr}`).toBe(exitCode);
				expect(raw.stdout.equals(PAGE_1), failure).toBe(true);
				expect(raw.stderr, failure).toContain("The output is incomplete. Discard it and run the command again.");
				expect(raw.stderr, failure).not.toContain('"revision"');

				writeFileSync(target, "old");
				const saved = await run_cli(api.origin, ["read", FACTS.path, "--to", target]);
				expect(saved.code, `${failure}: ${saved.stderr}`).toBe(exitCode);
				expect(saved.stdout.toString("utf8"), failure).toBe("");
				expect(readFileSync(target, "utf8"), failure).toBe("old");
				expect(readdirSync(folder), failure).toEqual(["a.bin"]);
			}

			secondPage = "held";
			let closePipe = () => {};
			pipeClosed = new Promise((resolve) => (closePipe = resolve));
			const requestCount = api.requests.length;
			const closed = await run_cli(api.origin, ["read", FACTS.path], {
				onStdout: (child) => {
					child.stdout?.once("close", closePipe);
					child.stdout?.destroy();
				},
			});
			expect(closed.code, closed.stderr).toBe(1);
			expect(closed.stderr).toContain("Cannot write to stdout");
			expect(closed.stderr).not.toMatch(/\n\s+at /u);
			expect(closed.stderr).not.toContain('"revision"');
			expect(api.requests.slice(requestCount).map((request) => request.body.cursor)).toEqual([null, "c1"]);
		} finally {
			await api.close();
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("write", () => {
	test("sends the local text unchanged, maps --if-revision, and refuses local mistakes without a request", async () => {
		const answer = {
			path: "/notes/a.md",
			nodeId: "n1",
			contentType: "text/markdown",
			revision: "r2",
			size: 15,
			contentChanged: true,
		};
		let errorCode: string | null = null;
		const api = await start_api((_request, response) => {
			response.writeHead(errorCode ? 409 : 200, { "content-type": "application/json" });
			response.end(JSON.stringify(errorCode ? { message: "Refused.", errorCode } : answer));
		});
		const folder = make_fixture_folder();
		try {
			const text = "\uFEFF# Café\r\nline\r\n";
			const local = path.join(folder, "a.md");
			writeFileSync(local, text, "utf8");
			const written = await run_cli(api.origin, ["write", "/notes/a.md", "--from", local, "--if-revision", "r1"]);
			expect(written.code, written.stderr).toBe(0);
			expect(api.requests).toEqual([
				{ route: "/api/v1/files/write", body: { path: "/notes/a.md", content: text, expectedRevision: "r1" } },
			]);
			expect(JSON.parse(written.stdout.toString("utf8"))).toEqual(answer);

			// Only a refusal that a new read can fix says to run the command again.
			for (const [code, advice] of [
				["file_busy", true],
				["file_needs_repair", false],
			] as const) {
				errorCode = code;
				const refused = await run_cli(api.origin, ["write", "/notes/a.md", "--from", local]);
				expect(refused.code, code).toBe(1);
				expect(refused.stderr.includes("Read the file and run the command again."), code).toBe(advice);
			}

			// A local mistake is a usage error, and the CLI sends nothing.
			const binary = path.join(folder, "a.bin");
			writeFileSync(binary, Buffer.from([0x41, 0xc3, 0x28]));
			const requestCount = api.requests.length;
			for (const [args, message] of [
				[["write", "/notes/a.md", "--from", binary], "Not valid UTF-8 text"],
				[["write", "/notes/a.md", "--from", path.join(folder, "gone.md")], "Local file not found"],
				[["read", "/notes/a.md", "--to", path.join(folder, "gone", "a.md")], "Local folder not found"],
			] as const) {
				const refused = await run_cli(api.origin, [...args]);
				expect(refused.code, refused.stderr).toBe(2);
				expect(refused.stderr).toContain(message);
			}
			expect(api.requests).toHaveLength(requestCount);
		} finally {
			await api.close();
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("stat", () => {
	test("--expect sets the status every path must have, and an API refusal prints no items", async () => {
		const statuses: Record<string, string> = { "/a": "found", "/b": "missing" };
		const api = await start_api((request, response) => {
			const paths = request.body.paths as string[];
			if (paths.includes("/x")) {
				response.writeHead(401, { "content-type": "application/json" });
				response.end(JSON.stringify({ message: "Unauthenticated" }));
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ items: paths.map((item) => ({ path: item, status: statuses[item] })) }));
		});
		try {
			for (const [args, exitCode] of [
				[["/b", "--expect", "missing"], 0],
				[["/a", "/b", "--expect", "missing"], 1],
			] as const) {
				const result = await run_cli(api.origin, ["stat", ...args]);
				expect(result.code, args.join(" ")).toBe(exitCode);
				expect(JSON.parse(result.stdout.toString("utf8")).items, args.join(" ")).toHaveLength(
					args.filter((arg) => arg.startsWith("/")).length,
				);
			}

			const requestCount = api.requests.length;
			const bad = await run_cli(api.origin, ["stat", "/a", "--expect", "gone"]);
			expect(bad.code, bad.stderr).toBe(2);
			expect(api.requests).toHaveLength(requestCount);

			const refused = await run_cli(api.origin, ["stat", "/x", "--expect", "missing"]);
			expect(refused.code, refused.stderr).toBe(1);
			expect(refused.stdout.toString("utf8")).toBe("");
		} finally {
			await api.close();
		}
	});
});

describe("restore", () => {
	test("sends nodes or a dry run, and exits 1 when a job leaves an item in the Trash", async () => {
		const api = await start_api((request, response) => {
			// Skip leaves an item in the Trash, and the job still succeeds.
			const skipped = { path: "/skip.md", message: "An item with this name is already there." };
			const jobRefused = (request.body.paths as string[] | undefined)?.includes("/skip.md") ? [skipped] : [];
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					request.route.endsWith("/files/jobs/get")
						? { jobId: "j1", status: "succeeded", refused: [skipped], renamed: [], refusedCursor: null }
						: request.body.dryRun
							? { dryRun: true, complete: true, refused: [], jobs: [{ status: "succeeded", refused: jobRefused }] }
							: { jobIds: jobRefused.length > 0 ? ["j1"] : [], isDone: true, refused: [] },
				),
			);
		});
		try {
			const byId = await run_cli(api.origin, ["restore", "--node", "n1:t1", "--node", "n2:t2", "--request-id", "r1"]);
			expect(byId.code, byId.stderr).toBe(0);
			const preview = await run_cli(api.origin, ["restore", "/a.md", "--dry-run", "--on-conflict", "skip"]);
			expect(preview.code, preview.stderr).toBe(0);
			expect(api.requests.map((request) => request.body)).toEqual([
				{
					nodes: [
						{ nodeId: "n1", archiveOperationId: "t1" },
						{ nodeId: "n2", archiveOperationId: "t2" },
					],
					requestId: "r1",
				},
				{ paths: ["/a.md"], onConflict: "skip", dryRun: true },
			]);

			const skippedPreview = await run_cli(api.origin, ["restore", "/skip.md", "--dry-run"]);
			expect(skippedPreview.code, skippedPreview.stderr).toBe(1);
			const skipped = await run_cli(api.origin, ["restore", "/skip.md", "--wait", "--request-id", "r3"]);
			expect(skipped.code, skipped.stderr).toBe(1);

			for (const args of [
				["/a.md", "--dry-run", "--wait"],
				["/a.md", "--dry-run", "--request-id", "r2"],
				["/a.md", "--node", "n1:t1"],
				["--node", "n1"],
			]) {
				const refused = await run_cli(api.origin, ["restore", ...args]);
				expect(refused.code, args.join(" ")).toBe(2);
			}
			expect(api.requests).toHaveLength(5);
		} finally {
			await api.close();
		}
	});
});
