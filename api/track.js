// Multi-CAPI — visitor + event ingest (store-aware).
// POST /api/track — event batches from the pixel; each carries the store key (?s=)
// so events are tagged with the right store_id. Public (CORS *).
import { db, ensureSchema, getStoreByKey, getStoreByDomain } from '../lib/core.js';
export const maxDuration = 15;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const d = db(); await ensureSchema(d);
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'multi-capi track' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); } }
    if (!body) return res.status(400).json({ error: 'Empty body' });

    // ── Resolve which store this belongs to ──
    let store = null;
    if (body.store) store = await getStoreByKey(d, body.store);
    if (!store && body.hostname) store = await getStoreByDomain(d, body.hostname);
    if (!store) {
      const ref = req.headers['origin'] || req.headers['referer'] || '';
      if (ref) store = await getStoreByDomain(d, ref);
    }
    if (!store) return res.status(200).json({ ok: false, reason: 'unknown_store' }); // don't break the pixel
    const store_id = store.id;

    const { events, visitor: vData, profile: prof } = body;
    if (!events || !events.length) return res.status(400).json({ error: 'events array required' });
    let vid = events[0]?.vid;
    if (!vid) return res.status(400).json({ error: 'vid required' });

    // ── Batch insert events ──
    let inserted = 0;
    const eventBatch = events.slice(0, 50);
    if (eventBatch.length) {
      const COLS = 28;
      const valuesSql = eventBatch.map((_, i) => '(' + Array.from({ length: COLS }, (_, j) => '$' + (i * COLS + j + 1)).join(',') + ')').join(',');
      const params = [];
      for (const e of eventBatch) {
        params.push(
          store_id, vid, e.sid, e.event_type, e.page_url, e.page_title, e.referrer,
          e.product_id, e.product_name, e.product_type, e.product_price ? parseFloat(e.product_price) : null,
          e.cart_value ? parseFloat(e.cart_value) : null, e.search_query,
          e.gclid, e.fbclid, e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content, e.utm_term,
          e.device, e.browser, e.screen, e.city, e.region, e.country, e.dfp,
          JSON.stringify(e.extra || {})
        );
      }
      await d.query(`INSERT INTO events (
        store_id, vid, sid, event_type, page_url, page_title, referrer,
        product_id, product_name, product_type, product_price, cart_value, search_query,
        gclid, fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        device, browser, screen, city, region, country, dfp, extra
      ) VALUES ${valuesSql}`, params);
      inserted = eventBatch.length;
    }

    const isNavFlush = eventBatch.some(e => e.event_type === 'page_view' || e.event_type === 'identify');
    const f = events[0];
    const source = { gclid: f.gclid, fbclid: f.fbclid, utm_source: f.utm_source, utm_medium: f.utm_medium, utm_campaign: f.utm_campaign, utm_content: f.utm_content, utm_term: f.utm_term, referrer: f.referrer };

    // ── Upsert visitor (per store) with first-touch click-id retention ──
    await d.query(`INSERT INTO visitors (store_id, vid, sessions, total_events, last_seen, first_source, last_source, dfp, profile)
      VALUES ($1, $2, 1, $3, now(), $4, $4, $6, $5)
      ON CONFLICT (store_id, vid) DO UPDATE SET
        sessions = CASE WHEN visitors.last_seen < now() - interval '30 minutes' THEN visitors.sessions + 1 ELSE visitors.sessions END,
        total_events = visitors.total_events + $3, last_seen = now(), last_source = $4,
        first_source = CASE
          WHEN (visitors.first_source->>'gclid' IS NULL OR visitors.first_source->>'gclid'='') AND (visitors.first_source->>'fbclid' IS NULL OR visitors.first_source->>'fbclid'='')
          THEN CASE WHEN (($4::jsonb)->>'gclid' <> '' OR ($4::jsonb)->>'fbclid' <> '') THEN $4 ELSE visitors.first_source END
          ELSE visitors.first_source END,
        updated_at = now()`,
      [store_id, vid, inserted, JSON.stringify(source), JSON.stringify({ device: f.device, city: f.city }), f.dfp || null]);

    // ── Device + geo enrichment (after upsert) ──
    if (isNavFlush && prof) {
      if (prof.device_model && prof.device_model !== 'Unknown') {
        await d.query("UPDATE visitors SET device_model=COALESCE(NULLIF(device_model,''),$1), device_brand=COALESCE(NULLIF(device_brand,''),$2), device_tier=$3, device_price_inr=COALESCE($4, device_price_inr) WHERE store_id=$5 AND vid=$6",
          [prof.device_model, prof.device_brand || '', prof.device_tier || '', prof.device_price_inr || null, store_id, vid]).catch(() => {});
      }
      if (prof.city) {
        await d.query("UPDATE visitors SET profile = profile || $1::jsonb WHERE store_id=$2 AND vid=$3",
          [JSON.stringify({ city: prof.city, region: prof.region || '', country: prof.country || '' }), store_id, vid]).catch(() => {});
      }
    }

    // ── Product affinity ──
    const affinity = {};
    for (const e of events) if (e.event_type === 'product_view' && e.product_type) affinity[e.product_type] = (affinity[e.product_type] || 0) + 1;
    if (Object.keys(affinity).length) {
      await d.query(`UPDATE visitors SET product_affinity = (
        SELECT jsonb_object_agg(key, COALESCE((product_affinity->>key)::int,0) + (v::int)) FROM jsonb_each_text($1::jsonb) AS t(key,v)
      ) WHERE store_id=$2 AND vid=$3`, [JSON.stringify(affinity), store_id, vid]);
    }

    // ── Identity link ──
    if (vData?.phone) {
      await d.query("UPDATE visitors SET contact_phone = CASE WHEN contact_phone IS NULL OR contact_phone='' THEN $1 ELSE contact_phone END, lifecycle = CASE WHEN lifecycle='anonymous' THEN 'identified' ELSE lifecycle END, updated_at=now() WHERE store_id=$2 AND vid=$3", [String(vData.phone), store_id, vid]);
    }
    if (vData?.email) {
      await d.query("UPDATE visitors SET profile = profile || $1::jsonb, lifecycle = CASE WHEN lifecycle='anonymous' THEN 'identified' ELSE lifecycle END WHERE store_id=$2 AND vid=$3",
        [JSON.stringify({ email: String(vData.email).toLowerCase() }), store_id, vid]).catch(() => {});
    }

    return res.status(200).json({ ok: true, inserted, vid, store: store.key });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
