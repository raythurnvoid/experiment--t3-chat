import "./plugins-ui-frame.css";

import { memo, useLayoutEffect, useRef, useState } from "react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
} from "@/lib/app-convex-client.ts";
import type { Id } from "../../convex/_generated/dataModel.ts";
import { plugins_data_validate_watch_inputs } from "../../shared/plugins.ts";

const CONVEX_HTTP_URL = import.meta.env.VITE_CONVEX_HTTP_URL as string;
const CONVEX_HTTP_ORIGIN = new URL(CONVEX_HTTP_URL).origin;

// Max time a frame attempt gets from mount to posting bonobo:init before it counts as failed.
const STARTUP_DEADLINE_MS = 15_000;

// Max page-visible data watches (plain or window alike) per frame generation. One more answers a
// null update.
const MAX_WATCH_SUBSCRIPTIONS = 8;

// Key intervals one document window may hold, committed plus pending. Worst case per window:
// 6 intervals × 100 docs × 16 KiB values ≈ 9.6 MiB flattened; a realistic chat channel stays
// around 1 MiB.
const MAX_WINDOW_INTERVALS = 6;

// Server subscriptions per frame generation: one per plain watch, one per window interval,
// committed and pending alike. Every subscription re-reads ~8 auth docs when a role edit
// invalidates it, so 24 subs cost ~192 auth reads per invalidation.
const MAX_FRAME_SERVER_SUBSCRIPTIONS = 24;

// Page-initiated subscription starts draw from a token bucket: one token back per second, up to
// this burst. A token is taken only when a command is about to start a real server read — a watch
// registration past the caps, or a load-older that actually extends its window. Commands refused
// earlier (bad inputs, capacity) and no-op load-olders are free, so an event-driven page that
// calls loadOlder on every delivery is not taxed for guessing. Tokens are never refunded on
// unwatch, and the bucket is never reset on bonobo:ready — the nonce sits in the page's own URL
// fragment, so a page can spam ready at will.
const WATCH_START_BUCKET_BURST = 64;
const WATCH_START_REFILL_MS = 1_000;

// An honest SDK repeats bonobo:ready only until init arrives (≈30 sends worst case). A page
// spamming ready past this is abusing the registry-clearing side effect, and the frame dies.
const MAX_READY_MESSAGES = 64;

// #region frame
type PluginsUiFrame_ClassNames = "PluginsUiFrame";

type RefreshResponse =
	| {
			type: "bonobo:token";
			bridgeNonce: string;
			requestId: string;
			token: string;
			tokenExpiresAt: number;
	  }
	| {
			type: "bonobo:token-error";
			bridgeNonce: string;
			requestId: string;
			message: string;
	  };

// Page-chosen correlation ids: refresh request ids, watch subscription ids, and data request ids.
function is_bridge_message_id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

const USER_WRITE_OPS = ["append", "put", "remove", "putOwned", "removeOwned"] as const;
type PluginsUiFrame_UserWriteOp = (typeof USER_WRITE_OPS)[number];

function is_user_write_op(value: unknown): value is PluginsUiFrame_UserWriteOp {
	return typeof value === "string" && (USER_WRITE_OPS as readonly string[]).includes(value);
}

type PluginsUiFrame_WatchDocumentsResult = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins_data.watch_documents
>;

type PluginsUiFrame_WatchDoc = NonNullable<PluginsUiFrame_WatchDocumentsResult>["docs"][number];

/**
 * The page-derived watch args. Interval bounds are excluded from this type on purpose: they are
 * host-computed fenceposts and travel as their own parameter below, so a page payload can never
 * smuggle a bound into the query.
 */
type PluginsUiFrame_WatchArgs = Omit<
	app_convex_FunctionArgs<typeof app_convex_api.plugins_data.watch_documents>,
	"keyStartExclusive" | "keyEndInclusive"
>;

/**
 * Start one Convex reactive subscription for a page's data watch. `onResult` gets the query value
 * (the docs window, or `null` when the store denied the read) and `{ queryError }` when the
 * subscription errors. Returns `null` when the subscription cannot start at all, for example when
 * the page sent a payload the Convex client cannot serialize. Keep this at module level: it
 * needs `try`/`catch`, which must stay out of code the React Compiler compiles.
 */
function start_documents_watch(
	queryArgs: PluginsUiFrame_WatchArgs,
	bounds: { keyStartExclusive?: string; keyEndInclusive?: string } | null,
	onResult: (outcome: { value: PluginsUiFrame_WatchDocumentsResult } | { queryError: unknown }) => void,
) {
	try {
		const watcher = app_convex.watchQuery(app_convex_api.plugins_data.watch_documents, {
			...queryArgs,
			...(bounds?.keyStartExclusive === undefined ? {} : { keyStartExclusive: bounds.keyStartExclusive }),
			...(bounds?.keyEndInclusive === undefined ? {} : { keyEndInclusive: bounds.keyEndInclusive }),
		});

		const deliver_current = () => {
			try {
				const value = watcher.localQueryResult();
				// undefined means no result yet; a later onUpdate callback delivers the first one.
				if (value !== undefined) {
					onResult({ value });
				}
			} catch (queryError) {
				onResult({ queryError });
			}
		};

		// onUpdate does not fire for a result the client already holds, so the caller must also
		// call deliver_current once after registering.
		const dispose = watcher.onUpdate(deliver_current);
		return { dispose, deliver_current };
	} catch {
		return null;
	}
}

/**
 * One key interval of a document window: one server subscription over
 * `(gt start .. lte end]`, where a `null` side is unbounded. `docs` is the last delivered array
 * and `previousFirstKey` the first key of the delivery before it — the only legal split
 * fencepost, because the current first key may be a brand-new arrival.
 */
type PluginsUiFrame_WindowInterval = {
	start: string | null;
	end: string | null;
	docs: PluginsUiFrame_WatchDoc[] | null;
	truncated: boolean;
	previousFirstKey: string | undefined;
	/** Dispose the watcher and release its server slot, exactly once. */
	stop: () => void;
};

