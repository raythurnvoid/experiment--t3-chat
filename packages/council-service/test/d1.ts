// A D1-shaped wrapper over Node's own SQLite, for tests only.
//
// Route and pipeline code runs real SQL, so a hand-written fake that pattern-matches query strings
// would drift from what D1 does. Node 24 ships `node:sqlite`, and D1 is SQLite, so tests apply the
// real migration files to an in-memory database and get faithful constraint, index, and transaction
// behavior. This file is outside `src/` so the Worker typecheck never sees the `node:` import.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/cf.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

function to_result(meta: { changes: number | bigint }): D1Result {
	return { success: true, meta: { changes: Number(meta.changes) } };
}

/**
 * Open an in-memory database with every migration applied, wrapped in the D1 surface the Worker
 * code uses: prepare/bind/first/run/all and an atomic batch.
 */
export function test_d1(): D1Database {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON;");
	for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
		if (!file.endsWith(".sql")) {
			continue;
		}
		db.exec(readFileSync(`${MIGRATIONS_DIR}${file}`, "utf8"));
	}

	const prepare = (query: string): D1PreparedStatement => {
		const make = (values: unknown[]): D1PreparedStatement => ({
			bind: (...next: unknown[]) => make(next),
			first: async <T>() => {
				const row = db.prepare(query).get(...(values as never[]));
				return (row === undefined ? null : row) as T | null;
			},
			run: async () => to_result(db.prepare(query).run(...(values as never[]))),
			all: async <T>() => ({
				results: db.prepare(query).all(...(values as never[])) as T[],
				success: true,
			}),
		});
		return make([]);
	};

	return {
		prepare,
		batch: async (statements) => {
			// D1's batch is atomic, so the wrapper is too: one failing statement rolls the whole set back.
			db.exec("BEGIN");
			try {
				const results: D1Result[] = [];
				for (const statement of statements) {
					results.push(await statement.run());
				}
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}
