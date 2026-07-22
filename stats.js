// Multi-CAPI — dashboard stats (admin). Overall + per-store.
// GET /api/stats  (admin auth via ?key= / X-Admin-Key)
import { db, ensureSchema, listStores, adminAuth } from '../lib/core.js';
export const maxDuration = 20;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, max-age=20');
  const d = db(); await ensureSchema(d);
  if (!adminAuth(req)) return res.status(403).json({ error: 'Invalid admin password' });
  try {
    const stores = (await listStores(d)).filter(s => s.status !== 'deleted');
    const perStore = [];
    for (const s of stores) {
      const q = (sql) => d.query(sql, [s.id]).then(r => r.rows[0] || {}).catch(() => ({}));
      const [v, p] = await Promise.all([
        q(`SELECT count(*)::int visitors, count(*) FILTER (WHERE lifecycle='customer')::int customers FROM visitors WHERE store_id=$1`),
        q(`SELECT count(*)::int purchases,
                  count(*) FILTER (WHERE coalesce(fbclid,'')<>'')::int with_fbclid,
                  count(*) FILTER (WHERE coalesce(gclid,'')<>'')::int with_gclid,
                  count(*) FILTER (WHERE capi_pushed_at IS NOT NULL)::int capi_pushed,
                  coalesce(sum(coalesce(cart_value,product_price,0)),0)::numeric value
             FROM events WHERE store_id=$1 AND event_type='purchase'`),
      ]);
      perStore.push({
        id: s.id, key: s.key, name: s.name, shop_domain: s.shop_domain, status: s.status,
        has_shopify: !!(s.shopify_api_key && s.shopify_api_secret), has_token: !!s.shopify_token,
        has_meta: !!(s.meta_pixel_id && s.meta_capi_token),
        visitors: v.visitors || 0, customers: v.customers || 0,
        purchases: p.purchases || 0, with_fbclid: p.with_fbclid || 0, with_gclid: p.with_gclid || 0,
        capi_pushed: p.capi_pushed || 0, value: Number(p.value || 0),
        match_rate: p.purchases ? Math.round((p.capi_pushed / p.purchases) * 100) : 0,
      });
    }
    const totals = perStore.reduce((a, s) => ({
      visitors: a.visitors + s.visitors, purchases: a.purchases + s.purchases,
      capi_pushed: a.capi_pushed + s.capi_pushed, value: a.value + s.value,
    }), { visitors: 0, purchases: 0, capi_pushed: 0, value: 0 });
    return res.status(200).json({ ok: true, generated_at: new Date().toISOString(), store_count: stores.length, totals, stores: perStore });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
