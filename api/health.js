// Multi-CAPI — health check for the daily monitor.
// GET /api/health?days=7[&key=ADMIN_PASSWORD | &key=MONITOR_KEY]
//
// Answers two questions in one call:
//   1) Is the /api/meta-capi cron actually running?  (heartbeat freshness — works even on a
//      run with 0 orders, which a "did anything push?" check can't distinguish from a dead cron.)
//   2) Are the per-store ratios healthy?  (pushed-to-Meta vs ALL Shopify orders, plus paid ratio,
//      plus unpushed backlog and 24h throughput.)
//
// Auth: admin password (same as /api/stats) OR a read-only MONITOR_KEY env var if you'd rather
// not put the admin password in a scheduled task.
import { db, ensureSchema, listStores, shopifyAdmin, adminAuth } from '../lib/core.js';
export const maxDuration = 60;

function authOK(req) {
  if (adminAuth(req)) return true;
  const mk = process.env.MONITOR_KEY;
  if (!mk) return false;
  const given = (req.query && req.query.key) || req.headers['x-monitor-key'];
  return given === mk;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const d = db(); await ensureSchema(d);
  if (!authOK(req)) return res.status(403).json({ error: 'unauthorized' });
  // Self-heal: ensure the heartbeat table exists even if a stale lib/core.js skipped it.
  await d.query(`CREATE TABLE IF NOT EXISTS system_health (k TEXT PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), info JSONB DEFAULT '{}'::jsonb)`).catch(() => {});

  const days = Math.max(1, Math.min(30, parseInt((req.query && req.query.days) || '7', 10)));
  const iv = `${days} days`;
  const CRON_MAX_MIN = 120;   // hourly cron → consider it alive if it ran within 2h

  try {
    // ── 1) Cron heartbeat ──
    let hb = null, hbDebug = 'ok';
    try {
      const rows = await d.query("SELECT k, ts, info FROM system_health").then(r => r.rows);
      hbDebug = 'rows=' + rows.length + ' keys=[' + rows.map(r => r.k).join(',') + ']';
      hb = rows.find(r => r.k === 'meta_capi_last_run') || null;
    } catch (e) { hbDebug = 'read_error: ' + e.message; }
    const who = await d.query("SELECT current_database() db, inet_server_addr() host").then(r => r.rows[0]).catch(() => null);
    const hbDb = who ? (who.db + '@' + who.host) : null;
    const lastRun = hb ? hb.ts : null;
    const minsSince = lastRun ? Math.round((Date.now() - new Date(lastRun).getTime()) / 60000) : null;
    const cronAlive = minsSince != null && minsSince <= CRON_MAX_MIN;

    // ── 2) Per-store ratios & backlog ──
    const stores = (await listStores(d)).filter(s => s.status !== 'deleted');
    const perStore = [];
    for (const s of stores) {
      const q = (sql, p) => d.query(sql, p).then(r => r.rows[0] || {}).catch(() => ({}));
      const rec = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND ts > now() - interval '24 hours'", [s.id]);
      const psh = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND capi_pushed_at > now() - interval '24 hours'", [s.id]);
      const bl  = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND capi_pushed_at IS NULL AND ts > now() - interval '7 days'", [s.id]);
      const p7  = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND capi_pushed_at IS NOT NULL AND ts > now() - $2::interval", [s.id, iv]);

      let anyOrders = null, paidOrders = null;
      if (s.shopify_api_key && s.shopify_api_secret && s.shop_domain) {
        const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
        const a = await shopifyAdmin(d, s, `orders/count.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}`);
        const p = await shopifyAdmin(d, s, `orders/count.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(sinceIso)}`);
        anyOrders  = (a && typeof a.count === 'number') ? a.count : null;
        paidOrders = (p && typeof p.count === 'number') ? p.count : null;
      }

      const pushed = p7.n || 0;
      const ratioAny  = anyOrders  ? +(pushed / anyOrders).toFixed(2)  : null;
      const ratioPaid = paidOrders ? +(pushed / paidOrders).toFixed(2) : null;
      let ratioStatus = 'unknown';
      if (ratioAny != null) ratioStatus = (ratioAny >= 0.85 && ratioAny <= 1.15) ? 'good' : (ratioAny > 1.15 ? 'over' : 'under');

      perStore.push({
        key: s.key, name: s.name, shop_domain: s.shop_domain,
        recorded_24h: rec.n || 0, pushed_24h: psh.n || 0, backlog_unpushed: bl.n || 0,
        shopify_orders_7d: anyOrders, shopify_paid_7d: paidOrders, pushed_7d: pushed,
        ratio_vs_all: ratioAny, ratio_vs_paid: ratioPaid, ratio_status: ratioStatus,
      });
    }

    // ── 3) Roll up into human-readable flags ──
    const flags = [];
    if (!cronAlive) {
      flags.push(`⚠️ Cron has not run in ${minsSince == null ? 'ever (no heartbeat yet)' : minsSince + ' min'} — expected hourly. Check the Vercel cron (Pro plan required for hourly).`);
    }
    for (const st of perStore) {
      if (st.backlog_unpushed > 0 && !cronAlive) flags.push(`${st.key}: ${st.backlog_unpushed} purchase(s) recorded but not pushed, and the cron isn't draining them.`);
      else if (st.backlog_unpushed >= 25) flags.push(`${st.key}: ${st.backlog_unpushed} purchase(s) waiting to push — larger than a normal hour's queue.`);
      if (st.ratio_status === 'over')  flags.push(`${st.key}: pushing ${st.ratio_vs_all}× vs ALL Shopify orders — possible duplicate order ids or a re-run.`);
      if (st.ratio_status === 'under') flags.push(`${st.key}: only ${st.ratio_vs_all}× of orders pushed — webhook may be missing some. Run Backfill.`);
    }

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      cron: { last_run: lastRun, minutes_since: minsSince, alive: cronAlive, last_info: hb ? hb.info : null, debug: hbDebug, db: hbDb },
      stores: perStore,
      healthy: cronAlive && flags.length === 0,
      flags,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
