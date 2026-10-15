// ── Abandoned-checkout recovery ───────────────────────────────────────
// Shopify admin webhooks (Settings → Notifications → Webhooks, JSON) post here:
//   Checkout creation + Checkout update → POST /webhook/checkout
//   Order creation (existing /webhook/shopify) → markOrdered(), so an order stops the emails.
// The 10-minute cron calls runRecovery(): email 1 one hour after the checkout was last touched,
// email 2 forty-eight hours after email 1, unless the customer ordered, opted out or was already emailed.
// Sends through Google Workspace SMTP as info@vanteautomotive.com (sent copies land in its Sent folder).
// Env: SMTP_USER (var), SMTP_PASS (secret, Google app password), RC_ADMIN_KEY (secret, for /r/* admin calls),
//      REPORT_TO (var, weekly report + alerts), HEALTHCHECK_URL (optional var, healthchecks.io dead-man ping),
//      NTFY_TOPIC, SHOPIFY_WEBHOOK_SECRET, SHOPIFY_CLIENT_ID / SECRET (already used by the order tracker).
// Monitoring: weekly stats (rc:stats:<week>), health timestamps (rc:health), alerts to ntfy + email when
// sending fails, when Shopify stops sending checkouts, or when the cron stops; public GET /r/health.
import { WorkerMailer } from 'worker-mailer';
import { email1 } from './recovery_email1.js';
import { email2 } from './recovery_email2.js';

const FIRST_AFTER_MS  = 60 * 60 * 1000;          // 1 hour after last checkout activity
const SECOND_AFTER_MS = 48 * 60 * 60 * 1000;     // 48 hours after email 1
const MAX_AGE_MS      = 7 * 24 * 60 * 60 * 1000; // ignore checkouts older than a week
const MIN_TOTAL       = 50;                      // skip tiny baskets (badge holders, merch)
const KEEP_TTL        = 21 * 24 * 60 * 60;       // KV records live 3 weeks
const SKIP_DOMAINS    = ['vanteautomotive.com', 'mh-customs.com'];
const MERCH_WORDS     = /\b(t-?shirt|tee|hoodie|polo|cap|sticker)\b/i;
const SUBJECT_1       = 'Your parts are saved';
const SUBJECT_2       = 'Still thinking it over?';
const BASE            = 'https://mhc-api.raspy-fog-edb1.workers.dev';

const norm = e => String(e || '').trim().toLowerCase();

async function hmacB64(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function unsubSig(env, email) {
  return (await hmacB64(env.SHOPIFY_WEBHOOK_SECRET, 'unsub:' + email)).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

async function log(env, entry) {
  const raw = await env.MHC_KV.get('rc:log');
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ at: new Date().toISOString(), ...entry });
  await env.MHC_KV.put('rc:log', JSON.stringify(list.slice(0, 300)));
}

// ── Monitoring: weekly stats, health, alerts ──────────────────────────
function weekKey(t = Date.now()) {
  const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));            // Thursday of this ISO week
  const y = d.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4));
  const wk = 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}
async function bump(env, field, by = 1, sub) {
  const key = `rc:stats:${weekKey()}`;
  const st = JSON.parse((await env.MHC_KV.get(key)) || '{}');
  if (sub) { st[field] = st[field] || {}; st[field][sub] = (st[field][sub] || 0) + by; }
  else st[field] = (st[field] || 0) + by;
  await env.MHC_KV.put(key, JSON.stringify(st), { expirationTtl: 400 * 86400 });
}
async function health(env, patch) {
  const h = JSON.parse((await env.MHC_KV.get('rc:health')) || '{}');
  Object.assign(h, patch);
  await env.MHC_KV.put('rc:health', JSON.stringify(h));
  return h;
}
// Alert by push (ntfy) and email; each kind at most once per `everyH` hours
async function rcAlert(env, kind, title, body, everyH = 24) {
  const k = `rc:alerted:${kind}`;
  if (await env.MHC_KV.get(k)) return;
  await env.MHC_KV.put(k, '1', { expirationTtl: everyH * 3600 });
  await log(env, { alert: kind, title });
  if (env.NTFY_TOPIC) {
    try { await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: 'POST', headers: { Title: title, Priority: 'high', Tags: 'warning,email' }, body }); } catch {}
  }
  if (env.REPORT_TO && env.SMTP_PASS && kind !== 'smtp') {
    try { await sendMail(env, env.REPORT_TO, `⚠️ Vanté checkout emails: ${title}`, `<p style="font-family:Arial">${body}</p>`); } catch {}
  }
}