type PluginsUiFrame_WindowUpdate = {
	docs: PluginsUiFrame_WatchDoc[];
	hasMore: boolean;
	atCapacity: boolean;
	incomplete: boolean;
};

/**
 * A reactive document window: an ordered list of disjoint, contiguous key intervals whose
 * fenceposts are keys the server itself delivered. The page sees one flattened doc list that
 * RETAINS loaded history — arrivals grow an interval and splits absorb the overflow, instead of
 * older docs sliding out of a single capped read.
 *
 * The host never compares keys. Fenceposts are picked positionally (an element of a delivered
 * array, or a bound stored at creation), because a JS string comparison disagrees with the
 * index's UTF-8 order on supplementary-plane characters. Everything order-related is the
 * server's job.
 *
 * Swap discipline: the committed interval list is the only flatten source. At most one pending
 * replacement (a split or a merge) exists at a time; the replaced intervals stay committed and
 * keep delivering until every replacement has a result, then the swap commits atomically in the
 * last delivery's callback. Re-seats bypass this: they keep the interval's delivered docs across
 * a dispose-and-create, so they are content-neutral by construction.
 *
 * Kill rule: any interval — committed or pending — answering `null` or throwing kills the whole
 * window: every watcher is disposed synchronously, the page gets exactly one `docs: null`, and
 * later callbacks are ignored. `dead` is checked before every watcher start so an in-flight
 * grow cannot resurrect a killed window.
 */
