// Offline-CAPI Tracker (standalone) — embed on any Shopify store.
// <script src="https://YOUR-TOOL.vercel.app/tracker.js" async></script>
// Captures an anonymous device id, retains FBCLID/GCLID (first-touch, immutable),
// reads device model + price tier, and streams events to /api/track.
(function(){
  'use strict';
  // ─── ENDPOINT + STORE KEY: both auto-detected from this script's own src.
  //     Embed as: <script src="https://your-tool.vercel.app/tracker.js?s=STORE_KEY" async></script>
  var TOOL_URL = '';
  var _src = '';
  (function(){ try { var s=document.currentScript; if(!s){var a=document.getElementsByTagName('script');s=a[a.length-1];} if(s&&s.src)_src=s.src; } catch(e){} })();
  var BASE = TOOL_URL || (_src ? _src.replace(/\/tracker\.js.*$/, '') : '');
  var STORE_KEY = ''; try { var mm=_src.match(/[?&]s=([^&]+)/); if(mm) STORE_KEY=decodeURIComponent(mm[1]); } catch(e){}
  var API = BASE + '/api/track';
  var COOKIE = '_oc_vid';
  var STORE_KEY = '_oc_profile';
  var QUEUE_KEY = '_oc_queue';
  // Hybrid batch interval: the FIRST page of a session flushes every 10s — tight
  // capture while landing-page attribution (gclid/utm) and early intent matter
  // most. Every page after that flushes every 20s to cut DB operations. Session
  // scope = the tab session (sessionStorage), so a fresh visit starts tight again.
  var BATCH_INTERVAL;
  try {
    var _ocFirstPage = !sessionStorage.getItem('_oc_page_seen');
    sessionStorage.setItem('_oc_page_seen', '1');
    BATCH_INTERVAL = _ocFirstPage ? 10000 : 20000;
  } catch (e) {
    BATCH_INTERVAL = 10000; // storage blocked — default to the safer 10s
  }
  var MAX_QUEUE = 50;

  // ═══ VISITOR ID ═══
  function getVid() {
    var vid = getCookie(COOKIE) || localStorage.getItem(COOKIE);
    if (!vid) {
      vid = 'OCV' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2, 6);
      setCookie(COOKIE, vid, 365);
      localStorage.setItem(COOKIE, vid);
    }
    return vid;
  }
  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(n, v, days) {
    var d = new Date(); d.setTime(d.getTime() + days * 86400000);
    document.cookie = n + '=' + encodeURIComponent(v) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }

  // ═══ SESSION ID ═══
  function getSid() {
    var sid = sessionStorage.getItem('_oc_sid');
    if (!sid) {
      sid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem('_oc_sid', sid);
    }
    return sid;
  }

  // ═══ URL PARAMS — GCLID, FBCLID, UTM ═══
  function getParams() {
    var params = new URLSearchParams(window.location.search);
    var p = {
      gclid: params.get('gclid') || null,
      fbclid: params.get('fbclid') || null,
      utm_source: params.get('utm_source') || null,
      utm_medium: params.get('utm_medium') || null,
      utm_campaign: params.get('utm_campaign') || null,
      utm_content: params.get('utm_content') || null,
      utm_term: params.get('utm_term') || null,
    };
    // Persist attribution params (first-touch)
    var stored = JSON.parse(localStorage.getItem('_oc_attr') || '{}');
    if (p.gclid && !stored.gclid) stored.gclid = p.gclid;
    if (p.fbclid && !stored.fbclid) stored.fbclid = p.fbclid;
    if (p.utm_source && !stored.first_utm_source) {
      stored.first_utm_source = p.utm_source;
      stored.first_utm_medium = p.utm_medium;
      stored.first_utm_campaign = p.utm_campaign;
    }
    // Last-touch always updates
    if (p.utm_source) stored.last_utm_source = p.utm_source;
    if (p.utm_medium) stored.last_utm_medium = p.utm_medium;
    if (p.utm_campaign) stored.last_utm_campaign = p.utm_campaign;
    if (p.gclid) stored.last_gclid = p.gclid;
    if (p.fbclid) stored.last_fbclid = p.fbclid;
    localStorage.setItem('_oc_attr', JSON.stringify(stored));
    return { current: p, stored: stored };
  }

  // ═══ DEVICE INFO ═══
  function getDevice() {
    var w = window.innerWidth;
    return {
      device: w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop',
      browser: navigator.userAgent.indexOf('Chrome') > -1 ? 'Chrome' :
               navigator.userAgent.indexOf('Safari') > -1 ? 'Safari' :
               navigator.userAgent.indexOf('Firefox') > -1 ? 'Firefox' : 'Other',
      screen: w + 'x' + window.innerHeight,
    };
  }

  // ═══ DEVICE FINGERPRINT ═══
  function simpleHash(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash; // Convert to 32-bit int
    }
    return Math.abs(hash).toString(36);
  }

  function canvasFingerprint() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 50;
      var ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('oc.fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('oc.fp', 4, 17);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgb(255,0,255)';
      ctx.beginPath(); ctx.arc(50, 50, 50, 0, Math.PI * 2, true); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgb(0,255,255)';
      ctx.beginPath(); ctx.arc(100, 50, 50, 0, Math.PI * 2, true); ctx.closePath(); ctx.fill();
      return simpleHash(canvas.toDataURL());
    } catch(e) { return 'no_canvas'; }
  }

  function webglFingerprint() {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'no_webgl';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      var vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : 'unknown';
      return simpleHash(renderer + '|' + vendor);
    } catch(e) { return 'no_webgl'; }
  }

  function audioFingerprint() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var oscillator = ctx.createOscillator();
      var analyser = ctx.createAnalyser();
      var gain = ctx.createGain();
      var scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
      gain.gain.value = 0; // mute
      oscillator.type = 'triangle';
      oscillator.connect(analyser);
      analyser.connect(scriptProcessor);
      scriptProcessor.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(0);
      var bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      oscillator.stop();
      ctx.close();
      return simpleHash(bins.slice(0, 30).join(','));
    } catch(e) { return 'no_audio'; }
  }

  function getFonts() {
    var baseFonts = ['monospace', 'sans-serif', 'serif'];
    var testFonts = ['Arial','Courier New','Georgia','Helvetica','Times New Roman',
      'Trebuchet MS','Verdana','Tahoma','Impact','Comic Sans MS',
      'Palatino','Garamond','Bookman','Noto Sans','Roboto',
      'Lato','Open Sans','Montserrat','Poppins','Inter'];
    var detected = [];
    try {
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var baseWidths = {};
      baseFonts.forEach(function(bf) {
        ctx.font = '72px ' + bf;
        baseWidths[bf] = ctx.measureText('mmmmmmmmmmlli').width;
      });
      testFonts.forEach(function(tf) {
        for (var i = 0; i < baseFonts.length; i++) {
          ctx.font = '72px "' + tf + '",' + baseFonts[i];
          if (ctx.measureText('mmmmmmmmmmlli').width !== baseWidths[baseFonts[i]]) {
            detected.push(tf);
            break;
          }
        }
      });
    } catch(e) {}
    return detected.join(',');
  }

  function getDeviceFingerprint() {
    // Check cache first
    var cached = localStorage.getItem('_oc_dfp');
    if (cached) return cached;

    var components = [
      screen.width + 'x' + screen.height,
      screen.colorDepth,
      navigator.hardwareConcurrency || 'unk',
      navigator.deviceMemory || 'unk',
      navigator.language,
      navigator.languages ? navigator.languages.join(',') : '',
      navigator.platform,
      new Date().getTimezoneOffset(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.maxTouchPoints || 0,
      !!window.ontouchstart,
      navigator.cookieEnabled,
      !!window.indexedDB,
      !!window.sessionStorage,
      canvasFingerprint(),
      webglFingerprint(),
      getFonts(),
    ].join('|||');

    var fp = 'fp_' + simpleHash(components);
    localStorage.setItem('_oc_dfp', fp);
    return fp;
  }

  var DEVICE_FP = getDeviceFingerprint();

  // ═══ DEVICE MODEL + PRICE TIER ═══
  function getDeviceModel() {
    var ua = navigator.userAgent;
    var model = '', brand = '', tier = 'unknown';
    
    // Android: User-Agent contains model name
    var androidMatch = ua.match(/;\s*([^;)]+)\s+Build\//);
    if (androidMatch) {
      model = androidMatch[1].trim();
      // Extract brand
      if (model.indexOf('SM-') === 0 || model.indexOf('Samsung') > -1) brand = 'Samsung';
      else if (model.indexOf('Redmi') > -1 || model.indexOf('M2') > -1 || model.indexOf('22') > -1 || model.indexOf('23') > -1) brand = 'Xiaomi';
      else if (model.indexOf('RMX') > -1 || model.indexOf('Realme') > -1) brand = 'Realme';
      else if (model.indexOf('CPH') > -1 || model.indexOf('OPPO') > -1) brand = 'OPPO';
      else if (model.indexOf('V2') > -1 || model.indexOf('vivo') > -1) brand = 'Vivo';
      else if (model.indexOf('Pixel') > -1) brand = 'Google';
      else if (model.indexOf('IN2') > -1 || model.indexOf('OnePlus') > -1 || model.indexOf('NE2') > -1 || model.indexOf('CPH25') > -1) brand = 'OnePlus';
      else if (model.indexOf('Moto') > -1 || model.indexOf('moto') > -1 || model.indexOf('XT') > -1) brand = 'Motorola';
      else brand = model.split(' ')[0];
    }
    
    // iPhone: detect from screen size + pixel ratio
    if (ua.indexOf('iPhone') > -1) {
      brand = 'Apple';
      var w = screen.width, h = screen.height, r = window.devicePixelRatio || 1;
      if (h >= 932 && r >= 3) model = 'iPhone 15 Pro Max / 16 Pro Max';
      else if (h >= 896 && r >= 3) model = 'iPhone 14 Pro / 15 Pro';
      else if (h >= 844 && r >= 3) model = 'iPhone 13 / 14 / 15';
      else if (h >= 812 && r >= 3) model = 'iPhone X / 11 Pro / 12 Mini';
      else if (h >= 736 && r >= 3) model = 'iPhone 6+ / 7+ / 8+';
      else if (h >= 667 && r >= 2) model = 'iPhone 6 / 7 / 8 / SE';
      else model = 'iPhone (older)';
    }
    
    // iPad
    if (ua.indexOf('iPad') > -1) { brand = 'Apple'; model = 'iPad'; }
    
    // Price tier classification
    var PREMIUM_PATTERNS = ['SM-S9','SM-S8','SM-Z','SM-F','SM-N9','SM-G99','iPhone 15 Pro','iPhone 14 Pro','iPhone 16','Pixel 8','Pixel 9','OnePlus 12','OnePlus 11','NE2'];
    var BUDGET_PATTERNS = ['SM-A0','SM-A1','SM-M1','SM-M0','Redmi A','Redmi 1','POCO C','Realme C','Realme Narzo','iPhone 6','iPhone 7','iPhone SE','Moto E','Moto G2','Galaxy A0','Galaxy M0','V2','CPH2','SM-A04','SM-A05','SM-A12','SM-A13','SM-A14','SM-A03'];
    
    var isP = PREMIUM_PATTERNS.some(function(p) { return model.indexOf(p) > -1; });
    var isB = BUDGET_PATTERNS.some(function(p) { return model.indexOf(p) > -1; });
    
    if (brand === 'Apple' && model.indexOf('Pro') > -1) tier = 'premium';
    else if (brand === 'Apple') tier = 'mid-premium';
    else if (isP) tier = 'premium';
    else if (isB) tier = 'budget';
    else if (navigator.deviceMemory) {
      if (navigator.deviceMemory >= 8) tier = 'premium';
      else if (navigator.deviceMemory >= 4) tier = 'mid';
      else tier = 'budget';
    } else if (navigator.hardwareConcurrency) {
      if (navigator.hardwareConcurrency >= 8) tier = 'mid-premium';
      else if (navigator.hardwareConcurrency >= 4) tier = 'mid';
      else tier = 'budget';
    }
    
    // Desktop classification
    if (getDevice().device === 'desktop') {
      if (ua.indexOf('Macintosh') > -1) { brand = 'Apple'; model = 'Mac'; tier = 'premium'; }
      else if (ua.indexOf('Windows') > -1) { brand = 'Windows PC'; model = 'PC'; tier = 'mid'; }
      else { brand = 'Desktop'; model = 'Other'; tier = 'mid'; }
    }
    
    return { model: model || 'Unknown', brand: brand || 'Unknown', tier: tier, memory: navigator.deviceMemory || null, cores: navigator.hardwareConcurrency || null };
  }

  var DEVICE_MODEL = getDeviceModel();

  // ═══ DEVICE PRICE (bundled table → real ₹; falls back to heuristic tier) ═══
  var DEVICE_PRICE = { inr: null, source: 'heuristic' };
  var PRICE_TABLE = null;
  function tierFromPrice(inr, th){ th = th || { budget:15000, mid:30000, mid_premium:50000 }; if(inr>=th.mid_premium) return 'premium'; if(inr>=th.mid) return 'mid-premium'; if(inr>=th.budget) return 'mid'; return 'budget'; }
  function lookupPrice(){
    if(!PRICE_TABLE || !PRICE_TABLE.devices) return;
    var key = ((DEVICE_MODEL.model||'') + ' ' + (DEVICE_MODEL.brand||'')).toLowerCase();
    for(var i=0;i<PRICE_TABLE.devices.length;i++){
      var e=PRICE_TABLE.devices[i], ms=e.m||[];
      for(var j=0;j<ms.length;j++){
        if(key.indexOf(String(ms[j]).toLowerCase())>-1){
          DEVICE_PRICE.inr=e.inr; DEVICE_PRICE.source='table';
          DEVICE_MODEL.tier=tierFromPrice(e.inr, PRICE_TABLE.thresholds);
          return;
        }
      }
    }
  }
  function loadPrices(){
    try{ var c=JSON.parse(sessionStorage.getItem('_oc_prices')||'null'); if(c&&c.devices){ PRICE_TABLE=c; lookupPrice(); return; } }catch(e){}
    if(!BASE) return;
    fetch(BASE + '/device-prices.json').then(function(r){ return r.json(); }).then(function(tbl){
      PRICE_TABLE=tbl; try{ sessionStorage.setItem('_oc_prices', JSON.stringify(tbl)); }catch(e){}
      lookupPrice();
      updateProfile({ device_tier: DEVICE_MODEL.tier, device_price_inr: DEVICE_PRICE.inr });
    }).catch(function(){});
  }
  loadPrices();

  // ═══ IP GEOLOCATION (once per session) ═══
  var GEO_CACHE_KEY = '_oc_geo';
  var _geoData = null;
  
  function loadGeo() {
    // Check session cache first
    try {
      var cached = JSON.parse(sessionStorage.getItem(GEO_CACHE_KEY) || '{}');
      if (cached.city) { _geoData = cached; return; }
    } catch(e) {}
    
    // Fetch from free IP geolocation API (once per session)
    fetch('https://ipapi.co/json/')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _geoData = {
          city: d.city || '', region: d.region || '', country: d.country_name || d.country || '',
          ip: d.ip || '', latitude: d.latitude || '', longitude: d.longitude || '',
          timezone: d.timezone || '', isp: d.org || ''
        };
        try { sessionStorage.setItem(GEO_CACHE_KEY, JSON.stringify(_geoData)); } catch(e) {}
        // Update profile with location
        updateProfile({ city: _geoData.city, region: _geoData.region, country: _geoData.country });
      })
      .catch(function() { _geoData = { city: '', region: '', country: '' }; });
  }
  
  loadGeo();

  // ═══ VISITOR PROFILE (localStorage) ═══
  function getProfile() {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  }
  function updateProfile(updates) {
    var p = getProfile();
    for (var k in updates) p[k] = updates[k];
    p.vid = VID;
    p.last_seen = new Date().toISOString();
    p.sessions = (p.sessions || 0);
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
    return p;
  }
  function updateAffinity(productType) {
    if (!productType) return;
    var p = getProfile();
    var aff = p.product_affinity || {};
    aff[productType] = (aff[productType] || 0) + 1;
    p.product_affinity = aff;
    // Calculate top affinity
    var top = null, topScore = 0;
    for (var k in aff) { if (aff[k] > topScore) { top = k; topScore = aff[k]; } }
    p.top_affinity = top;
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  }

  // ═══ EVENT QUEUE ═══
  var queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');

  function track(eventType, data) {
    var params = getParams();
    var dev = getDevice();
    var event = {
      vid: VID,
      sid: SID,
      event_type: eventType,
      page_url: window.location.pathname + window.location.search,
      page_title: document.title,
      referrer: document.referrer,
      gclid: params.current.gclid || params.stored.last_gclid || null,
      fbclid: params.current.fbclid || params.stored.last_fbclid || null,
      utm_source: params.current.utm_source || params.stored.last_utm_source || null,
      utm_medium: params.current.utm_medium || params.stored.last_utm_medium || null,
      utm_campaign: params.current.utm_campaign || params.stored.last_utm_campaign || null,
      utm_content: params.current.utm_content || null,
      utm_term: params.current.utm_term || null,
      device: dev.device,
      browser: dev.browser,
      screen: dev.screen,
      ts: new Date().toISOString(),
      city: _geoData ? _geoData.city : '',
      region: _geoData ? _geoData.region : '',
      country: _geoData ? _geoData.country : '',
      dfp: DEVICE_FP,
    };
    if (data) {
      for (var k in data) event[k] = data[k];
    }
    queue.push(event);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
  }

  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_QUEUE);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    var profile = getProfile();
    var body = JSON.stringify({
      events: batch,
      store: STORE_KEY, hostname: location.hostname,
      visitor: { phone: profile.phone || null, email: profile.email || null },
      profile: {
        vid: VID, dfp: DEVICE_FP, sessions: profile.sessions || 1,
        device: getDevice().device, device_model: DEVICE_MODEL.model, device_brand: DEVICE_MODEL.brand, device_tier: DEVICE_MODEL.tier, device_price_inr: DEVICE_PRICE.inr,
        city: _geoData ? _geoData.city : '', region: _geoData ? _geoData.region : '', country: _geoData ? _geoData.country : '',
        utm_source: getParams().stored.last_utm_source || '', gclid: getParams().stored.last_gclid || '', fbclid: getParams().stored.last_fbclid || '',
        fbp: getCookie('_fbp') || '', fbc: getCookie('_fbc') || '', client_ip: CLIENT_IP || ''
      }
    });
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){});
  }

  // Reliable flush for when the page is hidden / unloaded. Uses sendBeacon,
  // which mobile browsers deliver even as the tab is closing or backgrounded —
  // unlike a normal fetch on beforeunload, which they frequently drop. This is
  // what lets us safely batch on a 10s timer without losing short sessions.
  function flushBeacon() {
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_QUEUE);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    var profile = getProfile();
    var body = JSON.stringify({ events: batch, store: STORE_KEY, hostname: location.hostname, visitor: { phone: profile.phone || null, email: profile.email || null } });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(API, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){});
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') flushBeacon();
  });

  // ═══ INIT ═══
  var VID = getVid();
  var SID = getSid();

  // Capture the visitor's real public IP (IPv6 when they have it) so CAPI matches the
  // pixel, which Meta receives over IPv6. Server-observed IP can be IPv4 even for IPv6
  // users (if they reach our domain over v4), so we ask Cloudflare's trace which the
  // browser hits over IPv6 when available. Non-blocking; falls back to server IP.
  var CLIENT_IP = '';
  try {
    fetch('https://www.cloudflare.com/cdn-cgi/trace').then(function(r){ return r.text(); }).then(function(t){
      var m = t.match(/ip=([^\n]+)/); if (m) CLIENT_IP = m[1].trim();
    }).catch(function(){});
  } catch (e) {}

  // Increment session count
  var profile = getProfile();
  if (!sessionStorage.getItem('_oc_session_counted')) {
    profile.sessions = (profile.sessions || 0) + 1;
    updateProfile({ sessions: profile.sessions, first_seen: profile.first_seen || new Date().toISOString(), dfp: DEVICE_FP });
    sessionStorage.setItem('_oc_session_counted', '1');
    updateProfile({ device_model: DEVICE_MODEL.model, device_brand: DEVICE_MODEL.brand, device_tier: DEVICE_MODEL.tier, device_memory: DEVICE_MODEL.memory, device_cores: DEVICE_MODEL.cores });
  }

  // ═══ AUTO-TRACKING ═══

  // 1. Page view (every page)
  track('page_view');

  // 2. Product view (Shopify product pages)
  if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product) {
    var prod = window.ShopifyAnalytics.meta.product;
    track('product_view', {
      product_id: String(prod.id),
      product_name: prod.title || prod.name,
      product_type: prod.type || prod.vendor,
      product_price: prod.price ? prod.price / 100 : null,
      extra: { variants: prod.variants ? prod.variants.length : 0, vendor: prod.vendor },
    });
    updateAffinity(prod.type || prod.vendor);
    // Update last viewed
    var lv = JSON.parse(localStorage.getItem('_oc_last_viewed') || '[]');
    lv = [{ id: prod.id, name: prod.title, type: prod.type, price: prod.price }].concat(lv.filter(function(p){ return p.id !== prod.id; })).slice(0, 10);
    localStorage.setItem('_oc_last_viewed', JSON.stringify(lv));
  }

  // 3. Collection view
  if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.page && window.ShopifyAnalytics.meta.page.pageType === 'collection') {
    track('collection_view', { extra: { collection: document.title } });
  }

  // 4. Search
  var searchParam = new URLSearchParams(window.location.search).get('q');
  if (searchParam && window.location.pathname.indexOf('/search') > -1) {
    track('search', { search_query: searchParam });
  }

  // 5. Add to cart (intercept Shopify AJAX)
  var origFetch = window.fetch;
  window.fetch = function() {
    var url = arguments[0];
    if (typeof url === 'string' && url.indexOf('/cart/add') > -1) {
      var opts = arguments[1];
      try {
        var body = opts && opts.body ? JSON.parse(opts.body) : {};
        track('add_to_cart', {
          product_id: String(body.id || ''),
          extra: { quantity: body.quantity || 1 },
        });
      } catch(e){}
    }
    return origFetch.apply(this, arguments);
  };

  // Also intercept XMLHttpRequest for older Shopify themes
  var origXHR = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && url.indexOf('/cart/add') > -1 && method.toUpperCase() === 'POST') {
      this._oc_cart_add = true;
    }
    return origXHR.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (this._oc_cart_add) {
      try {
        var data = typeof body === 'string' ? JSON.parse(body) : {};
        track('add_to_cart', { product_id: String(data.id || ''), extra: { quantity: data.quantity || 1 } });
      } catch(e){}
    }
    return origSend.apply(this, arguments);
  };

  // 5b. Checkout button intercept (Shopflo redirect)
  // Captures cart data + fires checkout_start BEFORE user leaves to Shopflo
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('a[href*="checkout"], button[name="checkout"], input[name="checkout"], [data-shopflo-checkout], a[href*="shopflo"], .shopflo-btn, #checkout-btn, .cart__checkout, [href="/checkout"]');
    if (!btn) return;
    
    // Grab cart data before redirect
    try {
      fetch('/cart.json').then(function(r) { return r.json(); }).then(function(cart) {
        var items = (cart.items || []).map(function(item) {
          return { id: item.product_id, title: item.title, price: item.price / 100, qty: item.quantity, type: item.product_type, vendor: item.vendor };
        });
        track('checkout_start', {
          cart_value: cart.total_price ? cart.total_price / 100 : 0,
          extra: { items: items, item_count: cart.item_count, currency: cart.currency, checkout_url: btn.href || btn.action || '' }
        });
        updateProfile({ cart_value: cart.total_price ? cart.total_price / 100 : 0, cart_items: cart.item_count, last_cart_at: new Date().toISOString() });
        
        // Store cart in localStorage for post-purchase matching
        localStorage.setItem('_oc_last_cart', JSON.stringify({
          vid: VID, dfp: DEVICE_FP, total: cart.total_price ? cart.total_price / 100 : 0,
          items: items, at: new Date().toISOString()
        }));
        
        flush(); // Send immediately before redirect
      }).catch(function(){});
    } catch(e) {}
  }, true); // useCapture = true to fire before redirect

  // 5d. Enhanced cart tracking — monitor cart changes via Shopify AJAX
  var _lastCartToken = '';
  function pollCart() {
    fetch('/cart.json').then(function(r) { return r.json(); }).then(function(cart) {
      if (cart.token !== _lastCartToken && _lastCartToken) {
        track('cart_update', {
          cart_value: cart.total_price ? cart.total_price / 100 : 0,
          extra: { items: cart.item_count, token: cart.token }
        });
        updateProfile({ cart_value: cart.total_price ? cart.total_price / 100 : 0, cart_items: cart.item_count });
      }
      _lastCartToken = cart.token || '';
    }).catch(function(){});
  }
  // Poll cart on pages that matter
  if (window.location.pathname === '/cart' || window.location.pathname.indexOf('/products/') > -1) {
    setTimeout(pollCart, 2000);
  }

  // 6. Cart view
  if (window.location.pathname === '/cart') {
    track('cart_view');
    // Get cart value
    fetch('/cart.json').then(function(r){ return r.json(); }).then(function(cart){
      if (cart && cart.total_price) {
        updateProfile({ cart_value: cart.total_price / 100, cart_items: cart.item_count });
        track('cart_update', { cart_value: cart.total_price / 100, extra: { items: cart.item_count } });
      }
    }).catch(function(){});
  }

  // 7. Checkout initiated
  if (window.location.pathname.indexOf('/checkout') > -1) {
    track('checkout_start');
  }

  // 8. Purchase complete (thank you page)
  if (window.Shopify && window.Shopify.checkout) {
    var checkout = window.Shopify.checkout;
    track('purchase', {
      product_name: 'Order #' + checkout.order_id,
      product_price: checkout.total_price ? parseFloat(checkout.total_price) : null,
      extra: { order_id: checkout.order_id, email: checkout.email, items: checkout.line_items ? checkout.line_items.length : 0 },
    });
    updateProfile({ lifecycle: 'customer', last_order: checkout.order_id });
    // Identity resolution: link visitor to email/phone
    if (checkout.email) updateProfile({ email: checkout.email });
    if (checkout.billing_address && checkout.billing_address.phone) updateProfile({ phone: checkout.billing_address.phone });
  }

  // 9. Exit intent (desktop only)
  if (getDevice().device === 'desktop') {
    document.addEventListener('mouseleave', function(e) {
      if (e.clientY < 10) {
        track('exit_intent');
        flush(); // send immediately on exit
      }
    }, { once: true });
  }

  // 10. Scroll depth tracking
  var maxScroll = 0;
  window.addEventListener('scroll', function() {
    var scrollPct = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
    if (scrollPct > maxScroll) maxScroll = scrollPct;
  });
  window.addEventListener('beforeunload', function() {
    if (maxScroll > 0) {
      track('scroll_depth', { extra: { depth: maxScroll } });
    }
    flushBeacon(); // send remaining events reliably on page exit (mobile-safe)
  });

  // ═══ IDENTITY RESOLUTION ═══
  // Watch for forms that capture phone/email
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var emailInput = form.querySelector('input[type="email"], input[name*="email"]');
    var phoneInput = form.querySelector('input[type="tel"], input[name*="phone"], input[name*="mobile"]');
    if (emailInput && emailInput.value) {
      updateProfile({ email: emailInput.value });
      track('identify', { extra: { method: 'form', email: emailInput.value } });
    }
    if (phoneInput && phoneInput.value) {
      updateProfile({ phone: phoneInput.value });
      track('identify', { extra: { method: 'form', phone: phoneInput.value } });
    }
  });

  // Watch for Shopify customer (logged in)
  if (window.__st && window.__st.cid) {
    updateProfile({ shopify_customer_id: window.__st.cid });
    track('identify', { extra: { method: 'shopify_login', customer_id: window.__st.cid } });
  }

  // ═══ BATCH SEND ═══
  setInterval(flush, BATCH_INTERVAL);

  // ═══ EXPOSE FOR MANUAL TRACKING ═══
  window.ocTrack = track;
  window.ocIdentify = function(data) {
    updateProfile(data);
    track('identify', { extra: data });
    flush();
  };
  window.ocProfile = getProfile;
  window.ocFingerprint = DEVICE_FP;
  window.ocDevice = DEVICE_MODEL;
  window.ocGeo = function() { return _geoData; };

  // ═══ READY HOOK ═══
  // Expose the anonymous profile for any onsite script that wants it
  window.ocReady = true;
  if (window.ocOnReady) window.ocOnReady(getProfile());

})();
