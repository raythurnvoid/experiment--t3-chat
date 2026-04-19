---
name: billing-system
description: Billing system guidelines for the Polar-backed plan catalog, customer and subscription bootstrap, checkout vs subscription-change behavior, usage and credit sync, billing UI, and future billing-lock work. Use when modifying billing products or product copy, Polar configuration assumptions, billing backend flows, billing account-management UI, usage snapshot handling, or billing-related product rules.
---

# Overview

Polar is intended to be the billing source of truth for products, customers, subscriptions, and usage-derived billing state.

The app mirrors enough billing state locally to drive UI and app behavior. In practice, the repo stores a synced product catalog, synced customers and subscriptions through the vendored Polar component, and a local usage snapshot derived from Polar customer-state webhook payloads.

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
- `billing_Event` is inferred from the `ingest_events` action validator and is the source-of-truth discriminated union for app-owned billing usage events keyed by `name`: `page_save`, `monthly_grant`, and `manual_credit`.
- `billing_Event` is the only supported billing usage event shape. It mirrors Polar's event fields with `{ name, externalCustomerId, externalId, metadata }`, except `name` is the app event name; `ingest_events` rewrites that field to the single Polar meter event and stores the app event name in `metadata.name`.
- `billing_event` is a typed identity helper for preserving the narrow `billing_Event` variant at call sites. It does not build full event payloads; callers own the metadata they emit.
- `billing_page_save_event_external_id`, `billing_monthly_grant_event_external_id`, and `billing_manual_credit_event_external_id` are the only supported helpers for usage-event `externalId` construction. They wrap the shared strict `create_composite_id` tuple helper; keep those billing helpers aligned with the canonical event-name prefixes.
- `billing_ingest_events` is the mandatory exported local emission helper for billing usage events. It accepts `billing_Event[]` and always enqueues `ingest_events` on `billing_workpool_usage_event`, which uses the same long retry policy as cancellation (`10min` initial backoff, `1.2` base, unlimited attempts). The action is the only code path that should call Polar `eventsIngest`.

