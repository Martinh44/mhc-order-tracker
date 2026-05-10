// MHC Order Tracker — Cloudflare Worker
// Required environment variables (set in Cloudflare dashboard):
//   MHC_PIN  — the shared PIN code  (Secret)
// Required KV binding:
//   MHC_KV   — KV namespace named MHC_ORDERS

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

    // Validate PIN on every request
    const pin = request.headers.get('X-PIN') || '';
    if (!env.MHC_PIN || pin !== env.MHC_PIN) {
      return new Response(JSON.stringify({ error: 'Invalid PIN' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);

    // GET /orders — return stored orders
    if (request.method === 'GET' && url.pathname === '/orders') {
      const data = await env.MHC_KV.get('orders');
      return new Response(data || '{"orders":[],"savedAt":0}', {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // PUT /orders — overwrite stored orders
    if (request.method === 'PUT' && url.pathname === '/orders') {
      const body = await request.text();
      // Basic sanity check — must be valid JSON
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
