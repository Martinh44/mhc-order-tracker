// MHC Order Tracker — Cloudflare Worker
// Required environment variables (set in Cloudflare dashboard):
//   MHC_PIN                — the shared 6-digit PIN code (Secret)
//   NTFY_TOPIC             — your private ntfy topic name (Secret)
//   SHOPIFY_WEBHOOK_SECRET — webhook signing secret from Shopify (Secret)
//   SHOPIFY_CLIENT_ID      — Shopify app client ID, for barcode lookups (Secret)
//   SHOPIFY_CLIENT_SECRET  — Shopify app client secret, for barcode lookups (Secret)
//   (NTFY_TOPIC also receives forged-pricing alerts, at most one per 6 hours)
// Required cron trigger (Settings → Triggers): */10 * * * *  — forged carbon pricing + new Packtechz products
// Required KV binding:
//   MHC_KV     — KV namespace named MHC_ORDERS

const LOCKOUT_AFTER  = 10;   // wrong attempts before 15-min lockout
const BLOCK_AFTER    = 50;   // wrong attempts total before permanent block
const LOCKOUT_TTL    = 900;  // 15 minutes in seconds

const SHOPIFY_VENDORS = ['mhjc', 'vanté automotive', 'vante automotive'];
const SHOPIFY_SHOP    = 'ujyuxq-uh.myshopify.com';
const SHOPIFY_API     = '2026-07';

// Forged carbon pricing: the multiplier lives on an admin-only collection in Shopify
// (Collections → "Forged Carbon Pricing (Packtechz)" → Forged carbon price multiplier).
const PRICING_COLLECTION = 'gid://shopify/Collection/353647591542';
const FORGED_VALUE       = 'Forged Carbon Fibre';

