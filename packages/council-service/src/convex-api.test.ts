import { afterEach, describe, expect, test } from "vitest";

import {
	council_convex_data_write_versioned,
	council_convex_exchange,
	council_convex_seal_processing,
	council_convex_uploads_create_target,
	council_convex_uploads_archive_destination,
	council_convex_uploads_finalize,
	council_convex_uploads_release,
	council_convex_uploads_reserve,
	council_convex_verify_live,
} from "./convex-api.ts";
import { install_fetch, make_test_env } from "../test/env.ts";

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

describe("council_convex_exchange", () => {
	test("sends both credentials and parses the grant facts", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const exchanged = await council_convex_exchange(env, "plu_page_token");
		expect(exchanged._nay).toBeUndefined();
		expect(exchanged._yay?.token).toBe("psg_interactive_test_token");
		expect(exchanged._yay?.actorUserId).toBe("user-1");

		const call = mock.calls[0];
		expect(call.url).toBe("https://convex.example/api/internal/plugins/service-grants/exchange");
		expect(call.headers.get("Authorization")).toBe("Bearer plu_page_token");
		expect(call.headers.get("X-Bonobo-Service-Authorization")).toBe("Bearer test-exchange-secret");
		expect(call.bodyJson).toEqual({});
	});

	test("a refused exchange maps the status class into _nay.name", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/service-grants/exchange": () => Response.json({ message: "Unauthorized" }, { status: 401 }),
		});
		restoreFetch = mock.restore;

		const exchanged = await council_convex_exchange(env, "plu_page_token");
		expect(exchanged._nay?.name).toBe("unauthorized");
	});
});

describe("council_convex_verify_live", () => {
	test("sends the exact claims and treats a 409 as a conflict, never a success", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/service-grants/verify-live": () => Response.json({ message: "This grant is in another phase" }, { status: 409 }),
		});
		restoreFetch = mock.restore;

		const live = await council_convex_verify_live(env, "psg_token", {
			installationId: "inst-1",
			phase: "interactive",
			destinationPathPrefix: null,
			scopes: ["plugin_data:read", "plugin_data:write"],
		});
		expect(live._nay?.name).toBe("conflict");

		expect(mock.calls[0].bodyJson).toEqual({
			installationId: "inst-1",
			phase: "interactive",
			destinationPathPrefix: null,
			scopes: ["plugin_data:read", "plugin_data:write"],
		});
	});
});

describe("council_convex_seal_processing", () => {
	test("presents the interactive grant and carries the destination prefix", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const sealed = await council_convex_seal_processing(env, "psg_interactive", {
			destinationPathPrefix: "/meetings/meeting-1",
		});
		expect(sealed._yay?.scopes).toContain("files:write");

		const call = mock.calls[0];
		expect(call.headers.get("Authorization")).toBe("Bearer psg_interactive");
		expect(call.headers.get("X-Bonobo-Service-Authorization")).toBe("Bearer test-exchange-secret");
		expect(call.bodyJson).toEqual({ destinationPathPrefix: "/meetings/meeting-1" });
	});
});

describe("council_convex_data_write_versioned", () => {
	test("is a public-API call: bearer only, no service secret", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const written = await council_convex_data_write_versioned(env, "psg_token", {
			collection: "meetings",
			key: "meeting-1",
			revision: 3,
			value: { status: "open" },
		});
		expect(written._yay?.revision).toBe(3);

		const call = mock.calls[0];
		expect(call.url).toBe("https://convex.example/api/v1/plugin-data/write-versioned");
		expect(call.headers.get("Authorization")).toBe("Bearer psg_token");
		expect(call.headers.get("X-Bonobo-Service-Authorization")).toBeNull();
		expect(call.bodyJson).toEqual({ collection: "meetings", key: "meeting-1", revision: 3, value: { status: "open" } });
	});
});

