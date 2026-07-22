// Multi-CAPI — one-time purchase backfill from Shopify Admin API.
// GET /api/backfill?store=KEY&days=7[&dry=1][&key=ADMIN_PASSWORD]
//   Pulls recent orders straight from Shopify, extracts email / phone / fbclid / gclid,
//   matches each to a tracked visitor (to recover the retained click IDs + device price),
//   and records them as 'purchase' events. The normal /api/meta-capi cron then pushes them.
//
// Notes:
//  • Meta only accepts events up to 7 DAYS old — orders older than that are recorded for your
//    books but flagged not_pushable (the CAPI push will skip them).
//  • fbclid only exists if it was preserved on the order's landing_site or on a matched visitor;
//    otherwise the purchase still pushes on hashed email + phone.
//  • De-duped by Shopify order id, so it's safe to run repeatedly and safe alongside the live webhook.
import { db, ensureSchema, getStoreByKey, shopifyAdmin, adminAuth } from '../lib/core.js';
export const maxDuration = 60;

function normPhone(p) { p = String(p || '').replace(/[^\d+]/g, ''); if (!p) return ''; if (p.length === 10) p = '+91' + p; if (p[0] !== '+') p = '+' + p; return p; }
function pick(url, key) { if (!url) return ''; const m = String(url).match(new RegExp(key + '=([^&]+)')); return m ? decodeURIComponent(m[1]) : ''; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!adminAuth(req)) return res.status(403).json({ error: 'unauthorized' });

  const d = db(); await ensureSchema(d);
  const key = req.query && req.query.store;
  if (!key) return res.status(400).json({ error: 'store query param required (?store=KEY)' });
  const store = await getStoreByKey(d, key);
  if (!store) return res.status(404).json({ error: 'store not found' });
  if (!store.shopify_api_key || !store.shopify_api_secret || !store.shop_domain)
    return res.status(400).json({ error: 'store missing Shopify credentials' });

  const days = Math.max(1, Math.min(60, parseInt((req.query && req.query.days) || '7', 10)));
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const PUSH_WINDOW_MS = 7 * 86400000;   // Meta's hard limit

  const fields = 'id,name,email,phone,total_price,currency,line_items,note_attributes,landing_site,referring_site,customer,created_at,billing_address,shipping_address,financial_status';
  const path = `orders.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}&limit=250&fields=${fields}`;

  const summary = { store: store.key, days, pulled: 0, inserted: 0, skipped_existing: 0, matched_visitor: 0, with_fbclid: 0, with_gclid: 0, with_email: 0, with_phone: 0, not_pushable_older_than_7d: 0, dry: !!dry, orders: [] };

  try {
    const data = await shopifyAdmin(d, store, path);
    if (data && data.error) return res.status(502).json({ error: 'shopify_admin_' + data.error });
    const orders = (data && data.orders) || [];
    summary.pulled = orders.length;

    for (const order of orders) {
      const oid = String(order.id);
      const orderName = order.name || ('#' + oid);
      const email = (order.email || order.customer?.email || '').toLowerCase().trim();
      const phone = normPhone(order.phone || order.billing_address?.phone || order.shipping_address?.phone || order.customer?.phone || '');
      const totalPrice = parseFloat(order.total_price) || 0;
      const currency = order.currency || store.currency || 'INR';
      const items = (order.line_items || []).map(li => ({ title: li.title, product_id: String(li.product_id), price: parseFloat(li.price), qty: li.quantity, type: li.product_type || '' }));
      const ts = order.created_at ? new Date(order.created_at) : new Date();
      const pushable = (Date.now() - ts.getTime()) <= PUSH_WINDOW_MS;

      // click IDs off the order (note_attributes, then landing_site)
      let gclid = '', fbclid = '';
      for (const a of (order.note_attributes || [])) {
        const k = (a.name || '').replace(/^_/, '');
        if (k === 'gclid') gclid = a.value || ''; if (k === 'fbclid') fbclid = a.value || '';
      }
      if (!gclid) gclid = pick(order.landing_site, 'gclid') || pick(order.referring_site, 'gclid');
      if (!fbclid) fbclid = pick(order.landing_site, 'fbclid') || pick(order.referring_site, 'fbclid');

      // dedup by order id (covers live-webhook rows too)
      const dup = await d.query("SELECT 1 FROM events WHERE store_id=$1 AND event_type='purchase' AND extra->>'order_id'=$2 LIMIT 1", [store.id, oid]).then(r => r.rows).catch(() => []);
      if (dup.length) { summary.skipped_existing++; continue; }

      // match a visitor within this store → recover retained click IDs
      const q = (sql, p) => d.query(sql, p).then(r => r.rows).catch(() => []);
      let vid = null, method = 'none';
      if (phone) { const r = await q('SELECT vid FROM visitors WHERE store_id=$1 AND contact_phone = ANY($2) ORDER BY last_seen DESC LIMIT 1', [store.id, [phone, phone.replace(/^\+91/, '91'), phone.replace(/^\+/, '')]]); if (r.length) { vid = r[0].vid; method = 'phone'; } }
      if (!vid && email) { const r = await q("SELECT vid FROM visitors WHERE store_id=$1 AND profile->>'email'=$2 ORDER BY last_seen DESC LIMIT 1", [store.id, email]); if (r.length) { vid = r[0].vid; method = 'email'; } }
      if (!vid && fbclid) { const r = await q("SELECT DISTINCT vid FROM events WHERE store_id=$1 AND fbclid=$2 LIMIT 1", [store.id, fbclid]); if (r.length) { vid = r[0].vid; method = 'fbclid'; } }
      if (!vid && gclid) { const r = await q("SELECT DISTINCT vid FROM events WHERE store_id=$1 AND gclid=$2 LIMIT 1", [store.id, gclid]); if (r.length) { vid = r[0].vid; method = 'gclid'; } }
      if (vid && (!gclid || !fbclid)) {
        const r = await q("SELECT gclid, fbclid FROM events WHERE store_id=$1 AND vid=$2 AND (coalesce(gclid,'')<>'' OR coalesce(fbclid,'')<>'') ORDER BY ts ASC LIMIT 1", [store.id, vid]);
        if (r.length) { gclid = gclid || r[0].gclid || ''; fbclid = fbclid || r[0].fbclid || ''; }
      }
      if (vid) summary.matched_visitor++;
      const useVid = vid || ('ord_' + oid);
      if (email) summary.with_email++;
      if (phone) summary.with_phone++;
      if (fbclid) summary.with_fbclid++;
      if (gclid) summary.with_gclid++;
      if (!pushable) summary.not_pushable_older_than_7d++;

      if (!dry) {
        await d.query(`INSERT INTO events (store_id, vid, event_type, page_url, product_name, product_price, cart_value, gclid, fbclid, extra, ts)
          VALUES ($1,$2,'purchase','/backfill',$3,$4,$5,$6,$7,$8,$9)`,
          [store.id, useVid, 'Order ' + orderName, totalPrice, totalPrice, gclid || null, fbclid || null,
           JSON.stringify({ order_id: oid, order_name: orderName, items, currency, email, phone, backfill: true, pushable }), ts.toISOString()]);
        // promote a matched visitor to customer
        if (vid) await d.query("UPDATE visitors SET lifecycle = CASE WHEN lifecycle IN ('anonymous','identified') THEN 'customer' ELSE lifecycle END, updated_at=now() WHERE store_id=$1 AND vid=$2", [store.id, vid]).catch(() => {});
        summary.inserted++;
      }
      if (summary.orders.length < 40) summary.orders.push({ order: orderName, value: totalPrice, matched: method, fbclid: !!fbclid, gclid: !!gclid, email: !!email, phone: !!phone, pushable });
    }

    summary.note = dry ? 'DRY RUN — nothing written' :
      `Recorded. The /api/meta-capi cron will push the ${summary.inserted - summary.not_pushable_older_than_7d} pushable purchase(s) on its next run (or hit /api/meta-capi?store=${store.key} to push now).`;
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