export default {
  // Cron trigger (Cloudflare dashboard → Settings → Triggers → Cron: */10 * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runForgedJobs(env));
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

// ── Forged carbon price sync ─────────────────────────────────────────
// Forged variant price = standard (2x2 twill) price × multiplier, rounded to .95.
// Only writes variants whose price is off, so running it often is cheap.
async function shopifyGql(env, query, variables) {
  const token = await getShopifyToken(env);
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function forgedPrice(price, multiplier) {
  if (price == null) return null;
  return (Math.round(Number(price) * multiplier) - 0.05).toFixed(2);
}

async function syncForgedPrices(env) {
  const updates = [];
  const newProducts = [];
  let multiplier = null;
  let cursor = null;
  do {
    const data = await shopifyGql(env, `query($id:ID!,$c:String){collection(id:$id){
      mf:metafield(namespace:"custom",key:"forged_multiplier"){value}
      products(first:100,after:$c){pageInfo{hasNextPage endCursor}
        nodes{id status variants(first:20){nodes{id price compareAtPrice selectedOptions{name value}}}}}}}`,
      { id: PRICING_COLLECTION, c: cursor });
    const col = data.collection;
    multiplier = Number(col?.mf?.value);
    if (!(multiplier >= 1 && multiplier <= 3)) return { error: 'multiplier missing or out of range', value: col?.mf?.value };
    for (const p of col.products.nodes) {
      const vs = p.variants.nodes;
      if (p.status === 'ACTIVE' && vs.length === 1 && vs[0].selectedOptions[0]?.value === 'Default Title') {
        newProducts.push(p.id);
        continue;
      }
      const material = v => (v.selectedOptions.find(o => o.name === 'Material') || {}).value;
      const forged = vs.find(v => material(v) === FORGED_VALUE);
      const standard = vs.find(v => material(v) && material(v) !== FORGED_VALUE);
      if (!forged || !standard) continue;
      const price = forgedPrice(standard.price, multiplier);
      const compareAtPrice = forgedPrice(standard.compareAtPrice, multiplier);
      if (Number(forged.price) !== Number(price) || Number(forged.compareAtPrice || 0) !== Number(compareAtPrice || 0)) {
        updates.push({ productId: p.id, variant: { id: forged.id, price, compareAtPrice } });
      }
    }
    cursor = col.products.pageInfo.hasNextPage ? col.products.pageInfo.endCursor : null;
  } while (cursor);

  // 25 products per request via aliases, to stay well inside the Worker subrequest limit
  const errors = [];
  for (let i = 0; i < updates.length; i += 25) {
    const batch = updates.slice(i, i + 25);
    const vars = {};
    const defs = [];
    const calls = batch.map((u, n) => {
      vars[`p${n}`] = u.productId;
      vars[`v${n}`] = [u.variant];
      defs.push(`$p${n}:ID!,$v${n}:[ProductVariantsBulkInput!]!`);
      return `u${n}:productVariantsBulkUpdate(productId:$p${n},variants:$v${n}){userErrors{field message}}`;
    });
    const data = await shopifyGql(env, `mutation(${defs.join(',')}){${calls.join(' ')}}`, vars);
    for (const res of Object.values(data)) errors.push(...res.userErrors);
  }
  return { multiplier, updated: updates.length, errors, newProducts };
}

// Runs every 10 minutes: give new active Packtechz products their forged option, then fix any stale prices.
// Alerts via ntfy (at most every 6 hours) if anything fails, so problems never go unnoticed.
async function runForgedJobs(env) {
  const problems = [];
  try {
    let result = await syncForgedPrices(env);
    problems.push(...result.errors.map(e => e.message));
    if (result.error) problems.push(result.error);
    const added = [];
    for (const id of (result.newProducts || []).slice(0, 5)) {   // 5 per run keeps us under the subrequest limit
      const r = await addForgedVariant(env, id, result.multiplier);
      if (r.error) problems.push(r.error); else if (r.added) added.push(r.title);
    }
    console.log('forged jobs', JSON.stringify({ ...result, added }));
  } catch (e) {
    problems.push(String(e && e.message || e));
  }
  if (problems.length) await alertOnce(env, 'Forged carbon pricing needs attention', problems.slice(0, 5).join('\n'));
}

const CARBON_PARA = '<p><strong>Choose your carbon.</strong> Available in classic 2x2 twill or forged carbon fibre, ' +
  'both finished in high-gloss clearcoat. Forged carbon has a marbled pattern that is unique to every part, so no two are alike.</p>';

// Mirrors scripts/add_forged.py: keep the existing variant as 2x2 twill, add a forged variant with the same stock,
// weight and shipping profile, SKU/barcode + "-FC", and the "Choose your carbon" line in the description.
async function addForgedVariant(env, productId, multiplier) {
  const { product: p } = await shopifyGql(env, `query($id:ID!){product(id:$id){id title descriptionHtml
    options{id name optionValues{id name}}
    variants(first:2){nodes{price compareAtPrice sku barcode inventoryPolicy taxable deliveryProfile{id}
      inventoryItem{tracked requiresShipping measurement{weight{value unit}}
        inventoryLevels(first:5){nodes{location{id} quantities(names:["available"]){quantity}}}}}}}}`, { id: productId });
  const s = p.variants.nodes[0];
  // Leave half-finished listings alone until they have a price and SKU
  if (!s || !s.sku || !(Number(s.price) > 0) || p.options[0].name !== 'Title') return { added: false };

  const opt = p.options[0];
  let r = await shopifyGql(env, `mutation($pid:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){
    productOptionUpdate(productId:$pid,option:$o,optionValuesToUpdate:$v){userErrors{message}}}`,
    { pid: p.id, o: { id: opt.id, name: 'Material' }, v: [{ id: opt.optionValues[0].id, name: '2x2 Twill Carbon Fibre' }] });
  if (r.productOptionUpdate.userErrors.length) return { error: `${p.title}: ${r.productOptionUpdate.userErrors[0].message}` };

  const ii = s.inventoryItem;
  const variant = {
    optionValues: [{ optionName: 'Material', name: FORGED_VALUE }],
    price: forgedPrice(s.price, multiplier),
    compareAtPrice: forgedPrice(s.compareAtPrice, multiplier),
    inventoryPolicy: s.inventoryPolicy,
    taxable: s.taxable,
    barcode: s.barcode ? s.barcode + '-FC' : null,
    inventoryItem: { sku: s.sku + '-FC', tracked: ii.tracked, requiresShipping: ii.requiresShipping },
    inventoryQuantities: ii.inventoryLevels.nodes.map(l => ({ locationId: l.location.id, availableQuantity: l.quantities[0].quantity })),
  };
  if (ii.measurement?.weight) variant.inventoryItem.measurement = { weight: ii.measurement.weight };
  r = await shopifyGql(env, `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){
    productVariantsBulkCreate(productId:$pid,variants:$v){productVariants{id} userErrors{message}}}`, { pid: p.id, v: [variant] });
  if (r.productVariantsBulkCreate.userErrors.length) return { error: `${p.title}: ${r.productVariantsBulkCreate.userErrors[0].message}` };
  const forgedId = r.productVariantsBulkCreate.productVariants[0].id;

  // New variants land in the General profile (international only) unless moved next to their sibling
  if (s.deliveryProfile?.id) {
    r = await shopifyGql(env, `mutation($id:ID!,$p:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$p){userErrors{message}}}`,
      { id: s.deliveryProfile.id, p: { variantsToAssociate: [forgedId] } });
    if (r.deliveryProfileUpdate.userErrors.length) return { error: `${p.title}: shipping profile — ${r.deliveryProfileUpdate.userErrors[0].message}` };
  }

  const html = p.descriptionHtml || '';
  if (!html.includes('Choose your carbon.')) {
    const i = html.indexOf('</p>');
    const next = i >= 0 ? html.slice(0, i + 4) + CARBON_PARA + html.slice(i + 4) : CARBON_PARA + html;
    await shopifyGql(env, `mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`,
      { p: { id: p.id, descriptionHtml: next } });
  }
  return { added: true, title: p.title };
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
