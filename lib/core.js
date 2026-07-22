// Multi-CAPI — shared core: pool, multi-tenant schema, per-store Shopify token
// (client-credentials grant, like the CRM), Admin API fetch, hashing, admin auth.
import pg from 'pg';
import crypto from 'crypto';
const { Pool } = pg;

let pool;
export function db() {
  if (!pool) pool = new Pool({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  return pool;
}

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

let _ready = false;
export async function ensureSchema(d) {
  if (_ready) return;
  await d.query(`CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,                 -- public embed key (goes in the pixel URL)
    name TEXT,
    shop_domain TEXT,                          -- xxxx.myshopify.com (Admin API + webhook identity)
    storefront TEXT,                           -- public storefront domain (brand.com)
    site_url TEXT,                             -- https://brand.com (CAPI event_source_url)
    shopify_api_key TEXT,
    shopify_api_secret TEXT,
    shopify_webhook_secret TEXT,               -- optional; falls back to api_secret
    shopify_token TEXT,
    shopify_token_at TIMESTAMPTZ,
    meta_pixel_id TEXT,
    meta_capi_token TEXT,
    currency TEXT DEFAULT 'INR',
    country TEXT DEFAULT 'India',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await d.query(`CREATE TABLE IF NOT EXISTS visitors (
    store_id TEXT NOT NULL,
    vid TEXT NOT NULL,
    contact_phone TEXT,
    first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
    sessions INT DEFAULT 1, total_events INT DEFAULT 0, lifecycle TEXT DEFAULT 'anonymous',
    first_source JSONB DEFAULT '{}'::jsonb, last_source JSONB DEFAULT '{}'::jsonb,
    product_affinity JSONB DEFAULT '{}'::jsonb, dfp TEXT,
    device_model TEXT, device_brand TEXT, device_tier TEXT, device_price_inr NUMERIC,
    profile JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (store_id, vid)
  )`);
  await d.query(`CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    store_id TEXT NOT NULL,
    vid TEXT NOT NULL, sid TEXT, event_type TEXT NOT NULL,
    page_url TEXT, page_title TEXT, referrer TEXT,
    product_id TEXT, product_name TEXT, product_type TEXT, product_price NUMERIC,
    cart_value NUMERIC, search_query TEXT,
    gclid TEXT, fbclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    device TEXT, browser TEXT, screen TEXT, city TEXT, region TEXT, country TEXT, dfp TEXT,
    capi_pushed_at TIMESTAMPTZ,
    extra JSONB DEFAULT '{}'::jsonb, ts TIMESTAMPTZ DEFAULT now()
  )`);
  await d.query(`CREATE TABLE IF NOT EXISTS capi_log (
    store_id TEXT NOT NULL, event_id TEXT NOT NULL, event_name TEXT, value NUMERIC,
    pushed_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (store_id, event_id)
  )`);
  await d.query(`CREATE INDEX IF NOT EXISTS idx_events_store_type ON events(store_id, event_type)`);
  await d.query(`CREATE INDEX IF NOT EXISTS idx_events_store_ts ON events(store_id, ts)`);
  await d.query(`CREATE INDEX IF NOT EXISTS idx_events_vid ON events(store_id, vid)`);
  await d.query(`CREATE INDEX IF NOT EXISTS idx_visitors_phone ON visitors(store_id, contact_phone)`);
  _ready = true;
}

// ── Store resolution ──
export async function getStoreByKey(d, key) {
  const { rows } = await d.query('SELECT * FROM stores WHERE key = $1 AND status = $2', [key, 'active']);
  return rows[0] || null;
}
export async function getStoreByDomain(d, domain) {
  const dom = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const { rows } = await d.query(
    `SELECT * FROM stores WHERE lower(shop_domain) = $1 OR lower(storefront) = $1
       OR $1 LIKE '%' || lower(storefront) OR lower(shop_domain) LIKE '%' || $1 LIMIT 1`, [dom]);
  return rows[0] || null;
}
export async function getStoreById(d, id) {
  const { rows } = await d.query('SELECT * FROM stores WHERE id = $1', [id]);
  return rows[0] || null;
}
export async function listStores(d) {
  const { rows } = await d.query("SELECT * FROM stores ORDER BY created_at DESC");
  return rows;
}

// ── Shopify token via client-credentials grant (auto-created from key+secret) ──
export async function getShopifyToken(d, store, force = false) {
  if (!store.shopify_api_key || !store.shopify_api_secret || !store.shop_domain) return null;
  const ageMs = store.shopify_token_at ? (Date.now() - new Date(store.shopify_token_at).getTime()) : Infinity;
  if (!force && store.shopify_token && ageMs < 12 * 3600 * 1000) return store.shopify_token;

  const url = `https://${store.shop_domain}/admin/oauth/access_token`;
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: store.shopify_api_key, client_secret: store.shopify_api_secret, grant_type: 'client_credentials' }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.access_token) {
    const err = body.error || body.errors || ('HTTP ' + resp.status);
    throw new Error('Shopify token error: ' + JSON.stringify(err));
  }
  await d.query("UPDATE stores SET shopify_token = $1, shopify_token_at = now(), updated_at = now() WHERE id = $2", [body.access_token, store.id]);
  store.shopify_token = body.access_token; store.shopify_token_at = new Date().toISOString();
  return body.access_token;
}

// ── Shopify Admin API GET (auto-refreshes token on 401) ──
export async function shopifyAdmin(d, store, path) {
  let token = await getShopifyToken(d, store);
  if (!token) return { error: 'no_token' };
  const base = `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/`;
  let r = await fetch(base + path, { headers: { 'X-Shopify-Access-Token': token } });
  if (r.status === 401) { token = await getShopifyToken(d, store, true); r = await fetch(base + path, { headers: { 'X-Shopify-Access-Token': token } }); }
  return await r.json().catch(() => ({}));
}

// ── helpers ──
export function sha256(v) { if (!v) return null; return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex'); }
export function normalizePhoneDigits(p) { if (!p) return null; p = String(p).replace(/[^\d]/g, ''); if (p.length === 10) p = '91' + p; return p; }
export function verifyShopifyHmac(rawBody, secret, sentHeader) {
  if (!secret) return true; // no secret configured → skip
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try { return sentHeader && digest.length === sentHeader.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sentHeader)); }
  catch (e) { return false; }
}
export function adminAuth(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return true;
  const given = (req.query && req.query.key) || req.headers['x-admin-key'] || (req.body && req.body.adminPassword);
  return given === pw;
}
export function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export const CFG = { SHOPIFY_API_VERSION };
