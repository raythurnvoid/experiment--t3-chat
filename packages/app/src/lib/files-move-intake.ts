import { z } from "zod";
import type { app_convex_Doc, app_convex_Id } from "./app-convex-client.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../../shared/files.ts";

const node_id = z.custom<app_convex_Id<"files_nodes">>((value) => typeof value === "string");
const request_schema = z.object({
	userId: z.string(),
	membershipId: z.custom<app_convex_Id<"organizations_workspaces_users">>((value) => typeof value === "string"),
	requestId: z.string(),
	revision: z.string().nullable(),
	targetParentId: z.custom<app_convex_Doc<"files_nodes">["parentId"]>((value) => typeof value === "string"),
	sourceCount: z.number().int().positive(),
	runId: z.custom<app_convex_Id<"files_transfer_runs">>((value) => typeof value === "string").nullable(),
	stopRequested: z.boolean(),
});

export type FilesMoveIntake = z.infer<typeof request_schema>;

function open_database() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("app::files_move_intake", 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("requests", {
				keyPath: ["userId", "membershipId"],
			});
			request.result.createObjectStore("pages", {
				keyPath: ["userId", "membershipId", "requestId", "offset"],
			});
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Move storage could not be opened."));
	});
}

function wait_for_transaction(transaction: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? new Error("Move selection was not saved."));
		transaction.onerror = () => reject(transaction.error ?? new Error("Move selection was not saved."));
	});
}

/**
 * Save the whole selection before sending any part to Convex.
 */
export async function files_move_intake_save(args: {
	request: FilesMoveIntake;
	sourceIds: app_convex_Id<"files_nodes">[];
}) {
	const database = await open_database();
	try {
		const transaction = database.transaction(["requests", "pages"], "readwrite");
		const completed = wait_for_transaction(transaction);
		// add refuses a second tab's request instead of overwriting its saved selection.
		transaction.objectStore("requests").add(args.request);
		for (let offset = 0; offset < args.sourceIds.length; offset += files_TRANSFER_SELECTION_PAGE_SIZE) {
			transaction.objectStore("pages").add({
				userId: args.request.userId,
				membershipId: args.request.membershipId,
				requestId: args.request.requestId,
				offset,
				sourceIds: args.sourceIds.slice(offset, offset + files_TRANSFER_SELECTION_PAGE_SIZE),
			});
		}
		await completed;
	} finally {
		database.close();
	}
}

export async function files_move_intake_load(args: { userId: string; membershipId: FilesMoveIntake["membershipId"] }) {
	const database = await open_database();
	try {
		return await new Promise<FilesMoveIntake | null>((resolve, reject) => {
			const request = database.transaction("requests").objectStore("requests").get([args.userId, args.membershipId]);
			request.onsuccess = () => {
				if (request.result === undefined) return resolve(null);
				const parsed = request_schema.safeParse(request.result);
				if (parsed.success) resolve(parsed.data);
				else reject(new Error("The saved Move request is not valid."));
			};
			request.onerror = () => reject(request.error ?? new Error("The saved Move request could not be read."));
		});
	} finally {
		database.close();
	}
}

export async function files_move_intake_read_page(args: { request: FilesMoveIntake; offset: number }) {
	const database = await open_database();
	try {
		return await new Promise<app_convex_Id<"files_nodes">[]>((resolve, reject) => {
			const request = database
				.transaction("pages")
				.objectStore("pages")
				.get([args.request.userId, args.request.membershipId, args.request.requestId, args.offset]);
			request.onsuccess = () => {
				const parsed = z
					.object({
						sourceIds: z.array(node_id).min(1).max(files_TRANSFER_SELECTION_PAGE_SIZE),
					})
					.safeParse(request.result);
				if (parsed.success) resolve(parsed.data.sourceIds);
				else reject(new Error("The saved Move selection is missing a page."));
			};
			request.onerror = () => reject(request.error ?? new Error("The saved Move selection could not be read."));
		});
	} finally {
		database.close();
	}
}

export async function files_move_intake_update(request: FilesMoveIntake) {
	const database = await open_database();
	try {
		const transaction = database.transaction("requests", "readwrite");
		const completed = wait_for_transaction(transaction);
		const store = transaction.objectStore("requests");
		const current = store.get([request.userId, request.membershipId]);
		current.onsuccess = () => {
			const parsed = request_schema.safeParse(current.result);
			// Another tab's Stop stays set until a confirmed Stop removes the request.
			if (parsed.success && parsed.data.requestId === request.requestId)
				store.put({ ...request, stopRequested: parsed.data.stopRequested || request.stopRequested });
			// Another tab may have retired the pages before this tab learned the run ID.
			else if (current.result === undefined && request.stopRequested && request.runId) store.add(request);
		};
		await completed;
	} finally {
		database.close();
	}
}

export async function files_move_intake_delete(request: FilesMoveIntake) {
	const database = await open_database();
	try {
		const transaction = database.transaction(["requests", "pages"], "readwrite");
		const completed = wait_for_transaction(transaction);
		const store = transaction.objectStore("requests");
		const current = store.get([request.userId, request.membershipId]);
		current.onsuccess = () => {
			const parsed = request_schema.safeParse(current.result);
			if (parsed.success && parsed.data.requestId === request.requestId) {
				// A sealed tab must keep another tab's unconfirmed Stop and its input.
				if (parsed.data.stopRequested && !request.stopRequested) return;
				store.delete([request.userId, request.membershipId]);
			}
			transaction
				.objectStore("pages")
				.delete(
					IDBKeyRange.bound(
						[request.userId, request.membershipId, request.requestId, 0],
						[request.userId, request.membershipId, request.requestId, request.sourceCount],
					),
				);
		};
		await completed;
	} finally {
		database.close();
	}
}
