// Multi-CAPI — data retention / prune (keeps Postgres flat regardless of traffic).
// Runs daily via cron. Deletes high-volume, low-value rows once they've served their
// purpose, while KEEPING everything the tool actually needs:
//   • purchases are kept forever (low volume, needed for reporting + CAPI history)
//   • add_to_cart / checkout_start / identify kept EVENT_RETENTION_DAYS (default 60)
//   • page_view / product_view / search kept only PAGEVIEW_RETENTION_DAYS (default 7) — this is the bulk
//   • anonymous, never-identified, inactive visitors dropped after VISITOR_RETENTION_DAYS (default 30)
// The visitor PROFILE (device model, price, first-touch click IDs, affinity) lives on the
// visitors row and is written at ingest time, so pruning raw page views loses nothing for CAPI.
//
// Safety: never touches capi_log; never deletes a 'purchase' event or a customer visitor.
// Auth: Vercel cron (Authorization: Bearer CRON_SECRET, or vercel-cron user-agent) OR admin key.
// Dry run: add ?dry=1 to see counts without deleting.
import { db, ensureSchema, adminAuth } from '../lib/core.js';
export const maxDuration = 30;

function allow(req) {
  const cs = process.env.CRON_SECRET;
  if (cs && req.headers.authorization === `Bearer ${cs}`) return true;
  if (/vercel-cron/i.test(req.headers['user-agent'] || '')) return true;
  return adminAuth(req);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!allow(req)) return res.status(403).json({ error: 'unauthorized' });

  const d = db(); await ensureSchema(d);
  const PV = parseInt(process.env.PAGEVIEW_RETENTION_DAYS || '7', 10);
  const EV = parseInt(process.env.EVENT_RETENTION_DAYS || '60', 10);
  const VZ = parseInt(process.env.VISITOR_RETENTION_DAYS || '30', 10);
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');

  const jobs = [
    { name: 'pageview_events', days: PV,
      where: `event_type IN ('page_view','product_view','search') AND ts < now() - $1::interval`,
      table: 'events' },
    { name: 'interaction_events', days: EV,
      where: `event_type IN ('add_to_cart','checkout_start','identify','whatsapp_click') AND ts < now() - $1::interval`,
      table: 'events' },
    { name: 'stale_anonymous_visitors', days: VZ,
      where: `lifecycle <> 'customer' AND coalesce(contact_phone,'')='' AND coalesce(profile->>'email','')='' AND last_seen < now() - $1::interval`,
      table: 'visitors' },
  ];

  const results = {};
  try {
    for (const j of jobs) {
      const iv = `${j.days} days`;
      if (dry) {
        const r = await d.query(`SELECT count(*)::int n FROM ${j.table} WHERE ${j.where}`, [iv]).then(x => x.rows[0].n).catch(() => 0);
        results[j.name] = { would_delete: r, keep_days: j.days };
      } else {
        const r = await d.query(`DELETE FROM ${j.table} WHERE ${j.where}`, [iv]).catch(() => ({ rowCount: 0 }));
        results[j.name] = { deleted: r.rowCount || 0, keep_days: j.days };
      }
    }
    // keep table sizes tidy after big deletes (non-blocking best-effort)
    if (!dry) { await d.query('ANALYZE events').catch(() => {}); }
    return res.status(200).json({ ok: true, dry: !!dry, purchases: 'kept forever', results });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