See [Glossary — server/billing.ts](#glossary--serverbillingts) and [Glossary — event ingestion](#glossary--event-ingestion) for precise signatures and behavior.

## Backend ownership

The backend billing module lives in [billing.ts](../../../packages/app/convex/billing.ts).

- `billing` wraps the vendored Polar component and currently allows only signed-in users through `getUserInfo`.
- `list_products`, `get_current_user_subscription`, and `get_usage_snapshot` provide the billing panel data.
- `generate_checkout_link` creates Polar checkout sessions.
- `change_current_subscription` handles paid-plan changes. `Free -> paid` is intentionally not handled there and goes through checkout instead.
- `generate_customer_portal_url` opens the Polar customer portal.
- `bootstrap_free_subscription` creates the local Polar customer and the `Free` subscription when missing.
- `billing_enqueue_free_subscription_bootstrap` enqueues that bootstrap work through `billing_workpool_bootstrap`.
- `handle_polar_customer_state_update` ingests the `customer.state_changed` webhook payload into `billing_usage_snapshots` and then triggers the monthly credits engine for that user.

See [Glossary — convex/billing.ts](#glossary--convexbillingts).

## Monthly credits engine

The monthly credits engine lives at the `// #region monthly credits` block in [billing.ts](../../../packages/app/convex/billing.ts) and is the only app code path that grants recurring credits for every plan (`Free`, `Pay As You Go`, `Pro`). Polar `meter_credit` benefits are detached from the live products in the Polar dashboard so they never grant credits in parallel.

The Polar `customer.state_changed` webhook is the sole trigger for monthly grants; there is no cron-driven reconciliation pass. Trust the webhook to deliver every state change.

- `handle_polar_customer_state_update` upserts `billing_usage_snapshots` and, when the webhook payload includes an active subscription, enqueues `grant_monthly_credits` on `billing_workpool_usage_event` with `userId`, `subscriptionId`, `productId`, and `periodStart` taken directly from the Polar payload.
- `grant_monthly_credits` (`internalAction`) resolves the Polar product by `productId`, reads `billing_get_recurring_credits_cents(product.name)`, and when `recurringAmountCents > 0` queues one negative-amount `monthly_grant` event with `externalId` `monthly_grant:<userId>:<subscriptionId>:<periodStart>`. `ingest_events` performs the Polar `eventsIngest` call under `billing_POLAR_METER_EVENT` / `press_usage_event`. Polar's immutable usage event plus duplicate detection is the authority for whether that period was already granted.
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
- **Role:** Returns `billing_PRODUCTS[productName].recurringCreditsCents`, or `0` if the name is not in the catalog. Used by the monthly grant action and billing UI for “included usage” amounts.

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
- **Role:** Canonical app-owned billing event union. Variants are discriminated by `name` (`page_save`, `monthly_grant`, `manual_credit`) and otherwise mirror the Polar event envelope fields the app supports: `externalCustomerId`, `externalId`, and event-specific `metadata`.

#### `billing_event`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Signature:** `<const T extends billing_Event>(event: T) => T`
- **Role:** Typed identity helper that checks a literal event against `billing_Event` while preserving the exact discriminated variant. It is not a full builder; call sites construct metadata explicitly and use the external-id helpers for `externalId`.

#### `billing_page_save_event_external_id`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Signature:** `(args: { userId, pageId, newSequence }) => string`
- **Role:** Builds `page_save:<userId>:<pageId>:<newSequence>` for page-save idempotency.

#### `billing_monthly_grant_event_external_id`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Signature:** `(args: { userId, subscriptionId, periodStart }) => string`
- **Role:** Builds `monthly_grant:<userId>:<subscriptionId>:<periodStart>` for recurring-credit idempotency.

#### `billing_manual_credit_event_external_id`

- **Module:** [packages/app/server/billing.ts](../../../packages/app/server/billing.ts)
- **Signature:** `(args: { userId, timestamp }) => string`
- **Role:** Builds `manual_credit:<userId>:<timestamp>` for manually granted credit events.

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
- **Role:** Changes subscription between paid plans (upgrade immediate, downgrade end-of-cycle per Polar / app rules). Does not replace checkout for `Free -> paid`.

#### `generate_customer_portal_url`

- **Kind:** public `action`
- **Role:** Returns a Polar customer portal session URL for self-serve billing management.

#### `bootstrap_free_subscription`

- **Kind:** `internalAction`
- **Args:** `{ userId, email }`
- **Role:** Ensures Polar customer exists, inserts local customer row, creates `Free` subscription in Polar and local mirror when the user has no subscription. Invoked via workpool.

#### `billing_enqueue_free_subscription_bootstrap`

- **Kind:** async helper (`export async function`)
- **Args:** `(ctx: ActionCtx, { userId, email })`
- **Role:** Enqueues `internal.billing.bootstrap_free_subscription` on `billing_workpool_bootstrap` (single-flight style, retries on failure).

#### `handle_polar_customer_state_update`

- **Kind:** `internalMutation`
- **Args:** `{ payload }` (Polar `customer.state_changed` webhook shape)
- **Role:** Maps webhook customer to Convex `userId`, updates `billing_usage_snapshots` (subscription + meter snapshot), then enqueues `grant_monthly_credits` directly from the webhook payload when an active subscription is present. Sole trigger for monthly grants.

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
- **Role:** Resolves the product, computes the recurring credit amount, and queues a `monthly_grant` billing event with a negative amount when credits are due. The event `externalId` plus Polar duplicate detection inside `ingest_events` is the authority for whether that period was already granted.

## Auth bootstrap trigger

The auth-side trigger lives in [users.ts](../../../packages/app/convex/users.ts).

- `/api/auth/resolve-user` resolves or creates the Convex user, writes Clerk `external_id`, then enqueues the `Free` subscription bootstrap.
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
- The billing panel uses the local usage snapshot populated from `customer.state_changed` to show current due amount, remaining credits, renewal timing, and pending downgrade timing.

## Account deletion billing behavior

- Normal user-facing account deletion schedules retryable work that cancels the current paid subscription at the close of the current billing period instead of revoking it immediately.
- Billing owns `billing_cancel_polar_subscription_jobs` as the scheduler row for that work. Keep one row per user, replace the stored `jobId` when you reschedule, and clear the row only when the matching work finishes successfully or an explicit cancel removes it.
- The delete flow clears the local subscription mirror immediately after scheduling that cancellation so the deleted account no longer presents an active local billing state.
- `billing_usage_snapshots` are mirrored local billing state, not billing authority. Keep them through phase 1 and delete them only during phase 2 of account deletion.
- Restoring the account during retention does not undo the scheduled cancellation.
- Direct admin hard delete now uses `purgeUserRecord` as the single operator flag:
- `purgeUserRecord: false` keeps the immediate local hard-delete path, keeps the final tombstoned user row, and schedules the same retryable period-end cancellation used by the normal delete flow.
- `purgeUserRecord: true` cancels any scheduled period-end cancellation first, revokes the subscription immediately, deletes the Polar customer immediately, and purges the final local tombstone.

# Operational billing rules

- Treat Polar product names as exact identifiers in app code: `Free`, `Pay As You Go`, and `Pro`.
- Treat Polar benefit descriptions as exact identifiers in app code: `Free Included Usage`, `Free Usage`, and `Pro Included Usage`. These names remain stable in the catalog because tests and historical webhook payloads still reference them.
- Treat the Polar meter display name `Press app usage` as the canonical usage meter name in the catalog.
- Treat the Polar usage event name `press_usage_event` as the canonical event name for usage ingestion.
- Treat `page_save`, `monthly_grant`, and `manual_credit` as the canonical usage event names. Usage-event `externalId` prefixes must follow those names exactly (`page_save:...`, `monthly_grant:...`, `manual_credit:...`).
- Keep `meter_credit` benefits detached from every Polar product. The Convex monthly credits engine is the only code path that grants recurring credits; running both would double-grant.
- Prefer Polar-configured prices over hardcoded monetary logic in the repo. The code usually reads plan names and prices from synced Polar products. Per-plan recurring credit amounts are the exception: they live in `billing_PRODUCTS.<plan>.recurringCreditsCents` and are applied by the monthly credits engine.

# TODO / known gaps

- Enforce the `Free` plan lock once the included usage is exhausted.
- Define and implement anonymous-user billing and limits so anonymous users mirror `Free`-plan limits.
- Move usage snapshot ownership into the vendored Polar component when that migration happens.
- Reconcile repo behavior and business policy whenever plan allowances or billing-cycle credit behavior change.
