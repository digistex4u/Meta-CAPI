// Multi-CAPI — Meta Conversions API push (per store).
// GET /api/meta-capi[?store=KEY&since=30 days]  → for each active store, push its
// unpushed Purchases + Add-to-Carts to ITS OWN pixel + token. (cron target)
//
// Dedup / no double-counting:
//  • Purchase is sent as the STANDARD "Purchase" with event_id = Shopify order id,
//    so Meta merges it with the browser pixel's Purchase (same order id) → counted once.
//  • Add-to-cart is sent as a DISTINCT CUSTOM event (default "AddToCartDP") so it never
//    collides with the browser's standard AddToCart → your AddToCart metric is untouched.
//  • Every event also carries content_category = device price segment, so you can build
//    "… — Higher DP / Lower DP" custom conversions in Meta's rule builder.
import { db, ensureSchema, listStores, getStoreByKey, sha256, normalizePhoneDigits } from '../lib/core.js';
export const maxDuration = 60;

const API_VERSION = process.env.META_API_VERSION || 'v18.0';
const ATC_EVENT = process.env.META_ATC_EVENT || 'AddToCartDP';   // custom event name for device-segmented cart-adds

function seg(tier, priceInr) {
  const p = priceInr != null ? parseFloat(priceInr) : null;
  if (p != null) return p >= 30000 ? 'Higher DP' : 'Lower DP';
  if (tier === 'premium' || tier === 'mid-premium') return 'Higher DP';
  if (tier === 'mid' || tier === 'budget') return 'Lower DP';
  return 'Unknown';
}
function userData(r) {
  const ud = {};
  const extra = r.extra || {}, fs = r.first_source || {}, pf = r.profile || {};
  const email = (extra.email || pf.email || '').toLowerCase() || null;
  const phone = extra.phone || r.contact_phone || null;
  const fbclid = r.fbclid || fs.fbclid || '';
  if (phone) ud.ph = [sha256(normalizePhoneDigits(phone))];
  if (email) ud.em = [sha256(email)];
  if (pf.city) ud.ct = [sha256(pf.city)];
  // fbc: prefer the real _fbc cookie captured browser-side; else reconstruct from fbclid
  if (pf.fbc) ud.fbc = pf.fbc;
  else if (fbclid) ud.fbc = 'fb.1.' + Date.now() + '.' + fbclid;
  if (pf.fbp) ud.fbp = pf.fbp;                              // Browser ID (_fbp) — big match lift
  if (r.vid) ud.external_id = [sha256(String(r.vid))];      // stable hashed device id — free, big lift
  if (pf.client_ip) ud.client_ip_address = pf.client_ip;   // raw, not hashed
  if (pf.client_ua) ud.client_user_agent = pf.client_ua;   // raw, not hashed
  return { ud, hasId: !!(email || phone || fbclid) };
}
function deviceData(r, currency) {
  const cd = { device_price_segment: seg(r.device_tier, r.device_price_inr), device_model: r.device_model || '', device_brand: r.device_brand || '' };
  cd.content_category = cd.device_price_segment;                 // <- filterable in Meta's custom-conversion builder
  if (r.device_price_inr != null) cd.device_price_inr = parseFloat(r.device_price_inr);
  return cd;
}

