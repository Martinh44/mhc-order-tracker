// MHC Order Tracker — Cloudflare Worker
// Required environment variables (set in Cloudflare dashboard):
//   MHC_PIN  — the shared 6-digit PIN code (Secret)
// Required KV binding:
//   MHC_KV   — KV namespace named MHC_ORDERS

const MAX_ATTEMPTS = 10;
const LOCKOUT_TTL  = 900; // 15 minutes in seconds

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-PIN',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Rate limiting — track failed attempts per IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const attemptKey = `attempts:${ip}`;
    const attemptsRaw = await env.MHC_KV.get(attemptKey);
    const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;

    if (attempts >= MAX_ATTEMPTS) {
      return new Response(JSON.stringify({ error: 'locked' }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Validate PIN
    const pin = request.headers.get('X-PIN') || '';
    if (!env.MHC_PIN || pin !== env.MHC_PIN) {
      // Increment failed attempt counter, auto-expires after 15 min
      await env.MHC_KV.put(attemptKey, String(attempts + 1), { expirationTtl: LOCKOUT_TTL });
      return new Response(JSON.stringify({ error: 'Invalid PIN' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Correct PIN — clear any failed attempt counter
    await env.MHC_KV.delete(attemptKey);

    const url = new URL(request.url);

    // GET /orders — return stored orders
    if (request.method === 'GET' && url.pathname === '/orders') {
      const data = await env.MHC_KV.get('orders');
      return new Response(data || '{"orders":[],"savedAt":0}', {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // PUT /orders — save orders
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
