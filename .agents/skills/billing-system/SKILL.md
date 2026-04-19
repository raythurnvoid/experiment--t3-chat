---
name: billing-system
description: Billing system guidelines for the Polar-backed plan catalog, customer and subscription bootstrap, checkout vs subscription-change behavior, usage and credit sync, billing UI, and future billing-lock work. Use when modifying billing products or product copy, Polar configuration assumptions, billing backend flows, billing account-management UI, usage snapshot handling, or billing-related product rules.
---

# Overview

Polar is intended to be the billing source of truth for products, customers, subscriptions, and usage-derived billing state.

The app mirrors enough billing state locally to drive UI and app behavior. In practice, the repo stores a synced product catalog, synced customers and subscriptions through the vendored Polar component, and a local usage snapshot derived from Polar customer-state webhook payloads.

Subscription lifecycle webhooks are the authoritative sync path for the local subscription mirror. `customer.state_changed` is deliberately narrower: it owns usage snapshots and recurring monthly-credit enqueueing, but it does not infer scheduled plan changes such as `pendingUpdate`.

# Canonical product behavior

## Plans

### `Free`

- Give each signed-in user a `Free` subscription after account resolution.
- Include `€10` of usage every billing month.
- Eventually lock the user once the included usage is exhausted. That lock is not implemented today.

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
- `billing_Event` is inferred from the `ingest_events` action validator and is the source-of-truth discriminated union for app-owned billing usage events keyed by `name`: `page_save`, `monthly_credit`, and `manual_credit`.
- `billing_Event` is the only supported billing usage event shape. It mirrors Polar's event fields with `{ name, externalCustomerId, externalId, metadata }`, except `name` is the app event name; `ingest_events` rewrites that field to the single Polar meter event and stores the app event name in `metadata.name`.
- `billing_event` is a typed identity helper for preserving the narrow `billing_Event` variant at call sites. It does not build full event payloads; callers own the metadata they emit.
- Usage-event `externalId` values are built directly with the shared `composite_id("billing", ...)` helper. Its `AppCompositeIds.billing` tuple union keeps billing IDs strict and always joins parts with `::`; keep emitted IDs aligned with the canonical event-name prefixes.
- `billing_ingest_events` is the mandatory exported local emission helper for billing usage events. It accepts `billing_Event[]` and always enqueues `ingest_events` on `billing_workpool_usage_event`, which uses the same long retry policy as cancellation (`10min` initial backoff, `1.2` base, unlimited attempts). The action is the only code path that should call Polar `eventsIngest`.

