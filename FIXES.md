# Fixes applied (Meta CAPI multi-store)

These changes fix the under-capture / mis-measurement seen on the dashboard
(HOQ 0 purchases, Aenak 0.76×, Heatronics false 3.64×).

## 1. Webhook now records EVERY order — `api/shopify-webhook.js`
Previously the purchase was inserted only when a tracked visitor matched
(`if (vid) { INSERT }`). Orders from untracked buyers (ad blockers, direct
traffic, Shopflo checkout, cross-device) were silently dropped and never pushed
to Meta. Now every order is recorded with a synthetic `vid` (`ord_<order_id>`)
when no visitor matches — exactly like `backfill.js` — and still pushes to Meta
on hashed email/phone. Also added order-id de-dup so Shopify webhook retries
can't double-insert.

## 2. CAPI push respects Meta's success/failure — `api/meta-capi.js`
The push loop marked events as `capi_pushed_at` and wrote to `capi_log` even
when Meta returned an HTTP error, silently burning them. Now a batch is only
marked pushed when `resp.ok` and there is no `meta_response.error`; failed
batches are left for the next cron run to retry. Response now reports
`failed` and `meta_error`.

## 3. Push window capped to 7 days — `api/meta-capi.js`
Meta rejects events older than 7 days. The push selection now uses
`LEAST(since, interval '7 days')` so stale events aren't sent, rejected, and
wrongly counted as pushed. (The 30-day diagnostic segment view is unchanged.)

## 4. Reconcile ratio aligned to order date — `api/reconcile.js`
The "pushed" side counted `capi_log.pushed_at` in the window, so a one-off
backfill of a 30-day backlog inflated the recent push count and produced a
false "3.64× — over-counting" flag. It now counts pushed purchases by event
date (`events.ts`), matching Shopify's `created_at` window. (Meta was never
actually double-counting — dedup is by order id.)

## 5. Multi-tenant routing hardened — `lib/core.js`
`getStoreByDomain` had `$1 LIKE '%' || lower(storefront)`, which matches EVERY
domain if any store's `storefront` is blank — a webhook could be routed to the
wrong store. Suffix matches are now guarded to non-empty values, use dot
boundaries, and exact matches are preferred via `ORDER BY`.

## 6. Backfill button in the dashboard — `public/admin.html`
Added a per-store **Backfill** button that calls `/api/backfill?...&days=7`
and then triggers the Meta push, so dropped orders can be recovered from the UI
without hitting URLs manually.

## Deploy / operate
- Redeploy on Vercel.
- Note: the hourly cron (`/api/meta-capi`, `0 * * * *`) requires a Vercel
  **Pro** plan. On Hobby, crons are throttled to once/day — upgrade or change
  the schedule if pushes lag.
- After deploy, click **Backfill** on each store (HOQ, Aenak, Heatronics) to
  recover the orders the old webhook dropped. Ratios should settle toward ~1.0×.

## 7. Ratio now compared against ALL orders, not paid-only — `api/reconcile.js`
COD/pending orders are recorded and pushed on creation, but the panel divided by
PAID orders — making COD-heavy stores look like a 2x+ over-count when they're
~1:1. Reconcile now bases the ratio on ALL Shopify orders and also reports the
paid-only ratio for reference.

## 8. Cron heartbeat + health endpoint (for the daily monitor) — `api/meta-capi.js`, `api/health.js`, `lib/core.js`
- `meta-capi` writes a heartbeat row to a new `system_health` table every run —
  so we can tell "cron alive" from "no orders", which a pushed-count can't.
- New `GET /api/health?days=7` returns: cron last-run + alive flag, per-store
  24h recorded/pushed, unpushed backlog, pushed-vs-all-orders and vs-paid ratios,
  and a plain-English `flags` list of anything wrong. `healthy:true` when the
  cron is fresh and no flags.
- Auth: admin password, OR set a read-only `MONITOR_KEY` env var and use that in
  the daily scheduled task (least privilege — can't touch stores).
