-- Multi-CAPI — Postgres schema (auto-created by the app too; here for reference).
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,                 -- public embed key (goes in the pixel URL ?s=)
  name TEXT,
  shop_domain TEXT,                          -- xxxx.myshopify.com (Admin API + webhook identity)
  storefront TEXT,                           -- public storefront domain (brand.com)
  site_url TEXT,
  shopify_api_key TEXT,
  shopify_api_secret TEXT,
  shopify_webhook_secret TEXT,               -- optional; falls back to api_secret
  shopify_token TEXT,                        -- auto-minted via client-credentials
  shopify_token_at TIMESTAMPTZ,
  meta_pixel_id TEXT,
  meta_capi_token TEXT,
  currency TEXT DEFAULT 'INR',
  country TEXT DEFAULT 'India',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS visitors (
  store_id TEXT NOT NULL, vid TEXT NOT NULL,
  contact_phone TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
  sessions INT DEFAULT 1, total_events INT DEFAULT 0, lifecycle TEXT DEFAULT 'anonymous',
  first_source JSONB DEFAULT '{}'::jsonb, last_source JSONB DEFAULT '{}'::jsonb,
  product_affinity JSONB DEFAULT '{}'::jsonb, dfp TEXT,
  device_model TEXT, device_brand TEXT, device_tier TEXT, device_price_inr NUMERIC,
  profile JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (store_id, vid)
);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, store_id TEXT NOT NULL,
  vid TEXT NOT NULL, sid TEXT, event_type TEXT NOT NULL,
  page_url TEXT, page_title TEXT, referrer TEXT,
  product_id TEXT, product_name TEXT, product_type TEXT, product_price NUMERIC,
  cart_value NUMERIC, search_query TEXT,
  gclid TEXT, fbclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  device TEXT, browser TEXT, screen TEXT, city TEXT, region TEXT, country TEXT, dfp TEXT,
  capi_pushed_at TIMESTAMPTZ, extra JSONB DEFAULT '{}'::jsonb, ts TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_store_type ON events(store_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_store_ts   ON events(store_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_vid        ON events(store_id, vid);
CREATE INDEX IF NOT EXISTS idx_visitors_phone    ON visitors(store_id, contact_phone);

CREATE TABLE IF NOT EXISTS capi_log (
  store_id TEXT NOT NULL, event_id TEXT NOT NULL, event_name TEXT, value NUMERIC,
  pushed_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (store_id, event_id)
);
