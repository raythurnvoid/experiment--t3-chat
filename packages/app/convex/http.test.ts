import { describe, expect, test } from "vitest";
import http from "./http.ts";

describe("http routes", () => {
	test("registers the full route inventory", () => {
		const routes = http.getRoutes().map(([path, method]) => `${method} ${path}`);

		expect(routes.sort()).toEqual(
			[
				"GET /.well-known/jwks.json",
				"OPTIONS /.well-known/jwks.json",
				"POST /api/auth/anonymous",
				"OPTIONS /api/auth/anonymous",
				"POST /api/auth/resolve-user",
				"OPTIONS /api/auth/resolve-user",
				"POST /api/chat",
				"OPTIONS /api/chat",
				"POST /api/files/contextual-prompt",
				"OPTIONS /api/files/contextual-prompt",
				"POST /api/internal/plugins/host/claim-runner-call",
				"OPTIONS /api/internal/plugins/host/claim-runner-call",
				"POST /api/internal/plugins/host/finish-runner-call",
				"OPTIONS /api/internal/plugins/host/finish-runner-call",
				"POST /api/internal/plugins/host/secret-get",
				"OPTIONS /api/internal/plugins/host/secret-get",
				"POST /api/r2/event",
				"OPTIONS /api/r2/event",
				"POST /api/v1/activities/start",
				"OPTIONS /api/v1/activities/start",
				"POST /api/v1/files/download-urls",
				"OPTIONS /api/v1/files/download-urls",
				"POST /api/v1/files/list",
				"OPTIONS /api/v1/files/list",
				"POST /api/v1/files/read",
				"OPTIONS /api/v1/files/read",
				"POST /api/v1/files/read-many",
				"OPTIONS /api/v1/files/read-many",
				"POST /api/v1/files/touch",
				"OPTIONS /api/v1/files/touch",
				"POST /api/v1/files/upload-urls",
				"OPTIONS /api/v1/files/upload-urls",
				"POST /api/v1/files/write",
				"OPTIONS /api/v1/files/write",
				"POST /api/v1/files/write-many",
				"OPTIONS /api/v1/files/write-many",
				"POST /api/v1/runs/stream",
				"OPTIONS /api/v1/runs/stream",
				"GET /getMessagesByAuthor",
				"OPTIONS /getMessagesByAuthor",
				"POST /polar/events",
				"GET /plugins-ui/*",
			].sort(),
		);
	});
});
