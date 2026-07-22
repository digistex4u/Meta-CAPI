// Multi-CAPI — Google Ads offline conversions CSV, per store.
// GET /api/google-export?store=KEY[&since=30 days][&key=EXPORT_KEY][&name=Purchase]
import { db, ensureSchema, getStoreByKey } from '../lib/core.js';
export const maxDuration = 30;

function fmtTime(ts, tz) { return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + (tz || '+00:00'); }
function cell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export default async function handler(req, res) {
  if (process.env.EXPORT_KEY && req.query.key !== process.env.EXPORT_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const d = db(); await ensureSchema(d);
  const store = req.query.store ? await getStoreByKey(d, req.query.store) : null;
  if (!store) return res.status(400).json({ error: 'store (key) required' });
  const since = req.query.since || '30 days';
  const convName = req.query.name || process.env.GOOGLE_CONVERSION_NAME || 'Purchase';
  const tz = process.env.GOOGLE_TZ_OFFSET || '+05:30';
  const currency = store.currency || 'INR';
  try {
    const { rows } = await d.query(`
      SELECT e.ts, e.cart_value, e.product_price, e.gclid, e.extra, v.first_source
      FROM events e LEFT JOIN visitors v ON v.store_id=e.store_id AND v.vid=e.vid
      WHERE e.store_id=$1 AND e.event_type='purchase' AND e.ts > now() - $2::interval
      ORDER BY e.ts DESC LIMIT 5000`, [store.id, since]).catch(() => ({ rows: [] }));
    const seen = new Set(), lines = [];
    for (const r of rows) {
      const gclid = r.gclid || (r.first_source && r.first_source.gclid) || '';
      if (!gclid) continue;
      const value = parseFloat(r.cart_value || r.product_price || 0); if (!value) continue;
      const key = (r.extra && r.extra.order_id) ? 'ord_' + r.extra.order_id : gclid + '_' + r.ts;
      if (seen.has(key)) continue; seen.add(key);
      lines.push([gclid, convName, fmtTime(r.ts, tz), value, currency].map(cell).join(','));
    }
    const csv = `Parameters:TimeZone=${tz};\nGoogle Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency\n` + lines.join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="google-offline-${store.key}.csv"`);
    return res.status(200).send(csv);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
