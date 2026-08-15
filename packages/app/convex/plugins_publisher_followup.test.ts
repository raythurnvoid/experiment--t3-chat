import { describe, expect, test } from "vitest";

import { api } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";

describe("plugins list_user_published_repositories", () => {
	test("keeps another plugin's named failure next to the latest ready version", async () => {
		const t = test_convex();
		const fixture = await t.run(async (ctx) => {
			const publisherUserId = await ctx.db.insert("users", { clerkUserId: null });
			const repositoryUrl = "https://github.com/bonobo/shared-plugin-repository";
			const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: publisherUserId,
				repositoryUrl,
				owner: "bonobo",
				repo: "shared-plugin-repository",
				lastPublishAttempt: {
					at: 200,
					pluginName: "gallery",
					status: "failed",
					message: "Gallery publish failed",
					commitSha: null,
					artifactHash: null,
					reviewId: null,
				},
			});
			await ctx.db.insert("plugins_versions", {
				name: "media",
				displayName: "Media",
				version: "0.1.0",
				description: "Media plugin",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: repositoryUrl,
				sourceOwner: "bonobo",
				sourceRepo: "shared-plugin-repository",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/media/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				pages: [],
				fileViews: [],
				capabilities: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: publisherUserId,
				updatedAt: 100,
			});
			return { publisherUserId, repositoryId };
		});

		const repositories = await t
			.withIdentity({
				issuer: "https://clerk.test",
				subject: `clerk-${fixture.publisherUserId}`,
				external_id: fixture.publisherUserId,
			})
			.query(api.plugins.list_user_published_repositories, {});

		expect(repositories).toMatchObject([
			{
				repository: {
					_id: fixture.repositoryId,
					lastPublishAttempt: {
						pluginName: "gallery",
						status: "failed",
						message: "Gallery publish failed",
					},
				},
				readyVersions: [
					{
						name: "media",
						version: "0.1.0",
					},
				],
			},
		]);
	});

	test("returns one ready version per plugin name on the same repository", async () => {
		const t = test_convex();
		const fixture = await t.run(async (ctx) => {
			const publisherUserId = await ctx.db.insert("users", { clerkUserId: null });
			const repositoryUrl = "https://github.com/bonobo/shared-plugin-repository";
			const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: publisherUserId,
				repositoryUrl,
				owner: "bonobo",
				repo: "shared-plugin-repository",
			});
			const sharedFields = {
				description: "Shared",
				reviewStatus: "passed" as const,
				reviewId: null,
				isLatest: true,
				sourceRepositoryUrl: repositoryUrl,
				sourceOwner: "bonobo",
				sourceRepo: "shared-plugin-repository",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/media/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [] as [],
				pages: [] as [],
				fileViews: [] as [],
				capabilities: [] as [],
				outboundOrigins: [] as [],
				uiOutboundOrigins: [] as [],
				files: [] as [],
				sourceStatus: "ready" as const,
				sourceLastError: null,
				createdBy: publisherUserId,
			};
			await ctx.db.insert("plugins_versions", {
				...sharedFields,
				name: "media",
				displayName: "Media",
				version: "0.1.0",
				artifactHash: `sha256:${"a".repeat(64)}`,
				isLatest: false,
				updatedAt: 50,
			});
			await ctx.db.insert("plugins_versions", {
				...sharedFields,
				name: "media",
				displayName: "Media",
				version: "0.2.0",
				artifactHash: `sha256:${"b".repeat(64)}`,
				updatedAt: 200,
			});
			await ctx.db.insert("plugins_versions", {
				...sharedFields,
				name: "gallery",
				displayName: "Gallery",
				version: "0.1.0",
				artifactHash: `sha256:${"c".repeat(64)}`,
				manifestR2Key: "plugins/gallery/manifest.json",
				updatedAt: 150,
			});
			return { publisherUserId, repositoryId };
		});

		const repositories = await t
			.withIdentity({
				issuer: "https://clerk.test",
				subject: `clerk-${fixture.publisherUserId}`,
				external_id: fixture.publisherUserId,
			})
			.query(api.plugins.list_user_published_repositories, {});

		expect(repositories).toMatchObject([
			{
				repository: { _id: fixture.repositoryId },
				readyVersions: [
					{ name: "media", version: "0.2.0" },
					{ name: "gallery", version: "0.1.0" },
				],
			},
		]);
		expect(repositories[0]?.readyVersions).toHaveLength(2);
	});
});
