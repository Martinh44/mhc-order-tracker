// MHC Order Tracker — Cloudflare Worker
// Required environment variables (set in Cloudflare dashboard):
//   MHC_PIN                — the shared 6-digit PIN code (Secret)
//   NTFY_TOPIC             — your private ntfy topic name (Secret)
//   SHOPIFY_WEBHOOK_SECRET — webhook signing secret from Shopify (Secret)
// Required KV binding:
//   MHC_KV     — KV namespace named MHC_ORDERS

const LOCKOUT_AFTER  = 10;   // wrong attempts before 15-min lockout
const BLOCK_AFTER    = 50;   // wrong attempts total before permanent block
const LOCKOUT_TTL    = 900;  // 15 minutes in seconds

const SHOPIFY_VENDORS = ['mhjc', 'vanté automotive', 'vante automotive'];

export default {
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

  // Barcodes from qualifying line items (one per line), fallback to SKU then name
  const skus = qualifying.map(i => i.barcode || i.sku || i.name).filter(Boolean).join('\n');

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
