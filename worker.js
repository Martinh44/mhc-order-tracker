// MHC Order Tracker — Cloudflare Worker
// Required environment variables (set in Cloudflare dashboard):
//   MHC_PIN                — the shared 6-digit PIN code (Secret)
//   NTFY_TOPIC             — your private ntfy topic name (Secret)
//   SHOPIFY_WEBHOOK_SECRET — webhook signing secret from Shopify (Secret)
//   SHOPIFY_CLIENT_ID      — Shopify app client ID, for barcode lookups (Secret)
//   SHOPIFY_CLIENT_SECRET  — Shopify app client secret, for barcode lookups (Secret)
//   (NTFY_TOPIC also receives carbon-pricing alerts, at most one per 6 hours)
// Required cron trigger (Settings → Triggers): */10 * * * *  — carbon option pricing (forged + matte) + completing new Packtechz products
// Required KV binding:
//   MHC_KV     — KV namespace named MHC_ORDERS

const LOCKOUT_AFTER  = 10;   // wrong attempts before 15-min lockout
const BLOCK_AFTER    = 50;   // wrong attempts total before permanent block
const LOCKOUT_TTL    = 900;  // 15 minutes in seconds

const SHOPIFY_VENDORS = ['mhjc', 'vanté automotive', 'vante automotive'];
const SHOPIFY_SHOP    = 'ujyuxq-uh.myshopify.com';
const SHOPIFY_API     = '2026-07';

// Carbon option pricing: multipliers live on an admin-only collection in Shopify
// (Collections → "Carbon Option Pricing (Packtechz)" → Forged carbon / Matte finish price multiplier).
const PRICING_COLLECTION = 'gid://shopify/Collection/353647591542';
const TWILL_VALUE        = '2x2 Twill Carbon Fibre';
const FORGED_VALUE       = 'Forged Carbon Fibre';