function create_documents_window(deps: {
	queryArgs: PluginsUiFrame_WatchArgs;
	acquire_server_slot: () => boolean;
	release_server_slot: () => void;
	frame_at_ceiling: () => boolean;
	take_watch_start_token: () => boolean;
	post_update: (payload: PluginsUiFrame_WindowUpdate) => void;
	on_dead: () => void;
}) {
	const state = {
		intervals: [] as PluginsUiFrame_WindowInterval[],
		pending: null as { from: number; removeCount: number; replacements: PluginsUiFrame_WindowInterval[] } | null,
		queuedLoadOlder: false,
		/** Sticky: set on the first re-seat, when older docs are first known to exist. */
		bottomOpen: false,
		loadingOlder: false,
		awaitingTail: null as PluginsUiFrame_WindowInterval | null,
		/** One-shot: a refused load-older reports atCapacity on the next flush. */
		forceAtCapacity: false,
		flushScheduled: false,
		lastPayloadJson: null as string | null,
		dead: false,
	};

	const stop_all = () => {
		state.dead = true;
		for (const interval of state.intervals) {
			interval.stop();
		}
		for (const interval of state.pending?.replacements ?? []) {
			interval.stop();
		}
		state.pending = null;
	};

	const kill = () => {
		if (state.dead) {
			return;
		}
		stop_all();
		deps.on_dead();
	};

	const start_interval = (interval: PluginsUiFrame_WindowInterval) => {
		if (state.dead || !deps.acquire_server_slot()) {
			return false;
		}
		const subscription = start_documents_watch(
			deps.queryArgs,
			{
				...(interval.start === null ? {} : { keyStartExclusive: interval.start }),
				...(interval.end === null ? {} : { keyEndInclusive: interval.end }),
			},
			(outcome) => handle_result(interval, outcome),
		);
		if (!subscription) {
			deps.release_server_slot();
			return false;
		}
		let stopped = false;
		interval.stop = () => {
			if (stopped) {
				return;
			}
			stopped = true;
			subscription.dispose();
			deps.release_server_slot();
		};
		// Defer the first delivery one microtask. The Convex client can hold a cached result for
		// identical args (a sibling watch on the same collection), and a synchronous delivery here
		// would run handle_result before the caller finished its bookkeeping: reconcile would miss
		// the re-seat of a truncated head, a tail would set loadingOlder after the delivery that
		// was meant to clear it, and a cached denial's kill would not find this interval to
		// dispose — leaking the subscription on the app-wide client. After the microtask, every
		// caller has registered the interval, so the delivery lands on complete state.
		queueMicrotask(() => {
			if (!stopped) {
				subscription.deliver_current();
			}
		});
		return true;
	};

	/**
	 * Whether a truncated bounded interval can be split. The fencepost is the previously
	 * delivered first key when one exists (so the left side isolates new arrivals); an interval
	 * whose very first delivery already truncated uses its own last delivered key instead, so
	 * the repeat-split that extends coverage does not stall waiting for a second delivery.
	 * Degenerate splits are refused: a fencepost equal to a bound would recreate the parent's
	 * exact args, and Convex dedupes identical-args subscriptions into one token, which would
	 * double-flatten the range.
	 */
	const split_fencepost = (interval: PluginsUiFrame_WindowInterval) => {
		if (interval.docs === null || interval.docs.length === 0) {
			return null;
		}
		const fencepost = interval.previousFirstKey ?? interval.docs[interval.docs.length - 1]!.key;
		if (fencepost === interval.start || fencepost === interval.end) {
			return null;
		}
		if (new Set(interval.docs.map((doc) => doc.key)).size < 2) {
			return null;
		}
		return fencepost;
	};

	const window_interval_count = () => state.intervals.length + (state.pending?.replacements.length ?? 0);

	const compute_payload = (): PluginsUiFrame_WindowUpdate => {
		const docs = state.intervals.flatMap((interval) => interval.docs ?? []);
		const last = state.intervals[state.intervals.length - 1];
		// Full coverage of the remaining range holds only in the terminal state "unbounded tail
		// delivered non-truncated". An undelivered tail still counts as more-to-come.
		const hasMore =
			state.bottomOpen && !(last !== undefined && last.end === null && last.docs !== null && !last.truncated);
		const atCapacity =
			state.forceAtCapacity || state.intervals.length >= MAX_WINDOW_INTERVALS || deps.frame_at_ceiling();
		// A truncated bounded interval that no split can repair is a hole in the middle of the
		// flattened list. The page must see that docs are missing instead of a silently shorter
		// history. An interval a pending swap is already replacing is being repaired, not stuck.
		const incomplete = state.intervals.some((interval, index) => {
			if (interval.end === null || !interval.truncated || interval.docs === null) {
				return false;
			}
			if (state.pending && index >= state.pending.from && index < state.pending.from + state.pending.removeCount) {
				return false;
			}
			return (
				split_fencepost(interval) === null ||
				window_interval_count() + 1 > MAX_WINDOW_INTERVALS ||
				deps.frame_at_ceiling()
			);
		});
		return { docs, hasMore, atCapacity, incomplete };
	};

	// One flush per microtask, and a post only when the WHOLE payload changed. Comparing docs
	// alone would swallow the hasMore transition, because a re-seat is content-neutral on purpose.
	const schedule_flush = () => {
		if (state.flushScheduled || state.dead) {
			return;
		}
		state.flushScheduled = true;
		queueMicrotask(() => {
			state.flushScheduled = false;
			if (state.dead) {
				return;
			}
			const payload = compute_payload();
			state.forceAtCapacity = false;
			const payloadJson = JSON.stringify(payload);
			if (payloadJson === state.lastPayloadJson) {
				return;
			}
			state.lastPayloadJson = payloadJson;
			deps.post_update(payload);
		});
	};

	const report_at_capacity = () => {
		if (state.dead) {
			return;
		}
		state.forceAtCapacity = true;
		schedule_flush();
	};

	/**
	 * Re-seat an unbounded interval that just delivered truncated: pin its lower side to its own
	 * largest delivered key and restart the watcher over that closed range. The delivered docs
	 * stay on the interval, so the swap is content-neutral and needs no pending machinery. From
	 * here on, arrivals inside the range grow the interval instead of sliding docs out of a
	 * capped read, and the range below the fencepost belongs to load-older.
	 */
	const reseat_tail = (interval: PluginsUiFrame_WindowInterval) => {
		const fencepost = interval.docs![interval.docs!.length - 1]!.key;
		interval.stop();
		interval.end = fencepost;
		// The truncation belonged to the old unbounded range. The delivered docs exactly cover the
		// new closed range, so carrying the flag over would read as a hole that is not there.
		interval.truncated = false;
		state.bottomOpen = true;
		// The stop above released a slot, so this 1-for-1 restart cannot hit the ceiling.
		if (!start_interval(interval)) {
			kill();
		}
	};

	const execute_load_older = () => {
		if (state.dead || state.loadingOlder || state.pending || !compute_payload().hasMore) {
			return;
		}
		const last = state.intervals[state.intervals.length - 1];
		// hasMore proved the last interval is bounded: an unbounded last either re-seated on its
		// truncated delivery, or is still undelivered behind loadingOlder.
		if (!last || last.end === null) {
			return;
		}
		if (window_interval_count() + 1 > MAX_WINDOW_INTERVALS || deps.frame_at_ceiling()) {
			report_at_capacity();
			return;
		}
		// Only a load-older that actually starts a new interval read pays a start token; every
		// earlier return above was free. A drained bucket reports atCapacity — the window really
		// cannot grow right now, and the flag clears with the next delivered change.
		if (!deps.take_watch_start_token()) {
			report_at_capacity();
			return;
		}
		// The new tail starts at the STORED bound, not at a delivered key — the last interval's
		// delivered array can be empty after physical deletes, but its bound was a real key once
		// and stays a valid fencepost.
		const tail: PluginsUiFrame_WindowInterval = {
			start: last.end,
			end: null,
			docs: null,
			truncated: false,
			previousFirstKey: undefined,
			stop: () => {},
		};
		if (!start_interval(tail)) {
			report_at_capacity();
			return;
		}
		state.intervals.push(tail);
		state.loadingOlder = true;
		state.awaitingTail = tail;
	};

	/**
	 * The single re-evaluation point after every delivery and commit: re-seat a truncated
	 * unbounded tail, run a queued load-older, then start at most one pending swap — a split of
	 * the first truncated bounded interval, or a merge of the first adjacent pair small enough
	 * to share one subscription again.
	 */
	const reconcile = () => {
		if (state.dead) {
			return;
		}
		const last = state.intervals[state.intervals.length - 1];
		if (last && last.end === null && last.docs !== null && last.truncated) {
			reseat_tail(last);
			if (state.dead) {
				return;
			}
		}
		if (state.pending) {
			return;
		}
		if (state.queuedLoadOlder) {
			state.queuedLoadOlder = false;
			execute_load_older();
		}

		// Split scan: left = (parent.start .. fencepost], right = (fencepost .. parent.end].
		for (const [index, interval] of state.intervals.entries()) {
			if (interval.end === null || !interval.truncated || interval.docs === null) {
				continue;
			}
			const fencepost = split_fencepost(interval);
			if (fencepost === null) {
				continue;
			}
			// The refused split leaves the interval truncated; the flush reports it as incomplete.
			if (window_interval_count() + 1 > MAX_WINDOW_INTERVALS) {
				break;
			}
			const left: PluginsUiFrame_WindowInterval = {
				start: interval.start,
				end: fencepost,
				docs: null,
				truncated: false,
				previousFirstKey: undefined,
				stop: () => {},
			};
			const right: PluginsUiFrame_WindowInterval = {
				start: fencepost,
				end: interval.end,
				docs: null,
				truncated: false,
				previousFirstKey: undefined,
				stop: () => {},
			};
			if (!start_interval(left)) {
				break;
			}
			if (!start_interval(right)) {
				left.stop();
				break;
			}
			state.pending = { from: index, removeCount: 1, replacements: [left, right] };
			return;
		}

		// Merge scan: after physical deletes, two adjacent intervals that together hold less than
		// one page fit back into one subscription, reclaiming a server slot. Exactly one full
		// page is deliberately excluded — that merge would re-split on the very next arrival.
		for (let index = 0; index + 1 < state.intervals.length; index += 1) {
			const first = state.intervals[index]!;
			const second = state.intervals[index + 1]!;
			if (first.docs === null || second.docs === null) {
				continue;
			}
			if (first.docs.length + second.docs.length >= deps.queryArgs.limit) {
				continue;
			}
			const merged: PluginsUiFrame_WindowInterval = {
				start: first.start,
				end: second.end,
				docs: null,
				truncated: false,
				previousFirstKey: undefined,
				stop: () => {},
			};
			if (!start_interval(merged)) {
				break;
			}
			state.pending = { from: index, removeCount: 2, replacements: [merged] };
			return;
		}
	};

	// All-or-nothing: the swap commits only once every replacement has a delivered result, so
	// the flattened list never shows a partially re-read range.
	const commit_pending = () => {
		const pending = state.pending!;
		state.pending = null;
		const replaced = state.intervals.splice(pending.from, pending.removeCount, ...pending.replacements);
		for (const interval of replaced) {
			interval.stop();
		}
		schedule_flush();
		reconcile();
	};

	const handle_result = (
		interval: PluginsUiFrame_WindowInterval,
		outcome: { value: PluginsUiFrame_WatchDocumentsResult } | { queryError: unknown },
	) => {
		if (state.dead) {
			return;
		}
		if ("queryError" in outcome) {
			console.error("[PluginsUiFrame] Plugin data window interval failed:", { error: outcome.queryError });
			kill();
			return;
		}
		// null is the store's denial/revocation answer, and one dead interval kills the whole
		// window: a flattened list with a silently missing range would lie to the page.
		if (outcome.value === null) {
			kill();
			return;
		}

		interval.previousFirstKey = interval.docs?.[0]?.key;
		interval.docs = outcome.value.docs;
		interval.truncated = outcome.value.truncated;
		if (state.awaitingTail === interval) {
			state.awaitingTail = null;
			state.loadingOlder = false;
		}

		if (state.pending?.replacements.includes(interval)) {
			if (state.pending.replacements.every((replacement) => replacement.docs !== null)) {
				commit_pending();
			}
			return;
		}

		schedule_flush();
		reconcile();
	};

	// START: one unbounded subscription, exactly the shape of a plain capped watch. The window
	// machinery only engages when this first interval reports truncated.
	const head: PluginsUiFrame_WindowInterval = {
		start: null,
		end: null,
		docs: null,
		truncated: false,
		previousFirstKey: undefined,
		stop: () => {},
	};
	if (!start_interval(head)) {
		return null;
	}
	state.intervals.push(head);

	return {
		load_older: () => {
			if (state.dead) {
				return;
			}
			// Queue behind a pending swap; everything else re-checks inside execute_load_older.
			if (state.pending) {
				state.queuedLoadOlder = true;
				return;
			}
			execute_load_older();
		},
		dispose: () => {
			if (state.dead) {
				return;
			}
			stop_all();
		},
	};
}

