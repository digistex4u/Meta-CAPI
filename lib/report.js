// Multi-CAPI — shared health/sanity report builder.
// Used by /api/meta-capi?report=1 (which is never edge-cached, unlike the read-only endpoints).
import { listStores, shopifyAdmin } from './core.js';

export async function buildReport(d, days) {
  days = Math.max(1, Math.min(30, parseInt(days || 7, 10)));
  const iv = `${days} days`;
  const CRON_MAX_MIN = 120; // hourly cron → alive if it ran within 2h

  // Cron heartbeat
  let hb = null, hbDebug = 'ok';
  try {
    const rows = await d.query("SELECT k, ts, info FROM system_health").then(r => r.rows);
    hbDebug = 'rows=' + rows.length;
    hb = rows.find(r => r.k === 'meta_capi_last_run') || null;
  } catch (e) { hbDebug = 'read_error: ' + e.message; }
  const lastRun = hb ? hb.ts : null;
  const minsSince = lastRun ? Math.round((Date.now() - new Date(lastRun).getTime()) / 60000) : null;
  const cronAlive = minsSince != null && minsSince <= CRON_MAX_MIN;

  // Per-store metrics
  const stores = (await listStores(d)).filter(s => s.status !== 'deleted');
  const perStore = [];
  for (const s of stores) {
    const q = (sql, p) => d.query(sql, p).then(r => r.rows[0] || {}).catch(() => ({}));
    const rec = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND ts > now() - interval '24 hours'", [s.id]);
    const psh = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND capi_pushed_at > now() - interval '24 hours'", [s.id]);
    const bl  = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND capi_pushed_at IS NULL AND ts > now() - interval '7 days'", [s.id]);
    const p7  = await q("SELECT count(*)::int n FROM events WHERE store_id=$1 AND event_type='purchase' AND capi_pushed_at IS NOT NULL AND ts > now() - $2::interval", [s.id, iv]);

    // Day-on-day purchases (IST calendar day) for sanity checks
    const daily = await d.query(
      `SELECT to_char((ts AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS date,
              count(*)::int recorded,
              count(*) FILTER (WHERE capi_pushed_at IS NOT NULL)::int pushed,
              round(coalesce(sum(coalesce(cart_value,product_price,0)),0))::int value
       FROM events
       WHERE store_id=$1 AND event_type='purchase' AND ts > now() - interval '7 days'
       GROUP BY date ORDER BY date DESC`, [s.id]).then(r => r.rows).catch(() => []);

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
      ratio_vs_all: ratioAny, ratio_vs_paid: ratioPaid, ratio_status: ratioStatus, daily,
    });
  }

  // Day-on-day totals across all stores
  const dtMap = {};
  for (const st of perStore) for (const row of (st.daily || [])) {
    if (!dtMap[row.date]) dtMap[row.date] = { date: row.date, recorded: 0, pushed: 0, value: 0 };
    dtMap[row.date].recorded += row.recorded; dtMap[row.date].pushed += row.pushed; dtMap[row.date].value += row.value;
  }
  const dailyTotals = Object.values(dtMap).sort((a, b) => b.date.localeCompare(a.date));

  const flags = [];
  if (!cronAlive) flags.push(`⚠️ Cron has not run in ${minsSince == null ? 'ever (no heartbeat)' : minsSince + ' min'} — expected hourly.`);
  for (const st of perStore) {
    if (st.backlog_unpushed > 0 && !cronAlive) flags.push(`${st.key}: ${st.backlog_unpushed} purchase(s) waiting, cron not draining.`);
    else if (st.backlog_unpushed >= 25) flags.push(`${st.key}: ${st.backlog_unpushed} purchase(s) waiting to push.`);
    if (st.ratio_status === 'over')  flags.push(`${st.key}: pushing ${st.ratio_vs_all}× vs all Shopify orders — possible duplicates.`);
    if (st.ratio_status === 'under') flags.push(`${st.key}: only ${st.ratio_vs_all}× of orders pushed — run Backfill.`);
  }

  return {
    generated_at: new Date().toISOString(),
    cron: { last_run: lastRun, minutes_since: minsSince, alive: cronAlive, last_info: hb ? hb.info : null, debug: hbDebug },
    stores: perStore,
    daily_totals: dailyTotals,
    healthy: cronAlive && flags.length === 0,
    flags,
  };
}