export default {
  // Cron trigger (Cloudflare dashboard → Settings → Triggers → Cron: */10 * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCarbonJobs(env));
  },

  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-PIN',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Shopify webhook — authenticated via HMAC, not PIN
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook/shopify') {
      return handleShopifyWebhook(request, env, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const blockedKey  = `blocked:${ip}`;
    const attemptsKey = `attempts:${ip}`;
    const lockoutKey  = `lockout:${ip}`;

    // 1 — Permanent block check
    const isBlocked = await env.MHC_KV.get(blockedKey);
    if (isBlocked) {
      return new Response(JSON.stringify({ error: 'blocked' }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // 2 — Temporary lockout check (resets every 15 min)
    const isLockedOut = await env.MHC_KV.get(lockoutKey);
    if (isLockedOut) {
      return new Response(JSON.stringify({ error: 'locked' }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // 3 — Validate PIN
    const pin = request.headers.get('X-PIN') || '';
    if (!env.MHC_PIN || pin !== env.MHC_PIN) {
      const attemptsRaw = await env.MHC_KV.get(attemptsKey);
      const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;
      const newAttempts = attempts + 1;

      if (newAttempts >= BLOCK_AFTER) {
        // Permanent block — store forever, no TTL
        await Promise.all([
          env.MHC_KV.put(blockedKey, String(Date.now())),
          env.MHC_KV.delete(attemptsKey),
          env.MHC_KV.delete(lockoutKey),
          notify(env, ip, newAttempts),
        ]);
      } else {
        // Increment lifetime counter
        await env.MHC_KV.put(attemptsKey, String(newAttempts));
        // Temporary lockout every 10 failed attempts
        if (newAttempts % LOCKOUT_AFTER === 0) {
          await env.MHC_KV.put(lockoutKey, '1', { expirationTtl: LOCKOUT_TTL });
        }
      }

      return new Response(JSON.stringify({ error: 'Invalid PIN' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // 4 — Correct PIN — clear all counters
    await Promise.all([
      env.MHC_KV.delete(attemptsKey),
      env.MHC_KV.delete(lockoutKey),
    ]);

    if (request.method === 'GET' && url.pathname === '/orders') {
      const data = await env.MHC_KV.get('orders');
      return new Response(data || '{"orders":[],"savedAt":0}', {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'PUT' && url.pathname === '/orders') {
      const body = await request.text();
      try { JSON.parse(body); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      await env.MHC_KV.put('orders', body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};

// ── Shopify webhook handler ───────────────────────────────────────────
async function handleShopifyWebhook(request, env, cors) {
  const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !env.SHOPIFY_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  const rawBody = await request.text();

  // Verify HMAC-SHA256 signature
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SHOPIFY_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  if (expected !== hmacHeader) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  const order = JSON.parse(rawBody);

  // Only process line items from MHJC / Vanté Automotive
  const qualifying = (order.line_items || []).filter(
    item => SHOPIFY_VENDORS.includes((item.vendor || '').toLowerCase().trim())
  );
  if (!qualifying.length) {
    return new Response(JSON.stringify({ ok: true, skipped: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Read current orders from KV
  const stored = await env.MHC_KV.get('orders');
  const data = stored ? JSON.parse(stored) : { orders: [], savedAt: 0 };
  const orders = Array.isArray(data) ? data : (data.orders || []);

  // Deduplicate — Shopify can fire the same webhook more than once
  const shopifyId = String(order.id);
  if (orders.some(o => o.shopifyOrderId === shopifyId)) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Build address
  const addr = order.shipping_address || order.billing_address || {};
  const addressParts = [
    addr.address1, addr.address2,
    addr.city, addr.province_code || addr.province,
    addr.zip, addr.country,
  ].filter(Boolean);

  // Order webhooks don't include barcodes, so look them up per variant; fall back to SKU then name
  const barcodes = await fetchBarcodes(env, qualifying.map(i => i.variant_id));
  const skus = qualifying
    .map(i => barcodes[i.variant_id] || i.sku || i.name)
    .filter(Boolean).join('\n');

  // Generate next MHC-XXX ID
  const maxNum = orders.length
    ? Math.max(...orders.map(o => parseInt(o.id.slice(4), 10) || 0))
    : 0;
  const newId = 'MHC-' + String(maxNum + 1).padStart(3, '0');

  const now = Date.now();
  const card = {
    id: newId,
    draft: true,
    shopifyOrderId: shopifyId,
    shopifyOrderName: order.name || '',
    customerName: [
      addr.first_name || order.customer?.first_name,
      addr.last_name  || order.customer?.last_name,
    ].filter(Boolean).join(' '),
    email:        order.email || order.customer?.email || '',
    phone:        order.phone || addr.phone || order.customer?.phone || '',
    address:      addressParts.join(', '),
    partNumbers:  skus,
    tracking:     '',
    notes:        '',
    stages:       [false, false, false, false, false],
    createdAt:    new Date(order.created_at || now).getTime(),
    lastUpdated:  now,
  };

  orders.push(card);
  await env.MHC_KV.put('orders', JSON.stringify({ orders, savedAt: now }));

  return new Response(JSON.stringify({ ok: true, id: newId }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── Shopify barcode lookup ───────────────────────────────────────────
async function getShopifyToken(env) {
  const cached = await env.MHC_KV.get('shopify_token');
  if (cached) return cached;
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const { access_token, expires_in } = await r.json();
  await env.MHC_KV.put('shopify_token', access_token, {
    expirationTtl: Math.max(60, (expires_in || 86400) - 600),
  });
  return access_token;
}

async function fetchBarcodes(env, variantIds) {
  const ids = [...new Set(variantIds.filter(Boolean))];
  if (!ids.length || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return {};
  try {
    const token = await getShopifyToken(env);
    const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        query: 'query($ids:[ID!]!){nodes(ids:$ids){...on ProductVariant{legacyResourceId barcode}}}',
        variables: { ids: ids.map(id => `gid://shopify/ProductVariant/${id}`) },
      }),
    });
    const { data } = await r.json();
    const map = {};
    for (const n of data?.nodes || []) {
      if (n?.barcode) map[n.legacyResourceId] = n.barcode;
    }
    return map;
  } catch {
    return {};
  }
}

// ── ntfy alert ───────────────────────────────────────────────────────
async function notify(env, ip, attempts) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title': '🔒 MHC Tracker — IP Blocked',
        'Priority': 'urgent',
        'Tags': 'warning,no_entry',
      },
      body: `An IP address (${ip}) has been permanently blocked after ${attempts} failed PIN attempts.`,
    });
  } catch {}
}

// ── Carbon option price sync ─────────────────────────────────────────
// Every Packtechz product: Material (2x2 Twill | Forged) × Finish (Gloss | Matte, matte for twill only).
// Base price = 2x2 twill / gloss. Forged = base × forged multiplier, twill matte = base × matte multiplier,
// both rounded to .95. Only variants whose price is off get written, so running often is cheap.
async function shopifyGql(env, query, variables) {
  const token = await getShopifyToken(env);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await r.json();
    const throttled = (json.errors || []).some(e => e.extensions && e.extensions.code === 'THROTTLED');
    if (throttled) { await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); continue; }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
  throw new Error('Shopify API still throttled after retries');
}

function priceX(price, multiplier) {
  if (price == null) return null;
  return (Math.round(Number(price) * multiplier) - 0.05).toFixed(2);
}

function optionValue(variant, name) {
  const o = variant.selectedOptions.find(x => x.name === name);
  return o ? o.value : null;
}

async function syncCarbonPrices(env) {
  const updates = [];
  const newProducts = [];     // only a default variant yet: needs Material + Finish
  const needsFinish = [];     // has Material but no Finish option yet
  let forgedM = null, matteM = null;
  let cursor = null;
  do {
    const data = await shopifyGql(env, `query($id:ID!,$c:String){collection(id:$id){
      fm:metafield(namespace:"custom",key:"forged_multiplier"){value}
      mm:metafield(namespace:"custom",key:"matte_multiplier"){value}
      products(first:100,after:$c){pageInfo{hasNextPage endCursor}
        nodes{id status options{name} variants(first:20){nodes{id price compareAtPrice selectedOptions{name value}}}}}}}`,
      { id: PRICING_COLLECTION, c: cursor });
    const col = data.collection;
    forgedM = Number(col?.fm?.value);
    matteM = Number(col?.mm?.value);
    if (!(forgedM >= 1 && forgedM <= 3)) return { error: 'forged multiplier missing or out of range', value: col?.fm?.value };
    if (!(matteM >= 1 && matteM <= 3)) return { error: 'matte multiplier missing or out of range', value: col?.mm?.value };
    for (const p of col.products.nodes) {
      const vs = p.variants.nodes;
      const names = p.options.map(o => o.name);
      if (p.status === 'ACTIVE' && vs.length === 1 && vs[0].selectedOptions[0]?.value === 'Default Title') { newProducts.push(p.id); continue; }
      if (p.status === 'ACTIVE' && names.length === 1 && names[0] === 'Material') needsFinish.push(p.id);
      const finish = v => optionValue(v, 'Finish');
      const base = vs.find(v => optionValue(v, 'Material') === TWILL_VALUE && (!finish(v) || finish(v) === 'Gloss'));
      if (!base) continue;
      const targets = [
        [vs.find(v => optionValue(v, 'Material') === FORGED_VALUE), forgedM],
        [vs.find(v => optionValue(v, 'Material') === TWILL_VALUE && finish(v) === 'Matte'), matteM],
      ];
      for (const [v, m] of targets) {
        if (!v) continue;
        const price = priceX(base.price, m);
        const compareAtPrice = priceX(base.compareAtPrice, m);
        if (Number(v.price) !== Number(price) || Number(v.compareAtPrice || 0) !== Number(compareAtPrice || 0)) {
          updates.push({ productId: p.id, variant: { id: v.id, price, compareAtPrice } });
        }
      }
    }
    cursor = col.products.pageInfo.hasNextPage ? col.products.pageInfo.endCursor : null;
  } while (cursor);

  // Group per product (one productVariantsBulkUpdate each), 25 products per request via aliases
  const byProduct = new Map();
  for (const u of updates) {
    if (!byProduct.has(u.productId)) byProduct.set(u.productId, []);
    byProduct.get(u.productId).push(u.variant);
  }
  const groups = [...byProduct.entries()];
  const errors = [];
  for (let i = 0; i < groups.length; i += 25) {
    const batch = groups.slice(i, i + 25);
    const vars = {};
    const defs = [];
    const calls = batch.map(([productId, variants], n) => {
      vars[`p${n}`] = productId;
      vars[`v${n}`] = variants;
      defs.push(`$p${n}:ID!,$v${n}:[ProductVariantsBulkInput!]!`);
      return `u${n}:productVariantsBulkUpdate(productId:$p${n},variants:$v${n}){userErrors{field message}}`;
    });
    const data = await shopifyGql(env, `mutation(${defs.join(',')}){${calls.join(' ')}}`, vars);
    for (const res of Object.values(data)) errors.push(...res.userErrors);
  }
  return { forgedM, matteM, updated: updates.length, errors, newProducts, needsFinish };
}

// Runs every 10 minutes: complete new active Packtechz products, then fix any stale prices.
// Alerts via ntfy (at most every 6 hours) if anything fails, so problems never go unnoticed.
async function runCarbonJobs(env) {
  const problems = [];
  try {
    const result = await syncCarbonPrices(env);
    if (result.error) problems.push(result.error);
    problems.push(...(result.errors || []).map(e => e.message));
    const done = [];
    // A few per run keeps us well inside the Worker subrequest limit; the rest follow 10 minutes later
    for (const id of (result.newProducts || []).slice(0, 2)) {
      const r = await addForgedVariant(env, id, result.forgedM);
      if (r.error) { problems.push(r.error); continue; }
      if (r.added) {
        const m = await addMatteVariant(env, id, result.matteM);
        if (m.error) problems.push(m.error); else done.push(r.title);
      }
    }
    for (const id of (result.needsFinish || []).slice(0, 3)) {
      const m = await addMatteVariant(env, id, result.matteM);
      if (m.error) problems.push(m.error); else if (m.added) done.push(m.title);
    }
    console.log('carbon jobs', JSON.stringify({ ...result, newProducts: (result.newProducts || []).length, needsFinish: (result.needsFinish || []).length, done }));
  } catch (e) {
    problems.push(String(e && e.message || e));
  }
  if (problems.length) await alertOnce(env, 'Carbon option pricing needs attention', problems.slice(0, 5).join('\n'));
}

const CARBON_PARA = '<p><strong>Choose your carbon.</strong> Classic 2x2 twill carbon fibre in a high-gloss or matte clearcoat, ' +
  'or forged carbon fibre in high-gloss. Forged carbon has a marbled pattern that is unique to every part, so no two are alike.</p>';

const VARIANT_FIELDS = `id price compareAtPrice sku barcode inventoryPolicy taxable deliveryProfile{id} selectedOptions{name value}
  inventoryItem{tracked requiresShipping measurement{weight{value unit}}
    inventoryLevels(first:5){nodes{location{id} quantities(names:["available"]){quantity}}}}`;

// A copy of the base variant under new option values: same stock, weight, policy; SKU/barcode + suffix
function cloneVariant(base, optionValues, price, compareAtPrice, suffix) {
  const ii = base.inventoryItem;
  const v = {
    optionValues, price, compareAtPrice,
    inventoryPolicy: base.inventoryPolicy,
    taxable: base.taxable,
    barcode: base.barcode ? base.barcode + suffix : null,
    inventoryItem: { sku: base.sku + suffix, tracked: ii.tracked, requiresShipping: ii.requiresShipping },
    inventoryQuantities: ii.inventoryLevels.nodes.map(l => ({ locationId: l.location.id, availableQuantity: l.quantities[0].quantity })),
  };
  if (ii.measurement?.weight) v.inventoryItem.measurement = { weight: ii.measurement.weight };
  return v;
}

async function createVariantNextTo(env, productId, base, variant) {
  let r = await shopifyGql(env, `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){
    productVariantsBulkCreate(productId:$pid,variants:$v){productVariants{id} userErrors{message}}}`, { pid: productId, v: [variant] });
  if (r.productVariantsBulkCreate.userErrors.length) return { error: r.productVariantsBulkCreate.userErrors[0].message };
  const id = r.productVariantsBulkCreate.productVariants[0].id;
  // New variants land in the General profile (international only) unless moved next to their sibling
  if (base.deliveryProfile?.id) {
    r = await shopifyGql(env, `mutation($id:ID!,$p:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$p){userErrors{message}}}`,
      { id: base.deliveryProfile.id, p: { variantsToAssociate: [id] } });
    if (r.deliveryProfileUpdate.userErrors.length) return { error: 'shipping profile — ' + r.deliveryProfileUpdate.userErrors[0].message };
  }
  return { id };
}

async function setCarbonParagraph(env, p) {
  const html = p.descriptionHtml || '';
  let next;
  if (html.includes('Choose your carbon.')) next = html.replace(/<p><strong>Choose your carbon\.<\/strong>[\s\S]*?<\/p>/, CARBON_PARA);
  else {
    const i = html.indexOf('</p>');
    next = i >= 0 ? html.slice(0, i + 4) + CARBON_PARA + html.slice(i + 4) : CARBON_PARA + html;
  }
  if (next !== html) {
    await shopifyGql(env, `mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`,
      { p: { id: p.id, descriptionHtml: next } });
  }
}

// Step 1 for a new product: keep the existing variant as 2x2 twill and add forged
async function addForgedVariant(env, productId, multiplier) {
  const { product: p } = await shopifyGql(env, `query($id:ID!){product(id:$id){id title descriptionHtml
    options{id name optionValues{id name}} variants(first:2){nodes{${VARIANT_FIELDS}}}}}`, { id: productId });
  const s = p.variants.nodes[0];
  // Leave half-finished listings alone until they have a price and SKU
  if (!s || !s.sku || !(Number(s.price) > 0) || p.options[0].name !== 'Title') return { added: false };

  const opt = p.options[0];
  const r = await shopifyGql(env, `mutation($pid:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){
    productOptionUpdate(productId:$pid,option:$o,optionValuesToUpdate:$v){userErrors{message}}}`,
    { pid: p.id, o: { id: opt.id, name: 'Material' }, v: [{ id: opt.optionValues[0].id, name: TWILL_VALUE }] });
  if (r.productOptionUpdate.userErrors.length) return { error: `${p.title}: ${r.productOptionUpdate.userErrors[0].message}` };

  const v = cloneVariant(s, [{ optionName: 'Material', name: FORGED_VALUE }],
    priceX(s.price, multiplier), priceX(s.compareAtPrice, multiplier), '-FC');
  const c = await createVariantNextTo(env, p.id, s, v);
  if (c.error) return { error: `${p.title}: ${c.error}` };
  return { added: true, title: p.title };
}

// Step 2: add Finish (Gloss | Matte). Existing variants become Gloss; add 2x2 twill / Matte.
async function addMatteVariant(env, productId, multiplier) {
  const { product: p } = await shopifyGql(env, `query($id:ID!){product(id:$id){id title descriptionHtml
    options{name} variants(first:10){nodes{${VARIANT_FIELDS}}}}}`, { id: productId });
  const names = p.options.map(o => o.name);
  if (names.includes('Finish') || names.length !== 1 || names[0] !== 'Material') return { added: false };
  const base = p.variants.nodes.find(v => optionValue(v, 'Material') === TWILL_VALUE);
  if (!base || !base.sku) return { added: false };

  const r = await shopifyGql(env, `mutation($p:ID!,$o:[OptionCreateInput!]!){
    productOptionsCreate(productId:$p,options:$o,variantStrategy:LEAVE_AS_IS){userErrors{message}}}`,
    { p: p.id, o: [{ name: 'Finish', values: [{ name: 'Gloss' }, { name: 'Matte' }] }] });
  if (r.productOptionsCreate.userErrors.length) return { error: `${p.title}: ${r.productOptionsCreate.userErrors[0].message}` };

  const v = cloneVariant(base, [{ optionName: 'Material', name: TWILL_VALUE }, { optionName: 'Finish', name: 'Matte' }],
    priceX(base.price, multiplier), priceX(base.compareAtPrice, multiplier), '-MT');
  const c = await createVariantNextTo(env, p.id, base, v);
  if (c.error) return { error: `${p.title}: ${c.error}` };
  await setCarbonParagraph(env, p);
  const tr = await translateOptions(env, p.id);
  if (tr.error) return { error: `${p.title}: translations — ${tr.error}` };
  return { added: true, title: p.title };
}

// Option translations for the store's languages (same table as theme_premium/translate_options.py).
// Registered as Shopify translations, so they also show in cart, checkout and order emails.
const OPTION_TRANSLATIONS = {
  'Material': { de: 'Material', fr: 'Matériau', es: 'Material', it: 'Materiale', ja: '素材' },
  'Finish': { de: 'Oberfläche', fr: 'Finition', es: 'Acabado', it: 'Finitura', ja: '仕上げ' },
  '2x2 Twill Carbon Fibre': { de: 'Carbon 2x2 Twill', fr: 'Carbone sergé 2x2', es: 'Fibra de carbono twill 2x2', it: 'Carbonio twill 2x2', ja: '2x2綾織カーボン' },
  'Forged Carbon Fibre': { de: 'Forged Carbon', fr: 'Carbone forgé', es: 'Carbono forjado', it: 'Carbonio forgiato', ja: 'フォージドカーボン' },
  'Gloss': { de: 'Glänzend', fr: 'Brillant', es: 'Brillante', it: 'Lucido', ja: 'グロス' },
  'Matte': { de: 'Matt', fr: 'Mat', es: 'Mate', it: 'Opaco', ja: 'マット' },
};

async function translateOptions(env, productId) {
  const { product } = await shopifyGql(env, `query($id:ID!){product(id:$id){options{id optionValues{id}}}}`, { id: productId });
  const ids = product.options.flatMap(o => [o.id, ...o.optionValues.map(v => v.id)]);
  const { translatableResourcesByIds: res } = await shopifyGql(env, `query($ids:[ID!]!){translatableResourcesByIds(first:50,resourceIds:$ids){
    nodes{resourceId translatableContent{key value digest}}}}`, { ids });
  const vars = {};
  const defs = [];
  const calls = [];
  res.nodes.forEach((n, i) => {
    const c = n.translatableContent.find(x => x.key === 'name');
    const t = c && OPTION_TRANSLATIONS[c.value];
    if (!t) return;
    vars[`r${i}`] = n.resourceId;
    vars[`t${i}`] = Object.entries(t).map(([locale, value]) => ({ locale, key: 'name', value, translatableContentDigest: c.digest }));
    defs.push(`$r${i}:ID!,$t${i}:[TranslationInput!]!`);
    calls.push(`x${i}:translationsRegister(resourceId:$r${i},translations:$t${i}){userErrors{message}}`);
  });
  if (!calls.length) return { error: null };
  const data = await shopifyGql(env, `mutation(${defs.join(',')}){${calls.join(' ')}}`, vars);
  const errs = Object.values(data).flatMap(r => r.userErrors);
  return { error: errs.length ? errs[0].message : null };
}

async function alertOnce(env, title, body) {
  console.log('ALERT', title, body);
  if (!env.NTFY_TOPIC || await env.MHC_KV.get('forged_alert')) return;
  await env.MHC_KV.put('forged_alert', '1', { expirationTtl: 6 * 3600 });
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': 'high', 'Tags': 'warning' },
      body,
    });
  } catch {}
}