// Both mint mutations return the same Result shape, so the page mint's type is the shared contract.
type PluginsUiFrame_MintSessionResult = app_convex_FunctionReturnType<typeof app_convex_api.plugins_ui.mint_page_session>;

type PluginsUiFrame_Props = {
	membershipId: Id<"organizations_workspaces_users">;
	pluginName: string;
	pluginVersionId: Id<"plugins_versions">;
	entry: string;
	title: string;
	/** Human label used inside frame error messages, e.g. "plugin page" or "plugin view". */
	kindLabel: string;
	/**
	 * Mints this frame's session. Wrap in `useFn`: a new identity re-runs the bridge effect, which
	 * tears the frame down.
	 */
	mintSession: () => Promise<PluginsUiFrame_MintSessionResult>;
	/**
	 * Builds the `context` object posted in bonobo:init. The frame adds `userId` itself, so both
	 * context kinds carry it without each caller repeating it. Wrap in `useFn` for the same reason
	 * as `mintSession`.
	 */
	getInitContext: () => Record<string, unknown>;
	onError: (message: string) => void;
};

/**
 * The sandboxed iframe bridge shared by plugin pages and plugin file views. It loads the plugin's
 * published HTML entry, mints a `plu_` session through `mintSession`, and speaks the
 * bonobo:ready/init/token postMessage protocol with the SDK inside the frame. The caller keys this
 * component so that every meaningful change (tenant, version, view, retry) gets a fresh document
 * and bridge nonce.
 */