// ── Webhook: checkout created / updated ───────────────────────────────
export async function handleCheckoutWebhook(request, env, cors) {
  const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256');
  const rawBody = await request.text();
  if (!hmacHeader || !env.SHOPIFY_WEBHOOK_SECRET || (await hmacB64(env.SHOPIFY_WEBHOOK_SECRET, rawBody)) !== hmacHeader) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }
  const c = JSON.parse(rawBody);
  const token = c.token || c.cart_token || String(c.id || '');
  if (!token) return new Response('{"ok":true}', { headers: cors });
  const key = `rc:co:${token}`;
  const prev = JSON.parse((await env.MHC_KV.get(key)) || '{}');
  const addr = c.billing_address || c.shipping_address || {};
  const rec = {
    ...prev,
    token,
    email: norm(c.email || c.customer?.email || prev.email),
    first: c.customer?.first_name || addr.first_name || prev.first || '',
    url: c.abandoned_checkout_url || prev.url || '',
    currency: c.presentment_currency || c.currency || prev.currency || 'GBP',
    total: Number(c.total_price ?? prev.total ?? 0),
    createdAt: prev.createdAt || Date.parse(c.created_at) || Date.now(),
    touchedAt: Date.parse(c.updated_at) || Date.now(),
    completed: Boolean(c.completed_at) || prev.completed || false,
    items: (c.line_items || []).map(li => ({
      variantId: li.variant_id, productId: li.product_id,
      title: li.title, variant: li.variant_title || '', quantity: li.quantity,
      linePrice: Number(li.line_price ?? (Number(li.price) * li.quantity)),
      vendor: li.vendor || '',
    })),
  };
  if (!rec.items.length && prev.items) rec.items = prev.items;
  await env.MHC_KV.put(key, JSON.stringify(rec), { expirationTtl: KEEP_TTL });
  await health(env, { lastWebhookAt: Date.now() });
  if (!prev.token) await bump(env, 'checkouts');
  return new Response('{"ok":true}', { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Called from the order webhook: an order means no more emails for that checkout or that customer.
export async function markOrdered(env, order) {
  const tasks = [];
  if (order.checkout_token) tasks.push(env.MHC_KV.put(`rc:done:${order.checkout_token}`, '1', { expirationTtl: KEEP_TTL }));
  const email = norm(order.email || order.customer?.email);
  if (email) tasks.push(env.MHC_KV.put(`rc:ord:${email}`, String(Date.now()), { expirationTtl: KEEP_TTL }));
  await Promise.all(tasks);
  // Recovered = an order from someone we emailed in the last 3 weeks
  if (email && await env.MHC_KV.get(`rc:mail:${email}`) && !(await env.MHC_KV.get(`rc:rec:${order.id}`))) {
    await env.MHC_KV.put(`rc:rec:${order.id}`, '1', { expirationTtl: KEEP_TTL });
    const value = Number(order.current_total_price_set?.shop_money?.amount ?? order.total_price ?? 0);
    await bump(env, 'recovered');
    await bump(env, 'recoveredValue', Math.round(value * 100) / 100);
    await log(env, { recovered: email, order: order.name, value });
  }
}

// ── Opt-out link ──────────────────────────────────────────────────────
export async function handleUnsub(url, env) {
  const email = norm(url.searchParams.get('e'));
  const ok = email && url.searchParams.get('s') === (await unsubSig(env, email));
  if (ok) await env.MHC_KV.put(`rc:unsub:${email}`, String(Date.now()));
  const msg = ok ? 'Done. We won’t email you about this checkout again.' : 'This link is not valid.';
  return new Response(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vanté Automotive</title>
<body style="margin:0;font-family:Helvetica,Arial,sans-serif;background:#f4f4f4;color:#1e1e1e;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#fff;padding:40px 32px;max-width:420px;text-align:center"><img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-logo-a6192e.png" width="115" alt="Vanté Automotive" style="margin:0 auto 24px;display:block">
<p style="font-size:15px;line-height:1.6;margin:0 0 20px">${msg}</p><a href="https://vanteautomotive.com" style="color:#A6192E;font-weight:600">Back to the shop</a></div></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Building the email data ───────────────────────────────────────────
async function productImages(env, shopifyGql, items) {
  const ids = [...new Set(items.map(i => i.variantId).filter(Boolean))].map(id => `gid://shopify/ProductVariant/${id}`);
  if (!ids.length) return {};
  try {
    const data = await shopifyGql(env,
      'query($ids:[ID!]!){nodes(ids:$ids){...on ProductVariant{legacyResourceId image{url} product{title featuredMedia{preview{image{url}}}}}}}', { ids });
    const map = {};
    for (const n of data?.nodes || []) {
      if (n) map[n.legacyResourceId] = { image: n.image?.url || n.product?.featuredMedia?.preview?.image?.url || '', productTitle: n.product?.title || '' };
    }
    return map;
  } catch { return {}; }
}

async function emailData(env, shopifyGql, rec) {
  const imgs = await productImages(env, shopifyGql, rec.items);
  return {
    first: rec.first,
    url: rec.url,
    currency: rec.currency,
    unsub: `${BASE}/r/unsub?e=${encodeURIComponent(rec.email)}&s=${await unsubSig(env, rec.email)}`,
    items: rec.items.map(i => ({ ...i, title: imgs[i.variantId]?.productTitle || i.title, image: imgs[i.variantId]?.image || '' })),
  };
}

async function sendMail(env, to, subject, html) {
  const mailer = await WorkerMailer.connect({
    host: 'smtp.gmail.com', port: 465, secure: true,
    credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
    authType: 'plain',
  });
  try {
    await mailer.send({
      from: { name: 'Vanté Automotive', email: env.SMTP_USER },
      to: { email: to },
      reply: { name: 'Vanté Automotive', email: env.SMTP_USER },
      subject,
      html,
      text: `${subject}\n\nYour selection at Vanté Automotive is saved. Complete your order or reply to this email with any questions.`,
    });
  } finally {
    try { await mailer.close(); } catch {}
  }
}

// Why a checkout should not be emailed (null = fine to email)
async function skipReason(env, rec, now) {
  if (!rec.email) return 'no email';
  if (rec.completed) return 'completed';
  if (now - rec.createdAt > MAX_AGE_MS) return 'too old';
  const domain = rec.email.split('@')[1] || '';
  if (SKIP_DOMAINS.includes(domain)) return 'own address';
  if (!rec.url) return 'no checkout link';
  if (!rec.items?.length) return 'empty';
  if (rec.total < MIN_TOTAL) return 'under minimum';
  if (rec.items.every(i => MERCH_WORDS.test(i.title || ''))) return 'merch only';
  if (await env.MHC_KV.get(`rc:done:${rec.token}`)) return 'ordered';
  const ordered = Number(await env.MHC_KV.get(`rc:ord:${rec.email}`) || 0);
  if (ordered && ordered > rec.createdAt) return 'ordered since';
  if (await env.MHC_KV.get(`rc:unsub:${rec.email}`)) return 'opted out';
  return null;
}

// ── Cron ──────────────────────────────────────────────────────────────
export async function runRecovery(env, shopifyGql) {
  const now = Date.now();
  const h = await health(env, { lastCronAt: now });
  if (!env.SMTP_USER || !env.SMTP_PASS) {                  // not switched on yet (or the password was removed)
    if (h.liveSince) await rcAlert(env, 'nopass', 'Sending is switched off', 'SMTP_PASS is missing, so no abandoned-checkout emails are going out.');
    return;
  }
  if (!h.liveSince) await health(env, { liveSince: now });
  if (env.HEALTHCHECK_URL) { try { await fetch(env.HEALTHCHECK_URL); } catch {} }   // dead-man switch: alerts you if these pings stop
  // Watchdog: Shopify normally sends a checkout every day or two. 5 quiet days = webhooks probably disabled.
  const quietDays = (now - (h.lastWebhookAt || h.liveSince || now)) / 864e5;
  if (quietDays > 5) await rcAlert(env, 'quiet', 'No checkouts received for 5+ days', `The recovery system hasn't received a checkout from Shopify for ${Math.floor(quietDays)} days. Check Shopify → Settings → Notifications → Webhooks: "Checkout creation" and "Checkout update" must point to ${BASE}/webhook/checkout. Shopify removes webhooks after repeated failures.`, 48);
  await weeklyReport(env, now);
  if ((await env.MHC_KV.get('rc:paused')) === '1') return;
  let cursor;
  let sent = 0;
  do {
    const page = await env.MHC_KV.list({ prefix: 'rc:co:', cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      if (sent >= 10) return;                              // stay well inside Gmail limits per run
      const rec = JSON.parse((await env.MHC_KV.get(k.name)) || 'null');
      if (!rec || rec.sent2 || rec.skipped) continue;
      const due1 = !rec.sent1 && now - rec.touchedAt >= FIRST_AFTER_MS;
      const due2 = rec.sent1 && now - rec.sent1 >= SECOND_AFTER_MS;
      if (!due1 && !due2) continue;
      const reason = await skipReason(env, rec, now);
      if (reason) {
        if (reason !== 'too old' || !rec.sent1) {
          rec.skipped = reason;
          await env.MHC_KV.put(k.name, JSON.stringify(rec), { expirationTtl: KEEP_TTL });
          await log(env, { step: due1 ? 1 : 2, email: rec.email, total: rec.total, skipped: reason });
          await bump(env, 'skipped', 1, reason);
        }
        continue;
      }
      // one recovery sequence per customer per week (people often open checkout twice)
      if (due1) {
        const lastSeq = Number(await env.MHC_KV.get(`rc:mail:${rec.email}`) || 0);
        if (lastSeq && now - lastSeq < MAX_AGE_MS) {
          rec.skipped = 'already emailed this week';
          await env.MHC_KV.put(k.name, JSON.stringify(rec), { expirationTtl: KEEP_TTL });
          await log(env, { step: 1, email: rec.email, total: rec.total, skipped: rec.skipped });
          await bump(env, 'skipped', 1, rec.skipped);
          continue;
        }
      }
      try {
        const d = await emailData(env, shopifyGql, rec);
        await sendMail(env, rec.email, due1 ? SUBJECT_1 : SUBJECT_2, due1 ? email1(d) : email2(d));
        if (due1) { rec.sent1 = now; await env.MHC_KV.put(`rc:mail:${rec.email}`, String(now), { expirationTtl: KEEP_TTL }); }
        else rec.sent2 = now;
        await env.MHC_KV.put(k.name, JSON.stringify(rec), { expirationTtl: KEEP_TTL });
        await log(env, { step: due1 ? 1 : 2, email: rec.email, total: rec.total, currency: rec.currency, items: rec.items.map(i => i.title).join(' + ') });
        await bump(env, due1 ? 'sent1' : 'sent2');
        await health(env, { lastSendAt: now, failStreak: 0 });
        sent++;
      } catch (e) {
        const msg = String(e).slice(0, 200);
        await log(env, { step: due1 ? 1 : 2, email: rec.email, error: msg });
        await bump(env, 'errors');
        const h = await health(env, { lastError: msg, lastErrorAt: now, failStreak: ((JSON.parse((await env.MHC_KV.get('rc:health')) || '{}').failStreak) || 0) + 1 });
        if (h.failStreak >= 2) await rcAlert(env, 'smtp', 'Sending is failing', `Abandoned-checkout emails could not be sent (${h.failStreak} attempts in a row). Last error: ${msg}. Most likely the Gmail app password for ${env.SMTP_USER} was revoked or changed: create a new one and run "npx wrangler secret put SMTP_PASS" in mhc-order-tracker.`, 12);
        return;                                            // SMTP trouble: stop this run, retry next cron
      }
    }
  } while (cursor);
}

// ── Weekly report (Mondays, first cron run after 08:00 UTC) ───────────
async function weeklyReport(env, now) {
  const d = new Date(now);
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 8 || !env.REPORT_TO) return;
  const thisWeek = weekKey(now);
  if ((await env.MHC_KV.get('rc:reported')) === thisWeek) return;
  await env.MHC_KV.put('rc:reported', thisWeek);
  const weeks = [];
  for (let i = 1; i <= 12; i++) {
    const k = weekKey(now - i * 7 * 864e5);
    weeks.push({ k, ...(JSON.parse((await env.MHC_KV.get(`rc:stats:${k}`)) || '{}')) });
  }
  const last = weeks[0], h = JSON.parse((await env.MHC_KV.get('rc:health')) || '{}');
  const ago = t => t ? `${Math.round((now - t) / 36e5)} h ago` : 'never';
  const ok = (h.lastSendAt && now - h.lastSendAt < 14 * 864e5) || !(last.checkouts);
  const row = w => `<tr><td style="padding:4px 10px">${w.k}</td><td align="right">${w.checkouts || 0}</td><td align="right">${w.sent1 || 0}</td><td align="right">${w.sent2 || 0}</td><td align="right">${w.recovered || 0}</td><td align="right">£${(w.recoveredValue || 0).toFixed(2)}</td><td align="right">${w.errors || 0}</td></tr>`;
  const skipped = Object.entries(last.skipped || {}).map(([r, n]) => `${r}: ${n}`).join(', ') || 'none';
  const html = `<div style="font-family:Arial,sans-serif;color:#1e1e1e;max-width:640px">
<h2 style="margin:0 0 6px">Abandoned-checkout emails: weekly report</h2>
<p style="margin:0 0 16px;color:${ok ? '#2e7d32' : '#A6192E'};font-weight:bold">${ok ? '✅ Running normally' : '⚠️ Check needed: no emails sent in the last 14 days'}</p>
<p><b>Last week (${last.k})</b>: ${last.checkouts || 0} checkouts received · ${last.sent1 || 0} first emails · ${last.sent2 || 0} reminders · ${last.recovered || 0} recovered orders (£${(last.recoveredValue || 0).toFixed(2)}) · ${last.errors || 0} errors<br>Skipped: ${skipped}</p>
<p><b>Health</b>: last checkout from Shopify ${ago(h.lastWebhookAt)} · last email sent ${ago(h.lastSendAt)} · last cron run ${ago(h.lastCronAt)}${h.lastError ? ` · last error: ${h.lastError} (${ago(h.lastErrorAt)})` : ''}</p>
<table style="border-collapse:collapse;font-size:13px"><tr style="background:#f4f4f4"><th align="left" style="padding:4px 10px">Week</th><th>Checkouts</th><th>Email 1</th><th>Email 2</th><th>Recovered</th><th>Value</th><th>Errors</th></tr>${weeks.map(row).join('')}</table>
<p style="color:#888;font-size:12px">Sent every Monday by the order-tracker worker (mhc-api). If this report stops arriving, the system has stopped: check Cloudflare → Workers → mhc-api.</p></div>`;
  try { await sendMail(env, env.REPORT_TO, `Vanté checkout emails, week ${last.k}: ${last.sent1 || 0} sent, ${last.recovered || 0} recovered`, html); }
  catch (e) { await rcAlert(env, 'report', 'Weekly report could not be sent', String(e).slice(0, 200)); }
}

// Public, no personal data: GET /r/health
export async function handleHealth(env) {
  const h = JSON.parse((await env.MHC_KV.get('rc:health')) || '{}');
  const st = JSON.parse((await env.MHC_KV.get(`rc:stats:${weekKey()}`)) || '{}');
  const now = Date.now();
  const age = t => t ? Math.round((now - t) / 6e4) : null;
  return new Response(JSON.stringify({
    live: Boolean(h.liveSince), minutesSinceCron: age(h.lastCronAt), minutesSinceCheckout: age(h.lastWebhookAt),
    minutesSinceSend: age(h.lastSendAt), failStreak: h.failStreak || 0, thisWeek: st,
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// ── Admin (header X-RC-Key: RC_ADMIN_KEY) ─────────────────────────────
//   GET  /r/log                    → last 300 sends / skips
//   POST /r/test?to=a@b.com&step=1 → sends a sample email to that address
//   POST /r/pause?on=1|0           → stop / resume sending
export async function handleAdmin(request, url, env, shopifyGql) {
  if (!env.RC_ADMIN_KEY || request.headers.get('X-RC-Key') !== env.RC_ADMIN_KEY) return new Response('Unauthorized', { status: 401 });
  const json = o => new Response(JSON.stringify(o, null, 1), { headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/r/log') return json(JSON.parse((await env.MHC_KV.get('rc:log')) || '[]'));
  if (url.pathname === '/r/report' && request.method === 'POST') {       // send the weekly report now
    await env.MHC_KV.delete('rc:reported');
    const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7)); monday.setUTCHours(9);
    await weeklyReport(env, Math.max(monday.getTime(), Date.now() - 6 * 864e5));
    return json({ reported: true });
  }
  if (url.pathname === '/r/pause' && request.method === 'POST') {
    await env.MHC_KV.put('rc:paused', url.searchParams.get('on') === '0' ? '0' : '1');
    return json({ paused: url.searchParams.get('on') !== '0' });
  }
  if (url.pathname === '/r/test' && request.method === 'POST') {
    const to = norm(url.searchParams.get('to'));
    const step = url.searchParams.get('step') === '2' ? 2 : 1;
    const sample = {
      token: 'test', email: to, first: 'James', url: 'https://vanteautomotive.com/cart', currency: 'GBP',
      items: [{ variantId: url.searchParams.get('variant') || '43284888223862', title: 'Audi RSQ8 4M Full Carbon Body Kit', variant: '2x2 Twill Carbon Fibre / Gloss', quantity: 1, linePrice: 5119.95 }],
    };
    const d = await emailData(env, shopifyGql, sample);
    await sendMail(env, to, (step === 1 ? SUBJECT_1 : SUBJECT_2) + ' [test]', step === 1 ? email1(d) : email2(d));
    return json({ sent: to, step });
  }
  return new Response('Not found', { status: 404 });
}
