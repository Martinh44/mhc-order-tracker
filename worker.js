// MHC Order Tracker — Cloudflare Worker
// Required environment variables (set in Cloudflare dashboard):
//   MHC_PIN    — the shared 6-digit PIN code (Secret)
//   NTFY_TOPIC — your private ntfy topic name (Secret)
// Required KV binding:
//   MHC_KV     — KV namespace named MHC_ORDERS

const LOCKOUT_AFTER  = 10;   // wrong attempts before 15-min lockout
const BLOCK_AFTER    = 50;   // wrong attempts total before permanent block
const LOCKOUT_TTL    = 900;  // 15 minutes in seconds

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-PIN',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
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

    const url = new URL(request.url);

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
