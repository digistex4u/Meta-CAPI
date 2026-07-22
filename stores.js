// Multi-CAPI — store management (admin dashboard backend).
// GET  /api/stores            → list stores (secrets masked) + token status
// POST /api/stores {action}   → create | update | delete | test | rotate_key
// All admin-auth gated (ADMIN_PASSWORD via ?key= / X-Admin-Key / body.adminPassword).
import { db, ensureSchema, listStores, getStoreById, getShopifyToken, shopifyAdmin, adminAuth, genId } from '../lib/core.js';
export const maxDuration = 30;

const mask = (s) => (!s ? '' : (String(s).length <= 8 ? '••••' : String(s).slice(0, 4) + '••••' + String(s).slice(-4)));
function publicStore(s) {
  return {
    id: s.id, key: s.key, name: s.name, shop_domain: s.shop_domain, storefront: s.storefront, site_url: s.site_url,
    shopify_api_key: mask(s.shopify_api_key), shopify_api_secret: mask(s.shopify_api_secret),
    shopify_webhook_secret: mask(s.shopify_webhook_secret),
    meta_pixel_id: s.meta_pixel_id || '', meta_capi_token: mask(s.meta_capi_token),
    currency: s.currency, country: s.country, status: s.status,
    has_token: !!s.shopify_token, token_age_h: s.shopify_token_at ? Math.round((Date.now() - new Date(s.shopify_token_at).getTime()) / 3600000) : null,
    created_at: s.created_at, updated_at: s.updated_at,
  };
}

export default async function handler(req, res) {
  const d = db(); await ensureSchema(d);
  if (!adminAuth(req)) return res.status(403).json({ error: 'Invalid admin password' });

  try {
    if (req.method === 'GET') {
      const stores = (await listStores(d)).filter(s => s.status !== 'deleted').map(publicStore);
      return res.status(200).json({ stores });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    const b = req.body || {};
    const action = b.action || 'create';

    if (action === 'create') {
      if (!b.name || !b.shop_domain) return res.status(400).json({ error: 'name and shop_domain required' });
      const id = genId('st'), key = genId('sk');
      const shop = String(b.shop_domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const store = String(b.storefront || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      await d.query(`INSERT INTO stores (id,key,name,shop_domain,storefront,site_url,shopify_api_key,shopify_api_secret,shopify_webhook_secret,meta_pixel_id,meta_capi_token,currency,country)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, key, b.name, shop, store, b.site_url || ('https://' + (store || shop)),
         b.shopify_api_key || '', b.shopify_api_secret || '', b.shopify_webhook_secret || '',
         b.meta_pixel_id || '', b.meta_capi_token || '', b.currency || 'INR', b.country || 'India']);
      return res.status(200).json({ ok: true, id, key });
    }

    if (action === 'update') {
      if (!b.id) return res.status(400).json({ error: 'id required' });
      const fields = { name: b.name, shop_domain: b.shop_domain, storefront: b.storefront, site_url: b.site_url,
        shopify_api_key: b.shopify_api_key, shopify_api_secret: b.shopify_api_secret, shopify_webhook_secret: b.shopify_webhook_secret,
        meta_pixel_id: b.meta_pixel_id, meta_capi_token: b.meta_capi_token, currency: b.currency, country: b.country, status: b.status };
      const sets = ['updated_at = now()']; const params = [b.id]; let n = 1;
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === '') continue;            // don't overwrite with blanks (keep existing secrets)
        let val = v;
        if (k === 'shop_domain' || k === 'storefront') val = String(v).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        params.push(val); n++; sets.push(`${k} = $${n}`);
        if (k === 'shopify_api_key' || k === 'shopify_api_secret') { sets.push('shopify_token = NULL', 'shopify_token_at = NULL'); } // creds changed → re-mint
      }
      await d.query(`UPDATE stores SET ${sets.join(', ')} WHERE id = $1`, params);
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      if (!b.id) return res.status(400).json({ error: 'id required' });
      await d.query("UPDATE stores SET status='deleted', updated_at=now() WHERE id=$1", [b.id]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'test') {
      // Mint a Shopify token from key+secret and verify by reading shop + counts
      if (!b.id) return res.status(400).json({ error: 'id required' });
      const store = await getStoreById(d, b.id);
      if (!store) return res.status(404).json({ error: 'store not found' });
      try {
        const token = await getShopifyToken(d, store, true);
        if (!token) return res.status(200).json({ ok: false, error: 'Missing Shopify API key/secret or shop domain' });
        const shop = await shopifyAdmin(d, store, 'shop.json');
        const products = await shopifyAdmin(d, store, 'products/count.json');
        const meta_ready = !!(store.meta_pixel_id && store.meta_capi_token);
        return res.status(200).json({
          ok: true, token_created: true,
          shop_name: shop && shop.shop ? shop.shop.name : null,
          shop_domain: shop && shop.shop ? shop.shop.myshopify_domain : store.shop_domain,
          product_count: products && products.count != null ? products.count : null,
          meta_ready,
        });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