async function pushStore(d, store, since, testCode) {
  if (!store.meta_pixel_id || !store.meta_capi_token) return { store: store.key, skipped: 'no_meta_creds' };
  const currency = store.currency || 'INR';
  const src = store.site_url || ('https://' + store.storefront);

  // ── Purchases (standard event, deduped by order id) ──
  const purchases = await d.query(`
    SELECT e.id, e.vid, e.ts, e.cart_value, e.product_price, e.fbclid, e.extra,
           v.first_source, v.device_tier, v.device_price_inr, v.device_model, v.device_brand, v.profile, v.contact_phone
    FROM events e LEFT JOIN visitors v ON v.store_id=e.store_id AND v.vid=e.vid
    WHERE e.store_id=$1 AND e.event_type='purchase' AND e.capi_pushed_at IS NULL AND e.ts > now() - $2::interval
    ORDER BY e.ts DESC LIMIT 300`, [store.id, since]).then(x => x.rows).catch(() => []);

  // ── Add-to-carts (custom event; only matchable ones) ──
  const carts = await d.query(`
    SELECT e.id, e.vid, e.ts, e.product_id, e.product_price, e.cart_value, e.fbclid, e.extra,
           v.first_source, v.device_tier, v.device_price_inr, v.device_model, v.device_brand, v.profile, v.contact_phone
    FROM events e LEFT JOIN visitors v ON v.store_id=e.store_id AND v.vid=e.vid
    WHERE e.store_id=$1 AND e.event_type='add_to_cart' AND e.capi_pushed_at IS NULL AND e.ts > now() - $2::interval
      AND (coalesce(e.fbclid,'')<>'' OR coalesce(v.first_source->>'fbclid','')<>'' OR coalesce(v.profile->>'email','')<>'' OR coalesce(v.contact_phone,'')<>'')
    ORDER BY e.ts DESC LIMIT 300`, [store.id, since]).then(x => x.rows).catch(() => []);

  const built = [], rowIds = [];
  let skipped_no_id = 0, skipped_no_value = 0, skipped_dup = 0;

  async function add(r, eventName, eventId, value, contentIds) {
    const { ud, hasId } = userData(r);
    if (!hasId) { skipped_no_id++; return; }
    const dup = await d.query("SELECT 1 FROM capi_log WHERE store_id=$1 AND event_id=$2", [store.id, eventId]).then(x => x.rows).catch(() => []);
    if (dup.length) { skipped_dup++; rowIds.push(r.id); return; }
    const cd = deviceData(r, currency);
    if (value) { cd.value = parseFloat(value); cd.currency = currency; }
    if (contentIds && contentIds.length) { cd.content_ids = contentIds; cd.content_type = 'product'; }
    built.push({ _row: r.id, _id: eventId, ev: { event_name: eventName, event_time: Math.floor(new Date(r.ts).getTime() / 1000), action_source: 'website', event_source_url: src, event_id: eventId, user_data: ud, custom_data: cd } });
  }

  for (const r of purchases) {
    const extra = r.extra || {};
    const value = parseFloat(r.cart_value || r.product_price || 0);
    if (!value) { skipped_no_value++; rowIds.push(r.id); continue; }
    const eventId = extra.order_id ? String(extra.order_id) : ('evt_' + r.id);   // order id → dedupes with browser Purchase
    const contentIds = (extra.items || []).map(i => String(i.product_id)).filter(Boolean);
    await add(r, 'Purchase', eventId, value, contentIds);
  }
  for (const r of carts) {
    const value = r.product_price ? parseFloat(r.product_price) : (r.cart_value ? parseFloat(r.cart_value) : null);
    await add(r, ATC_EVENT, 'atc_' + r.id, value, r.product_id ? [String(r.product_id)] : null);
  }

  let pushed = 0, meta_response = null;
  for (let i = 0; i < built.length; i += 50) {
    const batch = built.slice(i, i + 50);
    const payload = { data: batch.map(x => x.ev), access_token: store.meta_capi_token };
    if (testCode) payload.test_event_code = testCode;
    const resp = await fetch(`https://graph.facebook.com/${API_VERSION}/${store.meta_pixel_id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    meta_response = await resp.json().catch(() => ({}));
    for (const x of batch) { await d.query("INSERT INTO capi_log (store_id,event_id,event_name,value) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [store.id, x._id, x.ev.event_name, x.ev.custom_data.value || 0]).catch(() => {}); rowIds.push(x._row); pushed++; }
  }
  if (rowIds.length) await d.query("UPDATE events SET capi_pushed_at=now() WHERE store_id=$1 AND id = ANY($2::bigint[])", [store.id, rowIds]).catch(() => {});
  return { store: store.key, purchases: purchases.length, carts: carts.length, pushed, skipped_no_id, skipped_no_value, skipped_dup, meta_response };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const d = db(); await ensureSchema(d);
  const since = (req.query && req.query.since) || '30 days';
  const testCode = (req.query && req.query.test_event_code) || null;
  try {
    let stores;
    if (req.query && req.query.store) { const s = await getStoreByKey(d, req.query.store); stores = s ? [s] : []; }
    else stores = (await listStores(d)).filter(s => s.status === 'active');
    const results = [];
    for (const s of stores) { try { results.push(await pushStore(d, s, since, testCode)); } catch (e) { results.push({ store: s.key, error: e.message }); } }
    return res.status(200).json({ ok: true, stores: results.length, total_pushed: results.reduce((a, r) => a + (r.pushed || 0), 0), atc_event: ATC_EVENT, results });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
