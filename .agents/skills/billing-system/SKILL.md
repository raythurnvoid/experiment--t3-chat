---
name: billing-system
description: Billing system guidelines for the Polar-backed plan catalog, customer and subscription bootstrap, checkout vs subscription-change behavior, usage and credit sync, billing UI, and future billing-lock work. Use when modifying billing products or product copy, Polar configuration assumptions, billing backend flows, billing account-management UI, usage snapshot handling, or billing-related product rules.
---

# Overview

Polar is intended to be the billing source of truth for products, customers, subscriptions, and usage-derived billing state.

The app mirrors enough billing state locally to drive UI and app behavior. In practice, the repo stores a synced product catalog, synced customers and subscriptions through the vendored Polar component, and a local usage snapshot derived from Polar customer state.

Subscription lifecycle webhooks are the authoritative sync path for the local subscription mirror. `customer.state_changed` is deliberately narrower: it owns the local usage snapshot and is the sole trigger for recurring monthly-credit enqueueing, but it does not infer scheduled plan changes such as `pendingUpdate`.

The `billing_usage_snapshots.meter` field stores two independent Polar values for every plan:

- `balance`, `consumedUnits`, and `creditedUnits` come from the customer-level Polar meter (`active_meters`) and own the remaining credit balance.
- `amountDueCents` comes from the subscription-level Polar meter (`active_subscriptions[].meters`) and owns the amount currently due. It is `0` for `Free` because `Free` has no subscription meter.

The `customer.state_changed` webhook is the canonical refresh path for local usage snapshots. `ingest_events` never mirrors Polar state back into the snapshot. Polar's `customersGetState` is intentionally NOT polled after `eventsIngest`: its meter aggregation lags `eventsIngest` by ~20s and never beats the next `customer.state_changed`. Instead, `db_apply_polar_customer_state_refresh` — the shared helper driven by both the webhook handler and the admin `refresh_from_polar_customer_state` action — writes an optimistic local meter through `db_apply_optimistic_credit_to_snapshot` in the same mutation that upserts the snapshot, so credits land in `billing_usage_snapshots` on the same Convex tick as the grant; the next `customer.state_changed` later replaces that meter with Polar's authoritative value. `db_upsert_usage_snapshot` preserves a present meter against an empty Polar payload as a defensive guard so a stale empty webhook arriving after the optimistic write does not clobber it.

# Canonical product behavior

## Plans

### `Free`

- Give each signed-in user a `Free` subscription after account resolution.
- Include `€10` of usage every billing month. Credits land on the shared customer-level meter the same Convex tick `db_apply_polar_customer_state_refresh` first sees an active subscription, because the inline grant runs inside that helper (driven by the `customer.state_changed` webhook or the admin replay action) and writes an optimistic meter through `db_apply_optimistic_credit_to_snapshot` before Polar's own meter aggregation catches up.
- `Free` has no subscription-level Polar meter, so `amountDueCents` is always `0` for `Free`.
- Credit gates block signed-in `Free` users once their current synced meter balance is below the operation minimum. Paid plans can go negative and bill overage through Polar.

### `Pay As You Go`

- Charge no fixed monthly fee.
- Include `€10` of usage every billing month.
- Bill usage above the included amount as overage.

### `Pro`

- Charge `€40 / month`.
- Give `€60` of included usage every billing month.
- Bill usage above the included amount as overage.

## Plan transitions

- Treat the canonical plan order as `Free < Pay As You Go < Pro`.
- Apply upgrades immediately.
- Apply downgrades at the end of the current billing cycle because the app does not refund.
- Keep the current plan's credits and billing behavior active until the downgrade effective date.

# Current architecture and code map

## Shared catalog

The shared catalog lives in [billing.ts](../../../packages/app/shared/billing.ts).

- `billing_PRODUCTS` stores the exact product names, display names, `recurringCreditsCents` per plan, legacy benefit description keys, and meter metadata the app recognizes.
- `recurringCreditsCents` is the canonical per-month credit amount for each plan. The `benefits` map is kept for stable description lookup but no longer drives credit amounts or UI copy.
- `billing_get_recurring_credits_cents` returns the per-plan recurring credit amount for the monthly credits engine and the billing UI.
- `billing_get_product_order`, `billing_compare_product_order`, and `billing_get_plan_change_kind` derive catalog ordering plus upgrade vs downgrade behavior from the canonical plan order.

Server-side usage-event typing lives in [billing.ts](../../../packages/app/server/billing.ts), while queued ingestion lives in [billing.ts](../../../packages/app/convex/billing.ts).

- `billing_POLAR_METER_EVENT` stores the single Polar meter event name, `press_usage_event`, used for both usage charges and credits.
- `billing_Event` is inferred from the `ingest_events` action validator and is the source-of-truth discriminated union for app-owned billing usage events keyed by `name`: `manual_credit`, `page_save`, `monthly_credit`, and `ai_usage`.
- `billing_Event` is the only supported billing usage event shape. It mirrors Polar's event fields with `{ name, externalCustomerId, externalId, metadata }`, except `name` is the app event name; `ingest_events` rewrites that field to the single Polar meter event and stores the app event name in `metadata.name`.
- `billing_event` is a typed identity helper for preserving the narrow `billing_Event` variant at call sites. It does not build full event payloads; callers own the metadata they emit.
- Usage-event `externalId` values are built directly with the shared `composite_id("billing", ...)` helper. Its `AppCompositeIds.billing` tuple union keeps billing IDs strict and always joins parts with `::`; keep emitted IDs aligned with the canonical event-name prefixes.
- `billing_ingest_events` is the mandatory exported local emission helper for billing usage events. It accepts `{ event, user }` pairs using the real `users` row, routes signed-in rows (`user.clerkUserId != null`) to the `billing_workpool_usage_event` retry path, and routes anonymous rows (`user.clerkUserId == null`) to a local mutation that applies the synthetic snapshot directly. The enqueued `ingest_events` action remains the only code path that should call Polar `eventsIngest`.

