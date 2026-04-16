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
- Give `€20` of included usage when the user first subscribes.
- After the initial subscribe month, give `€10` of included usage every billing month.
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

- `billing_PRODUCTS` stores the exact product names, display names, benefit description keys, and meter metadata the app recognizes.
- `billing_get_product_order`, `billing_compare_product_order`, and `billing_get_plan_change_kind` derive catalog ordering plus upgrade vs downgrade behavior from the canonical plan order.

## Backend ownership

The backend billing module lives in [billing.ts](../../../packages/app/convex/billing.ts).

- `billing` wraps the vendored Polar component and currently allows only signed-in users through `getUserInfo`.
- `list_products`, `list_subscriptions`, and `get_usage_snapshot` provide the billing panel data.
- `generate_checkout_link` creates Polar checkout sessions.
- `change_current_subscription` handles paid-plan changes. `Free -> paid` is intentionally not handled there and goes through checkout instead.
- `generate_customer_portal_url` opens the Polar customer portal.
- `bootstrap_free_subscription` creates the local Polar customer and the `Free` subscription when missing.
- `billing_enqueue_free_subscription_bootstrap` enqueues that bootstrap work through `billing_workpool_bootstrap`.
- `handle_polar_customer_state_update` ingests the `customer.state_changed` webhook payload into `billing_usage_snapshots`.

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

- [billing-product-card.tsx](../../../packages/app/src/components/billing/billing-product-card.tsx) renders included usage from Polar `meter_credit` benefits.
- [billing-active-plan.tsx](../../../packages/app/src/components/billing/billing-active-plan.tsx) renders due amount and remaining credits from the local usage snapshot.
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
- Treat Polar benefit descriptions as exact identifiers in app code: `Free Included Usage`, `Free Usage`, and `Pro Included Usage`.
- Treat the Polar meter display name `Press app usage` as the canonical usage meter name in the catalog.
- Treat the Polar usage event name `press_usage_event` as the canonical event name for usage ingestion.
- Prefer Polar-configured prices and benefits over hardcoded monetary logic in the repo. The code usually reads plan names, prices, and `meter_credit` benefits from synced Polar products rather than encoding the full allowance policy directly in TypeScript.

# TODO / known gaps

- Enforce the `Free` plan lock once the included usage is exhausted.
- Define and implement anonymous-user billing and limits so anonymous users mirror `Free`-plan limits.
- Implement the missing logic needed to express the canonical monthly and top-up allowance behavior where Polar monthly credits alone are not sufficient, especially `Pay As You Go` initial `€20` then `€10 / month`.
- Move usage snapshot ownership into the vendored Polar component when that migration happens.
- Reconcile repo behavior and business policy whenever plan allowances or billing-cycle credit behavior change.