export const PluginsUiFrame = memo(function PluginsUiFrame(props: PluginsUiFrame_Props) {
	const { membershipId, pluginName, pluginVersionId, entry, title, kindLabel, mintSession, getInitContext, onError } =
		props;
	// The frame only mounts for an authenticated member, and the SDK requires `userId` in the init
	// context of both kinds.
	const { userId } = AppAuthProvider.useAuthenticated();
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [bridgeNonce] = useState(() => crypto.randomUUID());

	// Attach the message and load listeners before assigning src so the first page event cannot be missed.
	useLayoutEffect(() => {
		const iframeNode = iframeRef.current;
		const iframeWindow = iframeNode?.contentWindow;
		if (!iframeNode || !iframeWindow) {
			onError(`Failed to start the ${kindLabel} frame`);
			return;
		}

		const iframeSrc = new URL(`${CONVEX_HTTP_URL}/plugins-ui/${pluginVersionId}/${entry}`);
		iframeSrc.hash = new URLSearchParams({
			parentOrigin: window.location.origin,
			bridgeNonce,
		}).toString();
		let cancelled = false;
		let loadCount = 0;
		let sessionId: Id<"plugins_ui_sessions"> | null = null;
		let revokeStarted = false;
		let frameReady = false;
		let initMessage: unknown = null;
		let refreshInFlight: { requestId: string; promise: Promise<RefreshResponse> } | null = null;
		let lastRefreshResponse: RefreshResponse | null = null;
		// Live plugin-data subscriptions for this frame generation, by page subscription id. A
		// plain watch and a document window each occupy one page-visible slot.
		const watchRegistrations = new Map<
			string,
			| { kind: "plain"; dispose: () => void }
			| { kind: "window"; window: NonNullable<ReturnType<typeof create_documents_window>> }
		>();
		// Server subscriptions across every registration: plain watches and window intervals,
		// committed and pending alike.
		let serverSubscriptionCount = 0;
		const acquire_server_slot = () => {
			if (serverSubscriptionCount >= MAX_FRAME_SERVER_SUBSCRIPTIONS) {
				return false;
			}
			serverSubscriptionCount += 1;
			return true;
		};
		const release_server_slot = () => {
			serverSubscriptionCount -= 1;
		};
		const frame_at_ceiling = () => serverSubscriptionCount >= MAX_FRAME_SERVER_SUBSCRIPTIONS;
		// The page-initiated start budget. Belongs to the frame generation; bonobo:ready never
		// touches it.
		let watchStartTokens = WATCH_START_BUCKET_BURST;
		let watchStartRefilledAt = Date.now();
		const take_watch_start_token = () => {
			const refill = Math.floor((Date.now() - watchStartRefilledAt) / WATCH_START_REFILL_MS);
			if (refill > 0) {
				watchStartTokens = Math.min(WATCH_START_BUCKET_BURST, watchStartTokens + refill);
				watchStartRefilledAt += refill * WATCH_START_REFILL_MS;
			}
			if (watchStartTokens <= 0) {
				return false;
			}
			watchStartTokens -= 1;
			return true;
		};
		let readyCount = 0;

		const startupDeadline = setTimeout(() => {
			if (!cancelled) {
				cancelled = true;
				onError(`The ${kindLabel} did not start in time`);
			}
		}, STARTUP_DEADLINE_MS);

		const revoke_session = (id: Id<"plugins_ui_sessions"> | null) => {
			if (!id || revokeStarted) {
				return;
			}
			revokeStarted = true;
			void app_convex
				.mutation(app_convex_api.plugins_ui.revoke_ui_session, {
					membershipId,
					sessionId: id,
				})
				.catch((error) => {
					console.error("[PluginsUiFrame] Failed to revoke ui session:", {
						error,
						pluginName,
					});
				});
		};

		const post_to_iframe = (message: unknown) => {
			if (cancelled || iframeRef.current !== iframeNode) {
				return;
			}
			iframeWindow.postMessage(message, CONVEX_HTTP_ORIGIN);
		};

		const token_error = (requestId: string, message: string): RefreshResponse => ({
			type: "bonobo:token-error",
			bridgeNonce,
			requestId,
			message,
		});

		const stop_watch = (subscriptionId: string) => {
			const registration = watchRegistrations.get(subscriptionId);
			if (registration) {
				watchRegistrations.delete(subscriptionId);
				if (registration.kind === "plain") {
					registration.dispose();
				} else {
					registration.window.dispose();
				}
			}
		};

		const clear_watch_registry = () => {
			for (const registration of watchRegistrations.values()) {
				if (registration.kind === "plain") {
					registration.dispose();
				} else {
					registration.window.dispose();
				}
			}
			watchRegistrations.clear();
		};

		const handle_ready = () => {
			// A page can spam ready to churn the registry — the nonce sits in its own URL fragment.
			// An honest SDK stops at init, so past the allowance the frame dies.
			readyCount += 1;
			if (readyCount > MAX_READY_MESSAGES) {
				cancelled = true;
				clearTimeout(startupDeadline);
				clear_watch_registry();
				revoke_session(sessionId);
				onError(`The ${kindLabel} flooded the bridge and was stopped`);
				return;
			}
			// A new ready means a new SDK generation inside the same document (the bridge
			// reconnected), and its old subscription ids are dead. Pre-init ready retries only clear
			// an empty registry, because the SDK sends watches after init. The start budget is NOT
			// reset here — it belongs to the frame generation.
			// Each cleared watch still hears its one death: an old SDK generation (a second client
			// in the same document) would otherwise freeze silently on stale data. The new
			// generation ignores the unknown ids.
			for (const subscriptionId of watchRegistrations.keys()) {
				post_to_iframe({ type: "bonobo:data-update", bridgeNonce, subscriptionId, docs: null });
			}
			clear_watch_registry();
			frameReady = true;
			// The SDK repeats ready until init arrives, so replay the same init when it is available.
			if (initMessage) {
				post_to_iframe(initMessage);
				clearTimeout(startupDeadline);
			}
		};

		// Start the session while the iframe downloads and evaluates its assets. Keep the token in the
		// host until the nonce-bound ready message proves that this frame loaded the bridge SDK.
		const mintPromise = mintSession();
		void mintPromise
			.then((result) => {
				if (cancelled || iframeRef.current !== iframeNode) {
					// A mint can finish after Retry or unmount. Revoke it instead of posting to a stale frame.
					if (result._yay) {
						revoke_session(result._yay.sessionId);
					}
					return;
				}
				if (result._nay) {
					cancelled = true;
					onError(result._nay.message);
					return;
				}
				if (result._yay.pluginVersionId !== pluginVersionId) {
					revoke_session(result._yay.sessionId);
					cancelled = true;
					onError(`The installed plugin version changed while the ${kindLabel} was starting`);
					return;
				}

				sessionId = result._yay.sessionId;
				initMessage = {
					type: "bonobo:init",
					bridgeNonce,
					apiOrigin: CONVEX_HTTP_URL,
					token: result._yay.token,
					tokenExpiresAt: result._yay.expiresAt,
					// userId comes after the spread so the frame's authenticated value always wins.
					context: { ...getInitContext(), userId },
				};
				if (frameReady) {
					post_to_iframe(initMessage);
					clearTimeout(startupDeadline);
				}
			})
			.catch((error) => {
				console.error("[PluginsUiFrame] Failed to mint ui session:", {
					error,
					pluginName,
				});
				if (!cancelled) {
					cancelled = true;
					onError(`Failed to start the ${kindLabel} session`);
				}
			});

		const handle_refresh = (requestId: string) => {
			if (!sessionId) {
				post_to_iframe(token_error(requestId, `The ${kindLabel} session is not ready`));
				return;
			}
			// Replayed ids receive the same answer, while a different concurrent id is rejected.
			if (lastRefreshResponse?.requestId === requestId) {
				post_to_iframe(lastRefreshResponse);
				return;
			}
			if (refreshInFlight) {
				if (refreshInFlight.requestId === requestId) {
					void refreshInFlight.promise.then(post_to_iframe);
				} else {
					post_to_iframe(token_error(requestId, "Another session refresh is in progress"));
				}
				return;
			}

			const currentSessionId = sessionId;
			const promise: Promise<RefreshResponse> = app_convex
				.mutation(app_convex_api.plugins_ui.refresh_ui_session, {
					membershipId,
					sessionId: currentSessionId,
				})
				.then((result) => {
					if (result._nay) {
						return token_error(requestId, result._nay.message);
					}
					if (result._yay.pluginVersionId !== pluginVersionId) {
						return token_error(requestId, "The installed plugin version changed");
					}
					return {
						type: "bonobo:token",
						bridgeNonce,
						requestId,
						token: result._yay.token,
						tokenExpiresAt: result._yay.expiresAt,
					} satisfies RefreshResponse;
				})
				.catch((error) => {
					console.error("[PluginsUiFrame] Failed to refresh ui session:", {
						error,
						pluginName,
					});
					return token_error(requestId, "Failed to refresh the session");
				});
			refreshInFlight = { requestId, promise };
			void promise.then((response) => {
				if (refreshInFlight?.promise === promise) {
					refreshInFlight = null;
					lastRefreshResponse = response;
				}
				post_to_iframe(response);
			});
		};

		// Shared refusals for a watch start that never registers. Every refusal the host decides
		// itself names its reason — "capacity" says close a subscription, "budget" says retry in a
		// moment — so only access loss and query death stay a bare null.
		const refuse_watch_capacity = (subscriptionId: string) => {
			console.warn("[PluginsUiFrame] Plugin data watch refused, subscription cap reached:", {
				pluginName,
				subscriptionId,
			});
			post_to_iframe({
				type: "bonobo:data-update",
				bridgeNonce,
				subscriptionId,
				docs: null,
				reason: "capacity",
				message: "Subscription limit reached for this page",
			});
		};
		const refuse_watch_budget = (subscriptionId: string) => {
			console.warn("[PluginsUiFrame] Plugin data watch refused, start budget exhausted:", {
				pluginName,
				subscriptionId,
			});
			post_to_iframe({
				type: "bonobo:data-update",
				bridgeNonce,
				subscriptionId,
				docs: null,
				reason: "budget",
				message: "Too many subscription starts; retry in a moment",
			});
		};

		const handle_data_watch = (
			subscriptionId: string,
			fields: { collection?: unknown; keyPrefix?: unknown; limit?: unknown },
		) => {
			// The SDK never reuses a subscription id; on a duplicate the live watch wins.
			if (watchRegistrations.has(subscriptionId)) {
				return;
			}

			const post_dead = () => {
				post_to_iframe({ type: "bonobo:data-update", bridgeNonce, subscriptionId, docs: null });
			};

			// Validate the page's inputs with the shared strict-subset rules before spending any
			// budget. The local refusal carries a reason so the page can tell bad args from a
			// denial; inputs outside the subset still go to the server and die as bare null.
			const validated = plugins_data_validate_watch_inputs({
				collection: fields.collection as string,
				...(fields.keyPrefix === undefined ? {} : { keyPrefix: fields.keyPrefix as string }),
				limit: fields.limit as number,
			});
			if (validated._nay) {
				post_to_iframe({
					type: "bonobo:data-update",
					bridgeNonce,
					subscriptionId,
					docs: null,
					reason: "invalid",
					message: validated._nay.message,
				});
				return;
			}

			// Cap page-visible subscriptions per frame generation, and check the server-side
			// ceiling before the token so a doomed start does not eat budget. Nothing registers
			// for a refused id.
			if (watchRegistrations.size >= MAX_WATCH_SUBSCRIPTIONS || frame_at_ceiling()) {
				refuse_watch_capacity(subscriptionId);
				return;
			}
			if (!take_watch_start_token()) {
				refuse_watch_budget(subscriptionId);
				return;
			}
			// The ceiling was checked synchronously above, so this slot take cannot fail; a false
			// here would still be a capacity refusal, never a budget one.
			if (!acquire_server_slot()) {
				refuse_watch_capacity(subscriptionId);
				return;
			}
			let slotReleased = false;
			const release_slot_once = () => {
				if (!slotReleased) {
					slotReleased = true;
					release_server_slot();
				}
			};

			// Membership and plugin identity come from the host's own frame state, never from the
			// page's payload. The other fields pass through as-is: `watch_documents` answers null
			// for anything malformed, which kills the subscription like a denial.
			const subscription = start_documents_watch(
				{
					membershipId,
					pluginName,
					collection: fields.collection as string,
					...(fields.keyPrefix === undefined ? {} : { keyPrefix: fields.keyPrefix as string }),
					limit: fields.limit as number,
				},
				null,
				(outcome) => {
					if ("queryError" in outcome) {
						console.error("[PluginsUiFrame] Plugin data watch failed:", {
							error: outcome.queryError,
							pluginName,
							subscriptionId,
						});
						stop_watch(subscriptionId);
						post_dead();
						return;
					}
					// null is the store's denial/revocation answer: the subscription is dead and the
					// host drops its side before telling the page.
					if (outcome.value === null) {
						stop_watch(subscriptionId);
						post_dead();
						return;
					}
					post_to_iframe({ type: "bonobo:data-update", bridgeNonce, subscriptionId, docs: outcome.value.docs });
				},
			);
			if (!subscription) {
				release_slot_once();
				console.error("[PluginsUiFrame] Plugin data watch could not start:", { pluginName, subscriptionId });
				post_dead();
				return;
			}

			watchRegistrations.set(subscriptionId, {
				kind: "plain",
				dispose: () => {
					subscription.dispose();
					release_slot_once();
				},
			});
			// Deliver a result the client already holds; onUpdate only fires on changes.
			subscription.deliver_current();
		};

		const handle_data_watch_window = (
			subscriptionId: string,
			fields: { collection?: unknown; keyPrefix?: unknown; pageSize?: unknown },
		) => {
			// Same registry, same rules as the plain watch: duplicate ids keep the live watch, the
			// shared subset rules refuse bad inputs with a reason, and the caps refuse before
			// anything registers.
			if (watchRegistrations.has(subscriptionId)) {
				return;
			}
			const validated = plugins_data_validate_watch_inputs({
				collection: fields.collection as string,
				...(fields.keyPrefix === undefined ? {} : { keyPrefix: fields.keyPrefix as string }),
				limit: fields.pageSize as number,
			});
			if (validated._nay) {
				post_to_iframe({
					type: "bonobo:data-update",
					bridgeNonce,
					subscriptionId,
					docs: null,
					reason: "invalid",
					message: validated._nay.message,
				});
				return;
			}
			if (watchRegistrations.size >= MAX_WATCH_SUBSCRIPTIONS || frame_at_ceiling()) {
				refuse_watch_capacity(subscriptionId);
				return;
			}
			if (!take_watch_start_token()) {
				refuse_watch_budget(subscriptionId);
				return;
			}

			// Register before creating: the head's first delivery (deferred one microtask) can be a
			// cached denial that kills the window right after this handler returns, and the kill
			// path must find the registration to remove it.
			const registration = { kind: "window" as const, window: null! as never };
			watchRegistrations.set(subscriptionId, registration);
			const documentsWindow = create_documents_window({
				// Page-derived fields travel by name; interval bounds never come from the page.
				queryArgs: {
					membershipId,
					pluginName,
					collection: fields.collection as string,
					...(fields.keyPrefix === undefined ? {} : { keyPrefix: fields.keyPrefix as string }),
					limit: fields.pageSize as number,
				},
				acquire_server_slot,
				release_server_slot,
				frame_at_ceiling,
				take_watch_start_token,
				post_update: (payload) => {
					post_to_iframe({
						type: "bonobo:data-update",
						bridgeNonce,
						subscriptionId,
						docs: payload.docs,
						hasMore: payload.hasMore,
						atCapacity: payload.atCapacity,
						incomplete: payload.incomplete,
					});
				},
				on_dead: () => {
					watchRegistrations.delete(subscriptionId);
					post_to_iframe({ type: "bonobo:data-update", bridgeNonce, subscriptionId, docs: null });
				},
			});
			if (!documentsWindow) {
				watchRegistrations.delete(subscriptionId);
				console.error("[PluginsUiFrame] Plugin data window could not start:", { pluginName, subscriptionId });
				post_to_iframe({ type: "bonobo:data-update", bridgeNonce, subscriptionId, docs: null });
				return;
			}
			(registration as { window: NonNullable<ReturnType<typeof create_documents_window>> }).window = documentsWindow;
		};

		const handle_data_window_load_older = (subscriptionId: string) => {
			const registration = watchRegistrations.get(subscriptionId);
			// A load-older for a plain watch or an unknown id is a silent no-op, like an unwatch.
			if (!registration || registration.kind !== "window") {
				return;
			}
			// The token charge lives inside the window manager: only a command that actually
			// starts a new interval read pays.
			registration.window.load_older();
		};

		// The widened return type is deliberate: the page gets each mutation's Result as-is, so the
		// host treats it as opaque instead of unifying the five doors' Result unions.
		const run_user_write = (
			op: PluginsUiFrame_UserWriteOp,
			fields: {
				collection?: unknown;
				keyPrefix?: unknown;
				key?: unknown;
				value?: unknown;
				clientRequestId?: unknown;
				expectedRevision?: unknown;
			},
		): Promise<unknown> => {
			// Membership and plugin identity come from the host's own frame state, never from the
			// page's payload. The other fields pass through as-is: each door's own validators refuse
			// malformed values, and that throw maps to the stable `_nay` in the caller.
			switch (op) {
				case "append":
					return app_convex.mutation(app_convex_api.plugins_data.user_append_document, {
						membershipId,
						pluginName,
						collection: fields.collection as string,
						...(fields.keyPrefix === undefined ? {} : { keyPrefix: fields.keyPrefix as string }),
						value: fields.value as Record<string, unknown>,
						clientRequestId: fields.clientRequestId as string,
					});
				case "put":
					return app_convex.mutation(app_convex_api.plugins_data.user_put_document, {
						membershipId,
						pluginName,
						collection: fields.collection as string,
						key: fields.key as string,
						value: fields.value as Record<string, unknown>,
						...(fields.expectedRevision === undefined ? {} : { expectedRevision: fields.expectedRevision as number }),
					});
				case "remove":
					return app_convex.mutation(app_convex_api.plugins_data.user_remove_document, {
						membershipId,
						pluginName,
						collection: fields.collection as string,
						key: fields.key as string,
						...(fields.expectedRevision === undefined ? {} : { expectedRevision: fields.expectedRevision as number }),
					});
				case "putOwned":
					return app_convex.mutation(app_convex_api.plugins_data.user_put_owned_document, {
						membershipId,
						pluginName,
						collection: fields.collection as string,
						key: fields.key as string,
						value: fields.value as Record<string, unknown>,
						...(fields.expectedRevision === undefined ? {} : { expectedRevision: fields.expectedRevision as number }),
					});
				case "removeOwned":
					return app_convex.mutation(app_convex_api.plugins_data.user_remove_owned_document, {
						membershipId,
						pluginName,
						collection: fields.collection as string,
						key: fields.key as string,
						...(fields.expectedRevision === undefined ? {} : { expectedRevision: fields.expectedRevision as number }),
					});
			}
		};

		const handle_data_user_write = (
			requestId: string,
			op: PluginsUiFrame_UserWriteOp,
			fields: {
				collection?: unknown;
				keyPrefix?: unknown;
				key?: unknown;
				value?: unknown;
				clientRequestId?: unknown;
				expectedRevision?: unknown;
			},
		) => {
			const respond = (result: unknown) => {
				post_to_iframe({ type: "bonobo:data-user-write-result", bridgeNonce, requestId, result });
			};
			// Promise.resolve wraps the call so a payload the Convex client cannot serialize rejects
			// here instead of throwing into the message handler.
			Promise.resolve()
				.then(() => run_user_write(op, fields))
				// The mutation's Result goes to the page as-is, `_yay` and `_nay` alike.
				.then(respond)
				.catch((error: unknown) => {
					console.error("[PluginsUiFrame] Plugin data write failed:", { error, pluginName, requestId });
					// A thrown error never reaches the frame; the real cause stays in the log above.
					respond({ _nay: { message: "Failed to write plugin data" } });
				});
		};

		const handle_data_resolve_members = (requestId: string, userIds: unknown) => {
			const respond = (members: unknown) => {
				post_to_iframe({ type: "bonobo:data-resolve-members-result", bridgeNonce, requestId, members });
			};
			// Promise.resolve wraps the call for the same reason as the user write above.
			Promise.resolve()
				.then(() =>
					app_convex.query(app_convex_api.plugins_data.resolve_member_display, {
						membershipId,
						pluginName,
						userIds: userIds as Id<"users">[],
					}),
				)
				.then((result) => {
					// A null answer is a denial; the page sees an empty map, not an error.
					respond(result === null ? {} : result.members);
				})
				.catch((error: unknown) => {
					console.error("[PluginsUiFrame] Failed to resolve plugin member names:", { error, pluginName, requestId });
					respond({});
				});
		};

		const handle_message = (event: MessageEvent) => {
			// Trust only this iframe's WindowProxy, its asset origin, and the nonce placed in its fragment.
			if (cancelled || event.source !== iframeWindow || event.origin !== CONVEX_HTTP_ORIGIN) {
				return;
			}
			const data: unknown = event.data;
			if (typeof data !== "object" || data === null) {
				return;
			}
			const message = data as {
				type?: unknown;
				bridgeNonce?: unknown;
				requestId?: unknown;
				subscriptionId?: unknown;
				op?: unknown;
				collection?: unknown;
				keyPrefix?: unknown;
				key?: unknown;
				value?: unknown;
				clientRequestId?: unknown;
				expectedRevision?: unknown;
				userIds?: unknown;
				limit?: unknown;
				pageSize?: unknown;
			};
			if (message.bridgeNonce !== bridgeNonce) {
				return;
			}
			if (message.type === "bonobo:ready") {
				handle_ready();
			} else if (message.type === "bonobo:token-refresh-request" && is_bridge_message_id(message.requestId)) {
				handle_refresh(message.requestId);
			} else if (message.type === "bonobo:data-watch" && is_bridge_message_id(message.subscriptionId)) {
				handle_data_watch(message.subscriptionId, message);
			} else if (message.type === "bonobo:data-watch-window" && is_bridge_message_id(message.subscriptionId)) {
				handle_data_watch_window(message.subscriptionId, message);
			} else if (message.type === "bonobo:data-window-load-older" && is_bridge_message_id(message.subscriptionId)) {
				handle_data_window_load_older(message.subscriptionId);
			} else if (message.type === "bonobo:data-unwatch" && is_bridge_message_id(message.subscriptionId)) {
				stop_watch(message.subscriptionId);
			} else if (
				message.type === "bonobo:data-user-write" &&
				is_bridge_message_id(message.requestId) &&
				is_user_write_op(message.op)
			) {
				handle_data_user_write(message.requestId, message.op, message);
			} else if (message.type === "bonobo:data-resolve-members" && is_bridge_message_id(message.requestId)) {
				handle_data_resolve_members(message.requestId, message.userIds);
			}
		};

		const handle_load = () => {
			loadCount += 1;
			// The first load is the assigned asset. Any later load is page-controlled navigation.
			if (loadCount > 1 && !cancelled) {
				cancelled = true;
				clearTimeout(startupDeadline);
				// A navigated-away page keeps no live subscriptions, like it keeps no session.
				clear_watch_registry();
				revoke_session(sessionId);
				onError(`The ${kindLabel} navigated away and was stopped`);
			}
		};

		window.addEventListener("message", handle_message);
		iframeNode.addEventListener("load", handle_load);
		// src is assigned last, after every guard above is active.
		if (iframeNode.getAttribute("src") !== iframeSrc.href) {
			iframeNode.setAttribute("src", iframeSrc.href);
		}

		return () => {
			cancelled = true;
			clearTimeout(startupDeadline);
			clear_watch_registry();
			window.removeEventListener("message", handle_message);
			iframeNode.removeEventListener("load", handle_load);
			revoke_session(sessionId);
		};
	}, [
		bridgeNonce,
		entry,
		getInitContext,
		kindLabel,
		membershipId,
		mintSession,
		onError,
		pluginName,
		pluginVersionId,
		userId,
	]);

	return (
		// The frame and public API share the Convex origin, so normal JSON requests need no CORS
		// preflight. The host app uses a different origin, so the plugin still cannot reach its DOM.
		// `allow-forms` only lets the submit EVENT fire so plugin code can handle it in JS; the
		// asset CSP's `form-action 'none'` still blocks every real HTTP form submission.
		<iframe
			ref={iframeRef}
			className={"PluginsUiFrame" satisfies PluginsUiFrame_ClassNames}
			title={title}
			sandbox="allow-scripts allow-same-origin allow-forms"
			referrerPolicy="no-referrer"
		/>
	);
});
// #endregion frame
