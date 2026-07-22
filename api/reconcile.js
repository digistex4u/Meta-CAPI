// Multi-CAPI — purchase reconciliation: real Shopify orders vs what we push to Meta (CAPI).
// GET /api/reconcile?store=KEY&days=7[&key=ADMIN_PASSWORD]
// A ~1:1 ratio (pushed ÷ shopify_orders) means we're sending one Purchase per real order —
// the leading indicator that Meta won't over-count (dedup then collapses browser+CAPI to 1x).
import { db, ensureSchema, getStoreByKey, shopifyAdmin, adminAuth } from '../lib/core.js';
export const maxDuration = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!adminAuth(req)) return res.status(403).json({ error: 'unauthorized' });

  const d = db(); await ensureSchema(d);
  const key = req.query && req.query.store;
  if (!key) return res.status(400).json({ error: 'store query param required (?store=KEY)' });
  const store = await getStoreByKey(d, key);
  if (!store) return res.status(404).json({ error: 'store not found' });

  const days = Math.max(1, Math.min(90, parseInt((req.query && req.query.days) || '7', 10)));
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const iv = `${days} days`;

  try {
    // Real orders from Shopify (paid) + all
    let shopifyOrders = null, shopifyPaid = null;
    if (store.shopify_api_key && store.shopify_api_secret && store.shop_domain) {
      const anyC = await shopifyAdmin(d, store, `orders/count.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}`);
      const paidC = await shopifyAdmin(d, store, `orders/count.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(sinceIso)}`);
      shopifyOrders = (anyC && typeof anyC.count === 'number') ? anyC.count : null;
      shopifyPaid = (paidC && typeof paidC.count === 'number') ? paidC.count : null;
    }

    // Our side, same window
    const recorded = await d.query(
      "SELECT count(*)::int n, coalesce(sum(coalesce(cart_value,product_price,0)),0)::numeric v FROM events WHERE store_id=$1 AND event_type='purchase' AND ts > now() - $2::interval",
      [store.id, iv]).then(r => r.rows[0]).catch(() => ({ n: 0, v: 0 }));
    // Distinct Purchase events actually sent to Meta (capi_log is the source of truth for pushes)
    const pushed = await d.query(
      "SELECT count(*)::int n FROM capi_log WHERE store_id=$1 AND event_name='Purchase' AND pushed_at > now() - $2::interval",
      [store.id, iv]).then(r => r.rows[0].n).catch(() => 0);

    const base = shopifyPaid != null ? shopifyPaid : shopifyOrders;
    const ratio = base ? +(pushed / base).toFixed(2) : null;
    let status = 'unknown';
    if (base != null && ratio != null) {
      if (ratio >= 0.85 && ratio <= 1.15) status = 'good';        // ~1:1 — healthy
      else if (ratio > 1.15) status = 'over';                     // we push more than real orders → investigate
      else status = 'under';                                      // we push fewer → some orders not captured yet
    } else if (shopifyOrders == null) status = 'no_shopify';

    return res.status(200).json({
      ok: true, store: store.key, days,
      shopify_orders: shopifyOrders, shopify_paid: shopifyPaid,
      recorded: recorded.n, recorded_value: Number(recorded.v || 0),
      pushed_to_meta: pushed, ratio, status,
      note: status === 'good' ? 'Healthy ~1:1 — one CAPI Purchase per real order.'
        : status === 'over' ? 'We are pushing more Purchases than Shopify orders — check for duplicate order ids or a re-run.'
        : status === 'under' ? 'Fewer pushed than orders — recent orders may still be queued, or the webhook missed some (run backfill).'
        : status === 'no_shopify' ? 'Add Shopify credentials to compare against real orders.'
        : 'No orders in this window.',
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