See [Glossary — server/billing.ts](#glossary--serverbillingts) and [Glossary — event ingestion](#glossary--event-ingestion) for precise signatures and behavior.

## Backend ownership

The backend billing module lives in [billing.ts](../../../packages/app/convex/billing.ts).

- `billing` wraps the vendored Polar component and currently allows only signed-in users through `getUserInfo`, returning the Convex user id, email, and app display name for Polar customer creation.
- `list_products`, `get_current_user_subscription`, and `get_usage_snapshot` provide the billing panel data.
- `generate_checkout_link` creates Polar checkout sessions and sends the current display name when the vendored Polar helper needs to create a missing customer.
- `change_current_subscription` handles paid-plan changes, calls Polar with the correct immediate-upgrade or next-period-downgrade behavior, then waits for the subscription webhook to update the local subscription row. `Free -> paid` is intentionally not handled there and goes through checkout instead.
- `generate_customer_portal_url` opens the Polar customer portal.
- Public billing actions (`generate_checkout_link`, `generate_customer_portal_url`, `change_current_subscription`, and `cancel_current_subscription`) are rate-limited after signed-in auth and before Polar session/update calls. Throttled Result callers receive `_nay.message === "Rate limit exceeded"`.
- `bootstrap_free_subscription` creates the local Polar customer with email and display name, then creates the `Free` subscription when missing. When auth marks the user as a restored deleted account, it first uncancels an active/trialing subscription that is still pending period-end cancellation.
- `billing_enqueue_free_subscription_bootstrap` enqueues that bootstrap work through `billing_workpool_bootstrap`, carrying the resolved display name from auth resolution and the optional restored-account billing flag.
- `handle_polar_customer_state_update` is a thin adapter that parses the raw `customer.state_changed` webhook payload, converts it through `billing_polar_webhook_to_customer_state`, and calls `db_apply_polar_customer_state_refresh`. The helper owns the full reconcile flow: snapshot upsert from the canonical `BillingCustomerState`, period-gated monthly credit grant (optimistic meter + `monthly_credit` ingest), and customer deletion when the payload carries `deleted_at` (removes the local customer mapping, local subscription rows, and usage snapshot instead of recreating a blank snapshot). The same helper is replayed on demand by the admin `refresh_from_polar_customer_state` action.

See [Glossary — convex/billing.ts](#glossary--convexbillingts).

## Webhook ownership

Polar webhooks are split by data ownership:

- `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, and `subscription.past_due` update the vendored component's local subscription mirror through the subscription upsert path. This is where subscription fields such as `pendingUpdate` are persisted and cleared.
- `customer.created` is not handled by app-owned webhook code. Local customer rows are created by the supported app flows (`generate_checkout_link` / `bootstrap_free_subscription`) and should not be manually inserted from customer lifecycle webhooks.
- `customer.updated` with `deletedAt`/`deleted_at` and `customer.deleted` remove the local customer mapping and that customer's local subscription rows by Polar customer id.
- `customer.state_changed` updates usage snapshots and enqueues monthly credits from active subscription period data. If its raw payload has `deleted_at`, treat it as an anonymized customer deletion: remove the local customer mapping, that customer's local subscription rows, and that user's usage snapshot instead of deriving a new snapshot or enqueuing credits. Do not use this event to derive scheduled plan changes because its `CustomerState` payload does not include subscription `pendingUpdate`.
- `customer.state_changed` is the sole trigger for enqueueing monthly recurring credits and the canonical refresh path for the local usage snapshot.
- Do not app-rate-limit Polar webhook routes. Signature verification and Polar's delivery semantics are the gate; throttling webhooks can leave local billing state stale.
- `subscription.active` is intentionally not handled by app-owned webhook code. Polar fires it before its customer-meter ledger is populated, so `customersGetState` from that hook would return `activeMeters: []`. Credits become visible immediately because `db_apply_polar_customer_state_refresh` writes an optimistic local meter through `db_apply_optimistic_credit_to_snapshot` in the same mutation that upserts the snapshot, before enqueueing the Polar event; the later `customer.state_changed` reconciles that meter with Polar's authoritative value once Polar's aggregation catches up (~20s).
- The app supports at most one active subscription per user. If a `customer.state_changed` payload reports multiple `active_subscriptions`, treat that as an impossible billing state and throw instead of choosing one.
- Store customer-level meter values (`consumedUnits`, `creditedUnits`, `balance`) on the local snapshot for every plan by resolving the canonical `Press app usage` customer meter from `active_meters`. Store `amountDueCents` from the subscription-level meter when present and `0` otherwise.
- Resolve the canonical customer meter id in this order: (1) the active subscription's meter id; (2) a synced product's metered_unit price meter id; (3) a legacy `meter_credit` benefit on the subscription product; (4) `null` for fresh subscriptions whose first `monthly_credit` event has not yet produced a customer meter.
- Paid active subscriptions with a metered price must always carry a subscription meter. If the payload does not include one, treat that as an impossible billing state and throw instead of saving a partial paid snapshot.
- `Free` subscriptions have no product/subscription meter, so their `amountDueCents` is always `0`. The customer meter is present once `db_apply_polar_customer_state_refresh` has applied the optimistic write through `db_apply_optimistic_credit_to_snapshot`; the next `customer.state_changed` keeps the meter aligned with Polar. Leave `meter: null` only when no subscription has been resolved yet.
- `product.created`, `product.updated`, `benefit.created`, and `benefit.updated` keep the synced product catalog fresh. Unchecked webhook families such as checkout, orders, refunds, benefit grants, seats, members, and organization updates are not part of the current app sync contract.

## Monthly credits engine

The monthly credits engine lives at the `// #region monthly credits` block in [billing.ts](../../../packages/app/convex/billing.ts) and is the only app code path that grants recurring credits for every plan (`Free`, `Pay As You Go`, `Pro`). Polar `meter_credit` benefits are detached from the live products in the Polar dashboard so they never grant credits in parallel.

The Polar `customer.state_changed` webhook is the sole trigger for monthly credits in production; there is no cron-driven reconciliation pass. Trust the webhook to deliver every state change. The admin-only `refresh_from_polar_customer_state` action replays the same helper (`db_apply_polar_customer_state_refresh`) on demand from the Convex dashboard when a webhook was lost or local state looks stale.

- `db_apply_polar_customer_state_refresh` first upserts `billing_usage_snapshots` from the customer-state payload, then runs the monthly credit grant inline in the same mutation when the `BillingCustomerState` includes an active subscription. Fresh `Free` snapshots can be `meter: null` at the upsert point because `Free` has no subscription meter; the inline grant immediately patches the optimistic customer meter when recurring credits apply. The grant is gated on a subscription period transition (first-ever subscription, renewal with a new `currentPeriodStart`, or a new `subscriptionId` after a plan change) so mid-period repeats are skipped. When the state has `deletedAt`, it removes the local customer mapping, local subscription rows, and usage snapshot without granting monthly credits. The shared `db_upsert_usage_snapshot` writer preserves a present meter when Polar reports `active_meters: []` for an active subscription, so a stale empty webhook payload does not clobber the meter that `db_apply_optimistic_credit_to_snapshot` wrote ahead of Polar.
- The inline grant resolves the Polar product by `productId`, reads `billing_get_recurring_credits_cents(product.name)`, and when `recurringAmountCents > 0` first calls `db_apply_optimistic_credit_to_snapshot` to write the credit into `billing_usage_snapshots` locally on the same Convex tick, then enqueues one negative-amount `monthly_credit` event with `externalId` `monthly_credit::<userId>::<subscriptionId>::<periodStart>` through `billing_ingest_events`. It does not call Polar `customersGetState`; the optimistic write makes the credit visible immediately, and the next `customer.state_changed` reconciles the meter once Polar's aggregation catches up. The period-transition gate replaces the previous per-row dedupe key, so a same-period repeat webhook delivery skips both the optimistic write and the workpool enqueue. Polar's immutable usage event plus duplicate detection by `externalId` remains the authority if a duplicate ingest ever does fire.
- `db_apply_optimistic_credit_to_snapshot` (synchronous `MutationCtx` helper) patches the user's `billing_usage_snapshots` row with the credit `meter` (mirroring Polar's accounting: negative `consumedUnits`, positive `balance`). It resolves the meter id through `billing_resolve_customer_meter_id` so the optimistic id matches the one Polar sends in the next `customer.state_changed`. The helper expects the snapshot row to exist because `db_apply_polar_customer_state_refresh` upserts it earlier in the same transaction; missing rows surface a `should_never_happen` error rather than silently no-opping.
- Repeated same-period `customer.state_changed` deliveries (consumption updates, meter recomputes) report the same `(subscriptionId, currentPeriodStart)` and skip the inline grant entirely thanks to the period-transition gate, so the optimistic meter and the Polar event ledger both stay idempotent without any per-row dedupe key.

See [Glossary — monthly credits](#glossary--monthly-credits).

## Credit gating

Credit gating is a read-only start-time check. Backend credit checks live in [billing.ts](../../../packages/app/convex/billing.ts). The gate never reserves, debits, settles, releases, or prunes local credits. It reads the current `billing_usage_snapshots.meter.balance` that was synced from Polar and decides whether the operation may start.

### Plan policy

Keep the plan policy direct at the gate call site:

- `Free` reports `hasCredits: false` whenever `meterBalanceCents < minimumRequiredCents`. Callers map that denial to the literal message `"Insufficient funds"`; keep richer upgrade copy in ad hoc UI queries, not in the gate result.
- `Pay As You Go` and `Pro` always allow; overage becomes Polar-billed usage on the next cycle.

Do not reintroduce a shared `credits_policy_allow_spend` helper for this rule. The intended code shape is the straightforward `product.name === "Free" && meterBalanceCents < minimumRequiredCents` check where the gate needs it. Trust the synced Polar product `name`; do not add a separate plan-name validation helper in the gate.

### Gate APIs

There is one backend gate operation:

- `billing_db_check_credits(ctx, { userId, minimumRequiredCents })` — loads the synced Polar product from `snapshot.subscription.productId`, reads `snapshot.meter?.balance ?? 0`, and returns `_yay: { hasCredits }`. Missing billing state, missing products, and insufficient Free-plan balance return `hasCredits: false`; paid plans return `hasCredits: true` even with a negative balance.
- `internal.billing.check_credits` — `internalQuery` wrapper for action code such as chat routes. It returns the same `_yay: { hasCredits }` shape.

Missing snapshots or subscriptions are treated as `hasCredits: false` in gate helpers. Billing UI hides until the subscription, product list, and usage snapshot are ready.

### Chat start check and usage event

[ai_chat.ts](../../../packages/app/convex/ai_chat.ts) checks credits before LLM work with `minimumRequiredCents: 1`. This applies to the main `/api/chat` stream and the secondary title-generation endpoint. Both signed-in and anonymous users go through this gate. Anonymous users reuse the synthetic snapshot that was seeded at anonymous-user creation.

- On deny the handler returns `402` with `{ message: "Insufficient funds" }`. If the UI needs richer plan-aware copy, add a separate query for that UI surface instead of expanding the gate result.
- On successful finish, chat flows always emit direct `billing_event("ai_usage")` events through `billing_ingest_events` when AI SDK reports non-zero token usage. Signed-in rows go to Polar via the workpool; anonymous rows apply locally to the synthetic snapshot. The main stream emits one event with the captured main-response usage plus inline title usage when a new thread title was generated; the secondary title endpoint emits one title event with `messageId: "title"`.
- Use deterministic `externalId` values built with `composite_id("billing", "ai_usage", userId, threadId, messageId)` so Polar dedupes HTTP retries. For the secondary title endpoint, the final part is the literal `"title"`.
- Keep the token-pricing switch local to `compute_token_usage_cost_cents` in `ai_chat.ts`. Do not recreate a shared entitlements module, exported pricing type, or helper for the current pricing table.
- Do not store chat spend locally. Do not estimate or reserve worst-case cost. Do not stop a live stream when the balance goes below zero in the current implementation; stream cutoff is a future billing-lock feature.

### Inline editor AI check and usage event

[`/api/ai-docs-temp/contextual-prompt`](../../../packages/app/convex/ai_docs_temp.ts) is an authenticated, membership-scoped AI endpoint. Callers must send `membershipId` and a per-request `requestId`; the frontend obtains a Convex auth token from `AppAuthProvider` and sends it in `Authorization`.

- The route rate-limits first, then checks credits with `minimumRequiredCents: 1` before `streamText` for the inline popover path or `generateText` for the Liveblocks contextual resolver JSON path.
- On rate-limit deny it returns `429` with `{ message: "Rate limit exceeded", retryAfterMs }`.
- On credit deny it returns `402` with `{ message: "Insufficient funds" }`.
- On successful finish/completion, it emits one `billing_event("ai_usage")` when AI SDK reports non-zero token usage. The deterministic external id is `composite_id("billing", "ai_usage", userId, "inline_ai", requestId)`, with metadata `threadId: "inline_ai"` and `messageId: requestId`.
- Keep the current inline-AI pricing helper local to `ai_docs_temp.ts` while pricing remains hardcoded.

### Page-save check and usage event

Page saves ([yjs_push_update](../../../packages/app/convex/ai_docs_temp.ts), [save_pages_pending_edit](../../../packages/app/convex/pages_pending_edits.ts), and [restore_snapshot](../../../packages/app/convex/ai_docs_temp.ts)) fail fast before the yjs push or restore write:

1. `billing_db_check_credits(ctx, { userId, minimumRequiredCents: 1 })` — read-only pre-flight. When it returns `hasCredits: false`, the caller returns `_nay` with the literal `"Insufficient funds"` message to the frontend.
2. Run the yjs push; obtain the new sequence.
3. Emit the existing `billing_event("page_save")` through `billing_ingest_events` with `externalId = composite_id("billing", "page_save", userId, pageId, yjsSequence)` and literal `metadata.amount: 1`.

For signed-in users there is no local credit debit after save; Polar usage events and subsequent customer-state refreshes are the only path that changes the synced meter. For anonymous users the shared ingest helper applies the same one-cent event locally after a successful save. Snapshot restore bills only when `write_markdown_to_yjs_sync` produced a new Yjs sequence. Do not reintroduce a shared `credits_PAGE_SAVE_COST_CENTS` constant for the current one-cent page-save rule; keep the literal at the call sites unless the product rule changes.

### Anonymous users

Anonymous users participate in credit gating through a **synthetic `billing_usage_snapshots` row** seeded at user creation. The snapshot mirrors Free-plan limits without touching Polar.

- The snapshot keeps the `subscription` and `meter` objects, but marks them as synthetic with null external ids: `polarCustomerId: null`, `subscription.id: null`, `meter.id: null`. `subscription.productId` reuses the real synced Polar Free product id.
- `billing_db_check_credits` treats anonymous snapshots like regular `Free` snapshots by reading the synced Free `productId` from `subscription.productId` and the current synthetic `meter.balance`. It does not perform any lazy refill on read.
- `reset_due_anonymous_credits` runs daily from `crons.ts` at `00:00 UTC`. Anonymous snapshots store `currentPeriodStart` and `currentPeriodEnd` at UTC midnight boundaries, and the cron refills any anonymous snapshot whose `currentPeriodEnd` day is today.
- Anonymous local application now flows through `billing_ingest_events` and `internal.billing.ingest_anonymous_user_events`, which apply signed `metadata.amount` values directly to the synthetic snapshot (`positive` usage lowers balance, `negative` credits raise balance). Callers are expected to gate first, and the daily cron owns period rollover.
- `billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now })` is idempotent and creates the row only if one does not exist. It is called at anonymous-user creation only and returns `null` after ensuring the row.
- Anonymous usage still does **not** go through Polar `eventsIngest`, but it does go through `billing_ingest_events`, which routes anonymous rows to the local synthetic-snapshot ledger instead of Polar.
- On anonymous-to-signed-in upgrade (`resolve_user`), the synthetic snapshot is deleted. The signed-in Free bootstrap via Polar creates a fresh Polar-backed snapshot.

### UI surface: billing indicator

The billing indicator ([main-app-header-billing-indicator.tsx](../../../packages/app/src/components/main-app-header-billing-indicator.tsx)) consumes the existing billing queries directly:

- `api.billing.get_current_user_subscription`
- `api.billing.get_usage_snapshot`
- `api.billing.list_products`

The indicator displays `usage.meter.balance` as the synced remaining credits. When that balance is below `0`, the component swaps in an alarm color on the remaining value, shows a `TriangleAlert` icon, and wraps the group in a tooltip showing `"Out of funds"`. It does not call a separate backend capability query.

## Function definitions

Use this section as the authoritative glossary for symbols named elsewhere in this skill.

### Glossary — shared/billing.ts

#### `billing_PRODUCTS`

- **Module:** [packages/app/shared/billing.ts](../../../packages/app/shared/billing.ts)
- **Kind:** `const` object keyed by plan id (`Free`, `Pro`, `"Pay As You Go"`).
- **Role:** Canonical plan metadata: Polar-exact `name`, UI `displayName`, `recurringCreditsCents`, optional `meter` block, and legacy `benefits` descriptions for tests and old webhooks.

#### `billing_get_product_order`

- **Module:** [packages/app/shared/billing.ts](../../../packages/app/shared/billing.ts)
- **Signature:** `(productName: string) => number`
- **Role:** Returns the plan's index in the fixed order `Free < Pay As You Go < Pro`, or `Infinity` for unknown names so they sort after known plans.

#### `billing_compare_product_order`

- **Module:** [packages/app/shared/billing.ts](../../../packages/app/shared/billing.ts)
- **Signature:** `(leftProductName: string, rightProductName: string) => number`
- **Role:** Comparator for two product names using `billing_get_product_order`, with a `localeCompare` fallback when both orders are non-finite.

#### `billing_get_recurring_credits_cents`

- **Module:** [packages/app/shared/billing.ts](../../../packages/app/shared/billing.ts)
- **Signature:** `(productName: string) => number`
- **Role:** Returns `billing_PRODUCTS[productName].recurringCreditsCents`, or `0` if the name is not in the catalog. Used by the monthly credit action and billing UI for “included usage” amounts.

#### `billing_get_plan_change_kind`

- **Module:** [packages/app/shared/billing.ts](../../../packages/app/shared/billing.ts)
- **Signature:** `(currentProductName: string, targetProductName: string) => "upgrade" | "downgrade" | null`
- **Role:** Returns `null` if either product is unknown, orders are equal, or the change is not strictly up/down; otherwise returns upgrade vs downgrade from catalog order.

#### `billing_get_product_display_name`

- **Module:** [packages/app/shared/billing.ts](../../../packages/app/shared/billing.ts)
- **Signature:** `(productName: string) => string`
- **Role:** Returns `displayName` from `billing_PRODUCTS` when present, otherwise the raw `productName`. (Useful for UI; not always cited above but part of the same module.)

### Glossary — server/billing.ts

#### `billing_POLAR_METER_EVENT`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Kind:** `const` string, currently `press_usage_event`.
- **Role:** The single Polar meter event name used for all usage charges and credits. App event kinds stay in `billing_Event.name` until `ingest_events` moves them into `metadata.name`.

#### `billing_Event`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Kind:** inferred type alias from `FunctionArgs<typeof internal.billing.ingest_events>["events"][number]`.
- **Role:** Canonical app-owned billing event union. Variants are discriminated by `name` (`manual_credit`, `page_save`, `monthly_credit`, `ai_usage`) and otherwise mirror the Polar event envelope fields the app supports: `externalCustomerId`, `externalId`, and event-specific `metadata`.

#### `billing_event`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Signature:** `<const T extends billing_Event>(event: T) => T`
- **Role:** Typed identity helper that checks a literal event against `billing_Event` while preserving the exact discriminated variant. It is not a full builder; call sites construct metadata explicitly and use `composite_id("billing", ...)` for `externalId`.

### Glossary — convex/billing.ts

#### `billing`

- **Module:** [packages/app/convex/billing.ts](../../../packages/app/convex/billing.ts)
- **Kind:** `Polar<DataModel>` instance (`export const billing`).
- **Role:** Vendored `@convex-dev/polar` integration: `getUserInfo` restricts billing to signed-in Convex users; exposes `billing.api()`, `billing.listProducts`, webhook registration, and Polar server mode from `POLAR_SERVER`.

#### `list_products`

- **Kind:** public `query`
- **Args / returns:** `{}` → array of synced Polar products (empty when user is not signed in).
- **Role:** Billing panel catalog; delegates to `billing.listProducts` after auth check.

#### `get_current_user_subscription`

- **Kind:** public `query`
- **Args / returns:** `{}` → current subscription document from the Polar component **without** the nested `product` field, or `null`.
- **Role:** Active subscription mirror for UI; avoids duplicating full product payloads when `list_products` already loaded catalog.

#### `get_usage_snapshot`

- **Kind:** public `query`
- **Args / returns:** `{}` → `billing_usage_snapshots` doc for the signed-in user or `null`.
- **Role:** Local snapshot (subscription period, meter, balances from webhook-derived state) for the billing panel.

#### `billing_db_check_credits`

- **Kind:** exported async helper
- **Args:** `(ctx: QueryCtx | MutationCtx, { userId, minimumRequiredCents })`
- **Role:** Read-only credit gate for mutations/queries that need to fail before doing paid work. Returns `_yay: { hasCredits: false }` on missing billing state, missing products, or insufficient Free-plan balance; paid plans are allowed even with negative balance.

#### `check_credits`

- **Kind:** `internalQuery`
- **Args:** `{ userId, minimumRequiredCents }`
- **Role:** Action-facing wrapper around `billing_db_check_credits`, used by chat and inline-editor HTTP flows before LLM work starts. HTTP callers convert `hasCredits: false` into `402` with `{ message: "Insufficient funds" }`.

#### `billing_db_ensure_anonymous_user_usage_snapshot`

- **Kind:** exported async helper (`MutationCtx`)
- **Args:** `(ctx, { userId, now })`
- **Role:** Idempotent creator of the anonymous synthetic `billing_usage_snapshots` row. Seeded at anonymous-user creation only. Uses null external ids (`polarCustomerId`, `subscription.id`, `meter.id`) plus the real synced Free `productId`, aligns the stored period bounds to UTC midnight, and returns `null` after ensuring the row.

#### `reset_due_anonymous_credits`

- **Kind:** `internalMutation`
- **Args:** `{ _test_now?: number }`
- **Role:** Daily UTC-midnight refill for anonymous synthetic snapshots. When a snapshot's `currentPeriodEnd` day matches the current UTC day, it resets the meter back to the Free recurring credit amount and advances the stored 30-day period to the next UTC-midnight boundary.

#### `generate_checkout_link`

- **Kind:** public `action`
- **Role:** Creates a Polar checkout session for a synced product; validates origin and success URL against `allowed_origins`. Used for `Free -> paid` and new paid signups.

#### `change_current_subscription`

- **Kind:** public `action`
- **Role:** Changes subscription between paid plans (upgrade immediate, downgrade end-of-cycle per Polar / app rules). Does not replace checkout for `Free -> paid`. On success it returns `_yay: null`; the local subscription mirror is updated later by the subscription webhook.

#### `generate_customer_portal_url`

- **Kind:** public `action`
- **Role:** Returns a Polar customer portal session URL for self-serve billing management.

#### `bootstrap_free_subscription`

- **Kind:** `internalAction`
- **Args:** `{ userId, email, name, restoreCanceledSubscription? }`
- **Role:** Ensures Polar customer exists with the user's email and display name, inserts local customer row, creates `Free` subscription in Polar and local mirror when the user has no current subscription. If `restoreCanceledSubscription` is true and the current Polar subscription mirror is active/trialing with `cancelAtPeriodEnd: true`, it cancels any retry row, calls Polar with `cancelAtPeriodEnd: false`, and updates the local mirror from Polar's response. Invoked via workpool.

#### `billing_enqueue_free_subscription_bootstrap`

- **Kind:** async helper (`export async function`)
- **Args:** `(ctx: ActionCtx, { userId, email, name, restoreCanceledSubscription? })`
- **Role:** Enqueues `internal.billing.bootstrap_free_subscription` on `billing_workpool_bootstrap` (single-flight style, retries on failure) with the display name resolved during auth and the optional account-recovery billing restore flag.

#### `handle_polar_customer_state_update`

- **Kind:** `internalMutation`
- **Args:** `{ payload }` (raw Polar `customer.state_changed` webhook payload, intentionally `v.any()` so strict local validators do not reject future Polar payload changes; read the raw snake_case fields Polar sends rather than SDK camelCase fields)
- **Role:** Thin webhook adapter: converts the snake_case payload through `billing_polar_webhook_to_customer_state` and calls `db_apply_polar_customer_state_refresh`. All snapshot and credit logic lives in the helper. Does not persist subscription mirror fields such as `pendingUpdate`.

#### `db_apply_polar_customer_state_refresh`

- **Module:** [packages/app/convex/billing.ts](../../../packages/app/convex/billing.ts)
- **Kind:** synchronous helper function (`async function`) called with a `MutationCtx`; not a registered Convex function.
- **Args:** `(ctx, { state: BillingCustomerState, syncedAt })`
- **Role:** Single source of truth for reconciling a canonical `BillingCustomerState` into local billing state. On `state.deletedAt` it calls `db_delete_customer_state` and returns. Otherwise it guards against multiple active subscriptions, captures the previous snapshot's subscription, resolves `product` and `syncedProducts` from the Polar component, upserts the snapshot via `build_usage_snapshot` + `db_upsert_usage_snapshot`, and runs the monthly credit grant inline when an active subscription is present and the period changed (`previousSubscription === null || previousSubscription.id !== subscription.id || previousSubscription.currentPeriodStart !== subscription.currentPeriodStart`). Called from `handle_polar_customer_state_update` (webhook path) and from `apply_polar_customer_state_refresh` (admin replay path).

#### `apply_polar_customer_state_refresh`

- **Kind:** `internalMutation` (admin region)
- **Args:** `{ state, syncedAt: number }` where `state` is validated as the full canonical `BillingCustomerState` shape (camelCase fields plus ISO-string dates) at the Convex boundary.
- **Role:** Thin mutation wrapper around `db_apply_polar_customer_state_refresh` so actions can drive the full refresh flow from a `BillingCustomerState` they obtained out-of-band (e.g. the admin action pulling `CustomerState` directly from Polar via `customersGetState`). Keep this boundary strict because the admin replay path owns the canonical local `BillingCustomerState` contract; unlike vendor webhooks, this payload is app-shaped.

#### `refresh_from_polar_customer_state`

- **Kind:** `internalAction` (admin region)
- **Args:** `{ userId: Id<"users"> }`
- **Role:** Admin-only replay path. Reads the authoritative Polar `CustomerState` via `billing.getCustomerState`, converts it through `billing_polar_sdk_to_db_data`, then calls `internal.billing.apply_polar_customer_state_refresh` with `syncedAt: Date.now()`. Safe to run mid-period — the helper's period-transition gate skips the credit grant when `(subscriptionId, currentPeriodStart)` is unchanged, and Polar's deterministic `monthly_credit::<userId>::<subscriptionId>::<periodStart>` `externalId` dedupes duplicate grants at Polar's end. Intended to be triggered manually from the Convex dashboard when a webhook was lost or local state looks stale.

### Glossary — event ingestion

#### `billing_ingest_events`

- **Kind:** exported async helper in [packages/app/convex/billing.ts](../../../packages/app/convex/billing.ts)
- **Signature:** `(ctx: ActionCtx | MutationCtx, { userEvents: Array<{ event: billing_Event; user: Doc<"users"> }> }) => Promise<void>`
- **Role:** Mandatory local entrypoint for emitting billing usage events. It routes signed-in rows to `billing_workpool_usage_event` and routes anonymous rows to `internal.billing.ingest_anonymous_user_events`, so call sites no longer branch on billing transport details.

#### `ingest_anonymous_user_events`

- **Kind:** `internalMutation`
- **Args:** `{ userEvents: Array<{ event: billing_Event; user: Doc<"users"> }> }`
- **Role:** The only local synthetic-snapshot apply path. It reads `event.metadata.amount` as a signed delta against the anonymous snapshot, patches the row in place, and logs/skips malformed or non-anonymous rows instead of returning a caller-visible billing result.

#### `ingest_events`

- **Kind:** `internalAction`
- **Args:** `{ events: billing_Event[] }`
- **Role:** Performs the actual Polar `eventsIngest` call outside `NODE_ENV === "test"`. For each app event, passes through `externalCustomerId`, `externalId`, and metadata, rewrites Polar `name` to `billing_POLAR_METER_EVENT`, and stores the app event name in `metadata.name`.

### Glossary — monthly credits

#### Inline grant inside `db_apply_polar_customer_state_refresh`

- **Module:** [packages/app/convex/billing.ts](../../../packages/app/convex/billing.ts)
- **Kind:** inlined branch of `db_apply_polar_customer_state_refresh` (synchronous `MutationCtx` helper); no separate exported function.
- **Role:** After upserting `billing_usage_snapshots` from the canonical `BillingCustomerState`, resolves the Polar product, computes `billing_get_recurring_credits_cents(product.name)`, and when `recurringAmountCents > 0` and the period transition gate passes, calls `db_apply_optimistic_credit_to_snapshot` to write the credit into the local snapshot in the same transaction, then enqueues a single negative-amount `monthly_credit` billing event through `billing_ingest_events`. It does not call Polar `customersGetState`; the optimistic write makes the credit visible immediately, and the next `customer.state_changed` reconciles the meter once Polar's aggregation catches up. Polar's duplicate detection by the deterministic `monthly_credit::<userId>::<subscriptionId>::<periodStart>` `externalId` is the authority for ledger idempotency; the period-transition gate prevents re-running the grant on same-period repeat webhooks (from either the webhook path or the admin replay).

#### `db_apply_optimistic_credit_to_snapshot`

- **Module:** [packages/app/convex/billing.ts](../../../packages/app/convex/billing.ts)
- **Kind:** synchronous helper function (`async function`) called with a `MutationCtx`; not a registered Convex function.
- **Args:** `(ctx, { userId, syncedProducts, product, amountCents, syncedAt })`
- **Role:** Patches the user's `billing_usage_snapshots` row with a credit `meter` mirroring Polar's accounting (`consumedUnits -= amountCents`, `balance += amountCents`, preserving prior `creditedUnits` and `amountDueCents` via spread; defaults `creditedUnits: 0` and `amountDueCents: 0` when no prior meter exists), so the grant updates the UI on the same Convex tick instead of waiting ~20s for Polar's `customer.state_changed`. Resolves the meter id through `billing_resolve_customer_meter_id` so the optimistic id matches the one Polar later sends. Expects the snapshot row to exist because `db_apply_polar_customer_state_refresh` upserts it earlier in the same transaction; missing rows surface a `should_never_happen` error.

## Auth bootstrap trigger

The auth-side trigger lives in [users.ts](../../../packages/app/convex/users.ts).

- `/api/auth/resolve-user` resolves or creates the Convex user, writes Clerk `external_id`, then enqueues the `Free` subscription bootstrap with the resolved display name. When it reclaimed a tombstoned account, it includes `restoreCanceledSubscription: true` so billing can undo a deletion-triggered period-end cancellation.
- Because bootstrap is enqueued through the workpool, a newly resolved signed-in user can briefly exist before the `Free` subscription appears locally.

## Testing Clerk + Polar signup

When you test signup flows that must also create a Polar customer, do not use Clerk's `example.com` sample addresses. Use a real email domain that accepts mail, such as `gmail.com`, while still keeping Clerk's test suffix.

> Clerk docs: "Any email with the `+clerk_test` subaddress is a test email address. No emails will be sent ... code `424242`."

- Use addresses like `yourname+clerk_test@gmail.com` or `yourname+clerk_test@outlook.com`.
- Use Clerk's verification code `424242`.
- Keep the `+clerk_test` suffix so Clerk stays in test-email mode.
- Keep the domain valid for Polar customer creation. `example.com` can be rejected by Polar validation.
- Source: <https://clerk.com/docs/guides/development/testing/test-emails-and-phones>

## Billing UI

The main billing UI lives in [billing-account-management-panel.tsx](../../../packages/app/src/components/billing/billing-account-management-panel.tsx).

- Anonymous users do not participate in billing UI today. The panel skips billing queries for them and shows a sign-in message instead.
- Signed-in users see the active plan, other plans, and a `Manage subscription` entrypoint.
- `Free -> paid` uses checkout through [billing-checkout-button.tsx](../../../packages/app/src/components/billing/billing-checkout-button.tsx), passing the current `Free` subscription id.
- `paid -> Free` and `paid -> paid` use [billing-change-plan-button.tsx](../../../packages/app/src/components/billing/billing-change-plan-button.tsx), which calls `change_current_subscription`.

## Product and usage presentation

- [billing-product-card.tsx](../../../packages/app/src/components/billing/billing-product-card.tsx) renders included usage from `billing_get_recurring_credits_cents` (the Convex monthly credits engine is the only code path that grants recurring credits, while Polar event idempotency is the authority for already-granted periods).
- [billing-active-plan.tsx](../../../packages/app/src/components/billing/billing-active-plan.tsx) renders due amount and remaining credits from the local usage snapshot, and uses `billing_get_recurring_credits_cents` for the included-usage line.
- The billing panel uses the local usage snapshot populated from `customer.state_changed` to show current due amount, remaining credits, and renewal timing. It uses the subscription mirror's `pendingUpdate` field from subscription webhooks to show scheduled plan changes.

## Account deletion billing behavior

- Normal user-facing account deletion schedules retryable work that cancels the current paid subscription at the close of the current billing period instead of revoking it immediately.
- Billing owns `billing_cancel_polar_subscription_jobs` as the scheduler row for that work. Keep one row per user, replace the stored `jobId` when you reschedule, and clear the row only when the matching work finishes successfully or an explicit cancel removes it.
- Subscription mirror rows remain Polar-owned during normal account deletion and scheduled cancellation. Clear them only when Polar reports customer deletion through customer deletion webhooks or a `customer.state_changed` payload with `deleted_at`.
- `billing_usage_snapshots` are mirrored local billing state, not billing authority. Keep them through phase 1 and delete them only during phase 2 of account deletion.
- Restoring the account during retention enqueues billing bootstrap with `restoreCanceledSubscription: true`. Billing cancels any stored retry row and asks Polar to uncancel the subscription if it is still active/trialing and pending period-end cancellation; if no current subscription remains, bootstrap creates a new `Free` subscription. Do not recreate a paid subscription after the old one has fully ended.
- Direct admin hard delete now uses `purgeUserRecord` as the single operator flag:
- `purgeUserRecord: false` keeps the immediate local hard-delete path, keeps the final tombstoned user row, and schedules the same retryable period-end cancellation used by the normal delete flow.
- `purgeUserRecord: true` cancels any scheduled period-end cancellation first, revokes the subscription immediately, requests immediate Polar customer deletion with `anonymize: false`, and purges the final local tombstone. Polar emits `customer.deleted` for `anonymize: false`; if a future GDPR erasure flow needs `anonymize: true`, treat that as a separate product flow because Polar scrubs PII by updating the customer with `deleted_at` and emits `customer.updated` plus `customer.state_changed` instead. The local Polar customer mapping may briefly remain until Polar reports deletion through `customer.deleted` or a `deleted_at` customer webhook.

# Operational billing rules

- Treat Polar product names as exact identifiers in app code: `Free`, `Pay As You Go`, and `Pro`.
- Treat Polar benefit descriptions as exact identifiers in app code: `Free Included Usage`, `Free Usage`, and `Pro Included Usage`. These names remain stable in the catalog because tests and historical webhook payloads still reference them.
- Treat the Polar meter display name `Press app usage` as the canonical usage meter name in the catalog.
- Treat the Polar usage event name `press_usage_event` as the canonical event name for usage ingestion.
- Treat `manual_credit`, `page_save`, `monthly_credit`, and `ai_usage` as the canonical usage event names. When listing billing event names in validators, tuple unions, tests, docs, or specs, put `manual_credit` first because it is the manual/admin variant, then list `page_save`, `monthly_credit`, and `ai_usage`. Usage-event `externalId` prefixes must follow those names exactly and use `::` as the only composite-id separator (`manual_credit::...`, `page_save::...`, `monthly_credit::...`, `ai_usage::...`).
- Treat Polar meter amounts as a signed sum ledger: positive `metadata.amount` values are usage that consumes/decreases balance, while negative values are credits or payments that increase balance. `grant_credit` normalizes dashboard input to a negative `manual_credit` event by default. QA/admin drain flows may pass `allowNegative: true` with a negative `amount`, which records a positive manual usage event and reduces the balance.
- Keep the current page-save usage amount as a literal `1` at each call site, and keep the current chat token-pricing switch local to `packages/app/convex/ai_chat.ts`.
- Keep `meter_credit` benefits detached from every Polar product. The Convex monthly credits engine is the only code path that grants recurring credits; running both would double-grant.
- Prefer Polar-configured prices over hardcoded monetary logic in the repo. The code usually reads plan names and prices from synced Polar products. Per-plan recurring credit amounts are the exception: they live in `billing_PRODUCTS.<plan>.recurringCreditsCents` and are applied by the monthly credits engine.

# TODO / known gaps

- Decide before GA whether the current hardcoded chat token rates and literal one-cent page-save amount are final product pricing or placeholders.
- Move usage snapshot ownership into the vendored Polar component when that migration happens.
- Reconcile repo behavior and business policy whenever plan allowances or billing-cycle credit behavior change.
