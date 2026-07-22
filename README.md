# Multi-CAPI — one tool, many Shopify stores, per-store Meta CAPI

A **single** deployment that connects **many Shopify stores** and maps each to its **own** Meta Conversions API account. For every store it:

- Drops an **anonymous device ID**, retains **FBCLID/GCLID** first-touch, reads **device model + ₹ price tier**.
- **Auto-creates the Shopify Admin API token** from the store's API key + secret (client-credentials grant) — no manual token copying — and uses it to **enrich** orders (customer lifetime value).
- Receives that store's **order webhook**, matches it to the visitor, recovers click IDs.
- Pushes **Purchase** to *that store's* Meta pixel + token, and produces a per-store **Google Ads offline CSV**.

All stores share one database but are cleanly separated by `store_id`. You manage everything from a password-protected **admin dashboard**.

## Architecture

```
Store A pixel ─┐                        ┌─▶ Meta account A (pixel + token)
Store B pixel ─┼─▶ /api/track ─▶ DB ─┬─▶ /api/meta-capi (per store) ─┼─▶ Meta account B
Store C pixel ─┘   (tagged store_id)  │                                └─▶ Meta account C
                                      └─▶ /api/google-export?store=… ─▶ Google Ads (per store)
Store webhooks ─▶ /api/shopify-webhook (routed by X-Shopify-Shop-Domain, per-store HMAC + Admin API enrichment)
Admin ─▶ /admin.html ─▶ /api/stores (add stores, key+secret → auto token, map Meta)
```

## Deploy once

1. New Vercel project from this repo (Framework: Other).
2. Add a **Postgres** (Storage → Create) → sets `POSTGRES_URL`. Add `ADMIN_PASSWORD`. Deploy.
3. Open `https://<deployment>/admin.html`, sign in with `ADMIN_PASSWORD`.

## Add a store (in the dashboard)

1. In **that store's Shopify admin** → Settings → Apps → **Develop apps** → **Create a custom app** → enable Admin API scopes `read_orders, read_customers, read_products` → Install → copy the **API key** and **API secret**.
2. In the dashboard click **+ Add store** and fill in: name, `shop_domain` (`xxx.myshopify.com`), storefront domain, the Shopify **API key + secret**, and the store's **Meta Pixel ID + CAPI token**. Save.
3. Click **Test Shopify** — the tool mints the access token from the key+secret and reads the shop + product count to confirm.
4. Click **Install snippet** and, on that store:
   - Paste the pixel `<script src=".../tracker.js?s=STORE_KEY" async>` into `theme.liquid` before `</head>`.
   - Create an **Order creation** webhook (JSON) pointing at `.../api/shopify-webhook`. (HMAC is verified with the store's API secret automatically.)
5. Repeat for every store. Each is isolated by `store_id`, and each pushes to its own Meta account.

## Environment variables (global — few)

| Var | Required | Purpose |
|---|---|---|
| `POSTGRES_URL` | ✅ | Postgres (pooled) |
| `ADMIN_PASSWORD` | ✅ | Protects the dashboard + `/api/stores` + `/api/stats` |
| `EXPORT_KEY` | — | If set, guards `/api/google-export` |
| `SHOPIFY_API_VERSION`, `META_API_VERSION` | — | API version overrides |

**Per-store** Shopify + Meta credentials are entered in the dashboard and stored in the DB, not in env.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/admin.html` | password | dashboard |
| `POST /api/track` | public | pixel ingest (tagged by store key) |
| `POST /api/shopify-webhook` | per-store HMAC | order → purchase (routed by shop domain) |
| `GET /api/meta-capi[?store=KEY]` | public (cron) | push each store's purchases to its Meta account |
| `GET /api/google-export?store=KEY` | `EXPORT_KEY` opt. | that store's Google Ads CSV |
| `GET /api/stores`, `POST /api/stores` | admin | manage stores |
| `GET /api/stats` | admin | dashboard stats |

## Notes
- **Shopify token:** created via the client-credentials grant and cached per store (refreshed ~every 12h / on 401). This works because the custom app lives inside each store. If a store is in a different Shopify org where client-credentials is blocked, use an OAuth install app instead (not built here).
- **Device prices:** `public/device-prices.json` (shared across stores) maps model → ₹ → tier → Meta "Higher/Lower DP". Editable.

## Device-price segmentation & no double-counting
Every event pushed to Meta carries `content_category` = the device price segment (`Higher DP` for ₹30k+ devices, `Lower DP` below), plus `device_price_segment`, `device_model`, `device_brand`, and `device_price_inr`. Build your custom conversions in Meta by filtering on `content_category`.

- **Purchase** is sent as the **standard `Purchase`** event with `event_id` = the raw Shopify **order id**. Your browser pixel's Purchase uses the same order id, so Meta merges the two and counts the sale **once**. CAPI only fills in the ones the browser missed and adds the device segment.
- **Add-to-cart** is sent as a **distinct custom event** (`AddToCartDP`, override with `META_ATC_EVENT`) — never as `AddToCart` — so your standard AddToCart metric is untouched and there is no overlap. Only cart-adds with an identifier (fbclid / email / phone) are pushed.