describe("council_convex_uploads_reserve", () => {
	test("is bearer-only and surfaces a full workspace as its own refusal", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const reserved = await council_convex_uploads_reserve(env, "psg_processing", {
			idempotencyKey: "council-uploads-meeting-1",
			reservedBytes: 557842432,
			expiresAt: 1000,
		});
		expect(reserved._yay?.reservationId).toBe("res-up-1");

		const call = mock.calls[0];
		expect(call.url).toBe("https://convex.example/api/v1/files/service-uploads/reserve");
		expect(call.headers.get("X-Bonobo-Service-Authorization")).toBeNull();
		expect(call.bodyJson).toEqual({ idempotencyKey: "council-uploads-meeting-1", reservedBytes: 557842432, expiresAt: 1000 });

		mock.restore();
		const fullMock = install_fetch({
			"/service-uploads/reserve": () =>
				Response.json({ message: "This workspace has used its plugin service storage" }, { status: 403 }),
		});
		restoreFetch = fullMock.restore;
		const refused = await council_convex_uploads_reserve(env, "psg_processing", {
			idempotencyKey: "council-uploads-meeting-1",
			reservedBytes: 557842432,
			expiresAt: 1000,
		});
		expect(refused._nay?.name).toBe("storage_full");
	});
});

describe("council_convex_uploads_create_target", () => {
	test("parses the pending and committed halves of the target union", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		// The key names the meeting's one reservation — the host resolves the reservation by it.
		const body = {
			idempotencyKey: "council-uploads-meeting-1",
			targetKey: "transcript_markdown:transcript.md",
			path: "/meetings/meeting-1/transcript.md",
			contentType: "text/markdown",
			size: 10,
		};
		const pending = await council_convex_uploads_create_target(env, "psg_processing", body);
		expect(pending._yay?.state).toBe("pending");
		if (pending._yay?.state === "pending") {
			expect(pending._yay.headers).toEqual({ "Content-Type": "text/markdown" });
		}

		mock.restore();
		const committedMock = install_fetch({
			"/service-uploads/create-target": () =>
				Response.json({ state: "committed", path: "/meetings/meeting-1/transcript.md", nodeId: "node-1", actualBytes: 10 }),
		});
		restoreFetch = committedMock.restore;
		const committed = await council_convex_uploads_create_target(env, "psg_processing", body);
		expect(committed._yay).toEqual({ state: "committed", nodeId: "node-1", actualBytes: 10 });
	});
});

describe("council_convex_uploads_finalize", () => {
	test("a pending settle has no upload URL and still parses", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/service-uploads/finalize": () =>
				Response.json({ state: "pending", path: "/meetings/meeting-1/transcript.md", nodeId: "node-1", actualBytes: null }),
		});
		restoreFetch = mock.restore;

		const settled = await council_convex_uploads_finalize(env, "psg_processing", {
			idempotencyKey: "fin-1",
			targetKey: "transcript_markdown:transcript.md",
		});
		expect(settled._yay?.state).toBe("pending");
	});
});

describe("council_convex_uploads_release", () => {
	test("an already-released reservation answers success, not a wedge", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/service-uploads/release": () => Response.json({ message: "Reservation already released" }, { status: 409 }),
		});
		restoreFetch = mock.restore;

		const released = await council_convex_uploads_release(env, "psg_processing", { idempotencyKey: "council-uploads-meeting-1" });
		expect(released._yay?.releasedBytes).toBe(0);
	});
});

describe("council_convex_uploads_archive_destination", () => {
	test("sends no path, because the grant's seal names the folder", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const archived = await council_convex_uploads_archive_destination(env, "psg_processing");
		expect(archived._yay?.archivedNodes).toBe(2);

		const call = mock.calls.find((entry) => entry.url.includes("/service-uploads/archive-destination"));
		expect(call?.bodyJson).toEqual({});
		expect(call?.headers.get("Authorization")).toBe("Bearer psg_processing");
	});
});