See [Glossary — server/billing.ts](#glossary--serverbillingts) and [Glossary — event ingestion](#glossary--event-ingestion) for precise signatures and behavior.

## Backend ownership

The backend billing module lives in [billing.ts](../../../packages/app/convex/billing.ts).

- `billing` wraps the vendored Polar component and currently allows only signed-in users through `getUserInfo`, returning the Convex user id, email, and app display name for Polar customer creation.
- `list_products`, `get_current_user_subscription`, and `get_usage_snapshot` provide the billing panel data.
- `generate_checkout_link` creates Polar checkout sessions and sends the current display name when the vendored Polar helper needs to create a missing customer.
- `change_current_subscription` handles paid-plan changes, calls Polar with the correct immediate-upgrade or next-period-downgrade behavior, then waits for the subscription webhook to update the local subscription row. `Free -> paid` is intentionally not handled there and goes through checkout instead.
- `generate_customer_portal_url` opens the Polar customer portal.
- `bootstrap_free_subscription` creates the local Polar customer with email and display name, then creates the `Free` subscription when missing.
- `billing_enqueue_free_subscription_bootstrap` enqueues that bootstrap work through `billing_workpool_bootstrap`, carrying the resolved display name from auth resolution.
- `handle_polar_customer_state_update` ingests the raw `customer.state_changed` webhook payload into `billing_usage_snapshots` by reading the snake_case fields Polar sends, then triggers the monthly credits engine for that user when the required subscription fields are present. When Polar reports an anonymized customer deletion through `deleted_at`, it removes the local customer mapping, local subscription rows, and usage snapshot instead of recreating a blank snapshot.

See [Glossary — convex/billing.ts](#glossary--convexbillingts).

## Webhook ownership

Polar webhooks are split by data ownership:

- `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, and `subscription.past_due` update the vendored component's local subscription mirror through the subscription upsert path. This is where subscription fields such as `pendingUpdate` are persisted and cleared.
- `customer.created` is not handled by app-owned webhook code. Local customer rows are created by the supported app flows (`generate_checkout_link` / `bootstrap_free_subscription`) and should not be manually inserted from customer lifecycle webhooks.
- `customer.updated` with `deletedAt`/`deleted_at` and `customer.deleted` remove the local customer mapping and that customer's local subscription rows by Polar customer id.
- `customer.state_changed` updates usage snapshots and enqueues monthly credits from active subscription period data. If its raw payload has `deleted_at`, treat it as an anonymized customer deletion: remove the local customer mapping, that customer's local subscription rows, and that user's usage snapshot instead of deriving a new snapshot or enqueuing credits. Do not use this event to derive scheduled plan changes because its `CustomerState` payload does not include subscription `pendingUpdate`.
- The app supports at most one active subscription per user. If a `customer.state_changed` payload reports multiple `active_subscriptions`, treat that as an impossible billing state and throw instead of choosing one.
- `Free` subscriptions intentionally have no product/subscription meters. Save their active subscription snapshot with `meter: null` and still enqueue monthly credits; do not infer a `Free` meter from customer-level `active_meters`.
- Paid active subscriptions must resolve to a usage meter from the subscription meter rows or the product's credit benefit meter for historical payloads. If the app cannot resolve a paid plan's usage meter, treat that as an impossible billing state and throw instead of saving a partial paid snapshot.
- `product.created`, `product.updated`, `benefit.created`, and `benefit.updated` keep the synced product catalog fresh. Unchecked webhook families such as checkout, orders, refunds, benefit grants, seats, members, and organization updates are not part of the current app sync contract.

## Monthly credits engine

The monthly credits engine lives at the `// #region monthly credits` block in [billing.ts](../../../packages/app/convex/billing.ts) and is the only app code path that grants recurring credits for every plan (`Free`, `Pay As You Go`, `Pro`). Polar `meter_credit` benefits are detached from the live products in the Polar dashboard so they never grant credits in parallel.

The Polar `customer.state_changed` webhook is the sole trigger for monthly credits; there is no cron-driven reconciliation pass. Trust the webhook to deliver every state change.

- `handle_polar_customer_state_update` upserts `billing_usage_snapshots`, saving `meter: null` for `Free` subscriptions and paid-plan meter details when they are resolvable. When the webhook payload includes an active subscription, it enqueues `grant_monthly_credits` on `billing_workpool_usage_event` with `userId`, `subscriptionId`, `productId`, and `periodStart` read from Polar's raw snake_case payload (`external_id`, `active_subscriptions`, `product_id`, `current_period_start`). When the payload has `deleted_at`, it removes the local customer mapping, local subscription rows, and usage snapshot without enqueueing monthly credits.
- `grant_monthly_credits` (`internalAction`) resolves the Polar product by `productId`, reads `billing_get_recurring_credits_cents(product.name)`, and when `recurringAmountCents > 0` queues one negative-amount `monthly_credit` event with `externalId` `monthly_credit::<userId>::<subscriptionId>::<periodStart>`. `ingest_events` performs the Polar `eventsIngest` call under `billing_POLAR_METER_EVENT` / `press_usage_event`. Polar's immutable usage event plus duplicate detection is the authority for whether that period was already granted.
- Repeated `customer.state_changed` deliveries for the same `(user, subscription, period)` may enqueue the same action multiple times. Treat this as intentional: Polar reports the later ingests as duplicates, so the billing ledger stays idempotent without any local snapshot cursor.

See [Glossary — monthly credits](#glossary--monthly-credits).

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
- **Role:** Canonical app-owned billing event union. Variants are discriminated by `name` (`page_save`, `monthly_credit`, `manual_credit`) and otherwise mirror the Polar event envelope fields the app supports: `externalCustomerId`, `externalId`, and event-specific `metadata`.

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
- **Args:** `{ userId, email, name }`
- **Role:** Ensures Polar customer exists with the user's email and display name, inserts local customer row, creates `Free` subscription in Polar and local mirror when the user has no subscription. Invoked via workpool.

#### `billing_enqueue_free_subscription_bootstrap`

- **Kind:** async helper (`export async function`)
- **Args:** `(ctx: ActionCtx, { userId, email, name })`
- **Role:** Enqueues `internal.billing.bootstrap_free_subscription` on `billing_workpool_bootstrap` (single-flight style, retries on failure) with the display name resolved during auth.

#### `handle_polar_customer_state_update`

- **Kind:** `internalMutation`
- **Args:** `{ payload }` (raw Polar `customer.state_changed` webhook payload, intentionally `v.any()` so strict local validators do not reject future Polar payload changes; read the raw snake_case fields Polar sends rather than SDK camelCase fields)
- **Role:** Maps webhook customer to Convex `userId`, updates `billing_usage_snapshots` (`Free` subscription with `meter: null`, or paid subscription plus resolved meter snapshot), then enqueues `grant_monthly_credits` when an active subscription is present. If `deleted_at` is set, removes the local customer mapping, local subscription rows, and usage snapshot instead. Sole trigger for monthly credits. Does not persist subscription mirror fields such as `pendingUpdate`.

### Glossary — event ingestion

#### `billing_ingest_events`

- **Kind:** exported async helper in [packages/app/convex/billing.ts](../../../packages/app/convex/billing.ts)
- **Signature:** `(ctx: ActionCtx | MutationCtx, { events: billing_Event[] }) => Promise<WorkId>`
- **Role:** Mandatory local entrypoint for emitting billing usage events. It enqueues `internal.billing.ingest_events` on `billing_workpool_usage_event` so Polar ingest failures use the long retry policy before the actual API call runs.

#### `ingest_events`

- **Kind:** `internalAction`
- **Args:** `{ events: billing_Event[] }`
- **Role:** Performs the actual Polar `eventsIngest` call outside `NODE_ENV === "test"`. For each app event, passes through `externalCustomerId`, `externalId`, and metadata, rewrites Polar `name` to `billing_POLAR_METER_EVENT`, and stores the app event name in `metadata.name`.

### Glossary — monthly credits

#### `grant_monthly_credits`

- **Kind:** `internalAction`
- **Args:** `{ userId, subscriptionId, productId, periodStart }`
- **Role:** Resolves the product, computes the recurring credit amount, and queues a `monthly_credit` billing event with a negative amount when credits are due. The event `externalId` plus Polar duplicate detection inside `ingest_events` is the authority for whether that period was already granted.

## Auth bootstrap trigger

The auth-side trigger lives in [users.ts](../../../packages/app/convex/users.ts).

- `/api/auth/resolve-user` resolves or creates the Convex user, writes Clerk `external_id`, then enqueues the `Free` subscription bootstrap with the resolved display name.
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
- Restoring the account during retention does not undo the scheduled cancellation.
- Direct admin hard delete now uses `purgeUserRecord` as the single operator flag:
- `purgeUserRecord: false` keeps the immediate local hard-delete path, keeps the final tombstoned user row, and schedules the same retryable period-end cancellation used by the normal delete flow.
- `purgeUserRecord: true` cancels any scheduled period-end cancellation first, revokes the subscription immediately, requests immediate Polar customer deletion with `anonymize: false`, and purges the final local tombstone. Polar emits `customer.deleted` for `anonymize: false`; if a future GDPR erasure flow needs `anonymize: true`, treat that as a separate product flow because Polar scrubs PII by updating the customer with `deleted_at` and emits `customer.updated` plus `customer.state_changed` instead. The local Polar customer mapping may briefly remain until Polar reports deletion through `customer.deleted` or a `deleted_at` customer webhook.

# Operational billing rules

- Treat Polar product names as exact identifiers in app code: `Free`, `Pay As You Go`, and `Pro`.
- Treat Polar benefit descriptions as exact identifiers in app code: `Free Included Usage`, `Free Usage`, and `Pro Included Usage`. These names remain stable in the catalog because tests and historical webhook payloads still reference them.
- Treat the Polar meter display name `Press app usage` as the canonical usage meter name in the catalog.
- Treat the Polar usage event name `press_usage_event` as the canonical event name for usage ingestion.
- Treat `page_save`, `monthly_credit`, and `manual_credit` as the canonical usage event names. Usage-event `externalId` prefixes must follow those names exactly and use `::` as the only composite-id separator (`page_save::...`, `monthly_credit::...`, `manual_credit::...`).
- Keep `meter_credit` benefits detached from every Polar product. The Convex monthly credits engine is the only code path that grants recurring credits; running both would double-grant.
- Prefer Polar-configured prices over hardcoded monetary logic in the repo. The code usually reads plan names and prices from synced Polar products. Per-plan recurring credit amounts are the exception: they live in `billing_PRODUCTS.<plan>.recurringCreditsCents` and are applied by the monthly credits engine.

# TODO / known gaps

- Enforce the `Free` plan lock once the included usage is exhausted.
- Define and implement anonymous-user billing and limits so anonymous users mirror `Free`-plan limits.
- Move usage snapshot ownership into the vendored Polar component when that migration happens.
- Reconcile repo behavior and business policy whenever plan allowances or billing-cycle credit behavior change.
