// Multi-CAPI — Shopify orders/create webhook (store-routed).
// One endpoint for ALL stores. Identifies the store from the X-Shopify-Shop-Domain
// header, verifies HMAC with that store's secret, records the purchase under its
// store_id, and enriches with customer lifetime value via the Admin API token.
import { db, ensureSchema, getStoreByDomain, verifyShopifyHmac, shopifyAdmin } from '../lib/core.js';
export const maxDuration = 20;
export const config = { api: { bodyParser: false } };

function readRaw(req) { return new Promise((r) => { let s = ''; req.on('data', c => (s += c)); req.on('end', () => r(s)); req.on('error', () => r('')); }); }
function normPhone(p) { p = String(p || '').replace(/[^\d+]/g, ''); if (!p) return ''; if (p.length === 10) p = '+91' + p; if (p[0] !== '+') p = '+' + p; return p; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const raw = await readRaw(req);
  const d = db(); await ensureSchema(d);

  const shopDomain = req.headers['x-shopify-shop-domain'] || '';
  const store = shopDomain ? await getStoreByDomain(d, shopDomain) : null;
  if (!store) return res.status(202).json({ ok: false, reason: 'unknown_store', shop: shopDomain });

  // Per-store HMAC (webhook secret, else API secret)
  const secret = store.shopify_webhook_secret || store.shopify_api_secret;
  if (secret && !verifyShopifyHmac(raw, secret, req.headers['x-shopify-hmac-sha256'] || '')) {
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  let order; try { order = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (!order || !order.id) return res.status(400).json({ error: 'Invalid order' });
  const store_id = store.id;

  try {
    const orderName = order.name || ('#' + order.id);
    const email = (order.email || '').toLowerCase().trim();
    const phone = normPhone(order.phone || order.billing_address?.phone || order.shipping_address?.phone || '');
    const totalPrice = parseFloat(order.total_price) || 0;
    const currency = order.currency || store.currency || 'INR';
    const items = (order.line_items || []).map(li => ({ title: li.title, product_id: String(li.product_id), price: parseFloat(li.price), qty: li.quantity, type: li.product_type || '' }));

    let gclid = '', fbclid = '', utmSource = '';
    for (const a of (order.note_attributes || [])) {
      const k = (a.name || '').replace(/^_/, '');
      if (k === 'gclid') gclid = a.value || ''; if (k === 'fbclid') fbclid = a.value || ''; if (k === 'utm_source') utmSource = a.value || '';
    }
    if (order.landing_site) {
      if (!gclid) { const m = order.landing_site.match(/gclid=([^&]+)/); if (m) gclid = m[1]; }
      if (!fbclid) { const m = order.landing_site.match(/fbclid=([^&]+)/); if (m) fbclid = m[1]; }
    }

    // Match to a visitor WITHIN this store
    let vid = null, method = 'none';
    const q = (sql, p) => d.query(sql, p).then(r => r.rows).catch(() => []);
    if (phone) { const r = await q('SELECT vid FROM visitors WHERE store_id=$1 AND contact_phone = ANY($2) ORDER BY last_seen DESC LIMIT 1', [store_id, [phone, phone.replace(/^\+91/, '91'), phone.replace(/^\+/, '')]]); if (r.length) { vid = r[0].vid; method = 'phone'; } }
    if (!vid && email) { const r = await q("SELECT vid FROM visitors WHERE store_id=$1 AND profile->>'email'=$2 ORDER BY last_seen DESC LIMIT 1", [store_id, email]); if (r.length) { vid = r[0].vid; method = 'email'; } }
    if (!vid && gclid) { const r = await q("SELECT DISTINCT vid FROM events WHERE store_id=$1 AND gclid=$2 LIMIT 1", [store_id, gclid]); if (r.length) { vid = r[0].vid; method = 'gclid'; } }
    if (!vid && fbclid) { const r = await q("SELECT DISTINCT vid FROM events WHERE store_id=$1 AND fbclid=$2 LIMIT 1", [store_id, fbclid]); if (r.length) { vid = r[0].vid; method = 'fbclid'; } }
    if (!vid) { const r = await q("SELECT vid FROM events WHERE store_id=$1 AND event_type='checkout_start' AND ts > now() - interval '30 minutes' ORDER BY ts DESC LIMIT 1", [store_id]); if (r.length) { vid = r[0].vid; method = 'recent_checkout'; } }

    // Recover click IDs from the visitor if the order lacked them
    let recoveredGclid = null, recoveredFbclid = null;
    if (vid && (!gclid || !fbclid)) {
      const r = await q("SELECT gclid, fbclid FROM events WHERE store_id=$1 AND vid=$2 AND (coalesce(gclid,'')<>'' OR coalesce(fbclid,'')<>'') ORDER BY ts ASC LIMIT 1", [store_id, vid]);
      if (r.length) { recoveredGclid = r[0].gclid || null; recoveredFbclid = r[0].fbclid || null; }
    }
    const finalGclid = gclid || recoveredGclid || null, finalFbclid = fbclid || recoveredFbclid || null;

    // Enrich: customer lifetime value via Admin API (best-effort)
    let ltv = null, ordersCount = null;
    try {
      const cid = order.customer && order.customer.id;
      if (cid && store.shopify_api_key) {
        const c = await shopifyAdmin(d, store, `customers/${cid}.json`);
        if (c && c.customer) { ltv = parseFloat(c.customer.total_spent) || null; ordersCount = c.customer.orders_count != null ? c.customer.orders_count : null; }
      }
    } catch (e) {}

    if (vid) {
      await d.query(`INSERT INTO events (store_id, vid, event_type, page_url, product_name, product_price, cart_value, gclid, fbclid, utm_source, extra)
        VALUES ($1,$2,'purchase','/checkout/thank-you',$3,$4,$5,$6,$7,$8,$9)`,
        [store_id, vid, 'Order ' + orderName, totalPrice, totalPrice, finalGclid, finalFbclid, utmSource || null,
         JSON.stringify({ order_id: String(order.id), order_name: orderName, items, currency, email, phone, customer_ltv: ltv, orders_count: ordersCount })]);
      const upd = ["lifecycle = CASE WHEN lifecycle IN ('anonymous','identified') THEN 'customer' ELSE lifecycle END", "updated_at=now()", "total_events=total_events+1"];
      const params = [store_id, vid];
      if (phone) { params.push(phone); upd.push(`contact_phone = COALESCE(NULLIF(contact_phone,''), $${params.length})`); }
      await d.query(`UPDATE visitors SET ${upd.join(', ')} WHERE store_id=$1 AND vid=$2`, params);
      if (email) await d.query("UPDATE visitors SET profile = profile || $1::jsonb WHERE store_id=$2 AND vid=$3", [JSON.stringify({ email, last_order: orderName, last_order_value: totalPrice }), store_id, vid]).catch(() => {});
    }

    return res.status(200).json({ ok: true, store: store.key, order: orderName, matched: !!vid, method, gclid: finalGclid, fbclid: finalFbclid, ltv });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
