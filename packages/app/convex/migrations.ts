import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";

const app_migrations = new Migrations<DataModel>(components.migrations, {
	internalMutation,
});

type LegacyBillingUsageSnapshot = Omit<Doc<"billing_usage_snapshots">, "_id" | "_creationTime"> & {
	_id: Id<"billing_usage_snapshots">;
	_creationTime: number;
	lastGrantedPeriodStart?: string;
};

export const remove_billing_usage_snapshots_last_granted_period_start = app_migrations.define({
	table: "billing_usage_snapshots",
	migrateOne: async (ctx, snapshot) => {
		const legacySnapshot = snapshot as LegacyBillingUsageSnapshot;
		if (legacySnapshot.lastGrantedPeriodStart === undefined) {
			return;
		}

		const { _id, _creationTime, lastGrantedPeriodStart: _lastGrantedPeriodStart, ...next } = legacySnapshot;
		await ctx.db.replace(_id, next);
	},
});

/** Run migrations from the CLI: `pnpm exec convex run migrations:run -- ...` (cwd: packages/app). */
export const run = app_migrations.runner();
export const run_remove_billing_usage_snapshots_last_granted_period_start = app_migrations.runner(
	internal.migrations.remove_billing_usage_snapshots_last_granted_period_start,
);
