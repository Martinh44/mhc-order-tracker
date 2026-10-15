// ── Order boards: JC Sportline (/jc/*) and PakTechz (/pt/*) ───────────
// Every card is its own KV key (<board>:card:<key>), so a save, a delete or an incoming Shopify order can never
// overwrite another card. Deleted cards move to <board>:deleted:<key> for 90 days and can be restored.
// Shopify orders arrive through /webhook/shopify: MHJC + Vanté Automotive lines → JC, MHPT lines → PakTechz.
//
// JC history: until 2026-10-15 the JC board was one blob under KV key `orders`. That blob is never written again and
// stays as the backup; on first use each blob card is copied to jc:card:<its MHC id>. The old page's GET/PUT /orders
// keep working for any device still showing it: GET returns the cards, PUT merges card by card (newer wins, no deletes).

const BIN_TTL  = 90 * 24 * 3600;
const MAX_BODY = 64 * 1024;
const JC_VENDORS = ['mhjc', 'vanté automotive', 'vante automotive'];
const PT_VENDORS = ['mhpt'];

export const FINISHES = ['2x2 Twill · Gloss', '2x2 Twill · Matte', '1x1 Twill · Gloss', '1x1 Twill · Matte', 'Forged · Gloss'];

// Variant titles look like "1x1 Twill Carbon Fibre / Matte"
export function finishFromVariant(title) {
  const t = String(title || '').toLowerCase();
  const matte = t.includes('matte');
  if (t.includes('forged')) return 'Forged · Gloss';
  if (t.includes('1x1')) return matte ? '1x1 Twill · Matte' : '1x1 Twill · Gloss';
  if (t.includes('2x2') || t.includes('twill')) return matte ? '2x2 Twill · Matte' : '2x2 Twill · Gloss';
  return '';
}

// Our finish variants carry suffixes on PakTechz's part number (PT0047-3-MT); the factory only knows PT0047-3
export function basePart(code) {
  return String(code || '').trim().replace(/-(1X1-MT|1X1|MT|FC)$/i, '');
}

const s = (v, n = 2000) => String(v ?? '').slice(0, n);
const bools = arr => [0, 1, 2, 3, 4].map(n => !!(arr || [])[n]);
const validKey = k => /^[A-Za-z0-9_-]{1,64}$/.test(k);
const jcNum = id => { const m = /^MHC-(\d+)$/.exec(id || ''); return m ? parseInt(m[1], 10) : 0; };
const jcId = n => 'MHC-' + String(n).padStart(3, '0');

function cleanPt(key, body, existing) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 50).map(i => ({
    part: s(i.part, 120), finish: FINISHES.includes(i.finish) ? i.finish : '',
    qty: Math.max(1, Math.min(999, parseInt(i.qty, 10) || 1)), title: s(i.title, 300),
  })) : [];
  const stages = bools(body.stages);
  const stageAt = [0, 1, 2, 3, 4].map(n => stages[n] ? (Number((body.stageAt || [])[n]) || Date.now()) : null);
  return {
    id: key, num: existing?.num ?? body.num ?? null,
    draft: !!body.draft && !stages.some(Boolean),
    shopifyOrderId: existing?.shopifyOrderId || s(body.shopifyOrderId), shopifyOrderName: existing?.shopifyOrderName || s(body.shopifyOrderName),
    customerName: s(body.customerName), email: s(body.email), phone: s(body.phone), address: s(body.address),
    items, tracking: s(body.tracking), notes: s(body.notes, 10000), stages, stageAt,
    createdAt: Number(body.createdAt) || existing?.createdAt || Date.now(),
    lastUpdated: Date.now(),
  };
}

// Same fields as the original JC cards; `key` is the storage key, `id` stays the MHC-xxx number people see
function cleanJc(key, body, existing) {
  const stages = bools(body.stages);
  return {
    key, id: existing?.id || null,
    draft: !!body.draft && !stages.some(Boolean),
    shopifyOrderId: existing?.shopifyOrderId || s(body.shopifyOrderId), shopifyOrderName: existing?.shopifyOrderName || s(body.shopifyOrderName),
    customerName: s(body.customerName), email: s(body.email), phone: s(body.phone), address: s(body.address),
    partNumbers: s(body.partNumbers, 5000), tracking: s(body.tracking), notes: s(body.notes, 10000), stages,
    createdAt: Number(body.createdAt) || existing?.createdAt || Date.now(),
    lastUpdated: Date.now(),
  };
}

const BOARDS = {
  pt: { card: 'pt:card:', bin: 'pt:deleted:', clean: cleanPt },
  jc: { card: 'jc:card:', bin: 'jc:deleted:', clean: cleanJc },
};

const json = (cors, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function listPrefix(env, prefix) {
  const names = [];
  let cursor;
  do {
    const r = await env.MHC_KV.list({ prefix, cursor });
    names.push(...r.keys.map(k => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  const out = [];
  for (let i = 0; i < names.length; i += 100) {
    const got = await env.MHC_KV.get(names.slice(i, i + 100), 'json');
    for (const v of got.values()) if (v) out.push(v);
  }
  return out;
}

const nextPtNum = cards => cards.reduce((m, c) => Math.max(m, Number(c.num) || 0), 0) + 1;
const nextJcId = cards => jcId(cards.reduce((m, c) => Math.max(m, jcNum(c.id)), 0) + 1);

// One-time copy of the old JC blob into per-card keys. Only fills keys that don't exist (and weren't deleted),
// so running it twice — or from two places at once — writes the same values and can't undo later edits.
export async function ensureJcMigrated(env) {
  if (await env.MHC_KV.get('jc:migrated')) return;
  const raw = await env.MHC_KV.get('orders');
  if (raw) {
    const data = JSON.parse(raw);
    const cards = Array.isArray(data) ? data : (data.orders || []);
    for (const c of cards) {
      if (!c || !validKey(c.id)) continue;
      if (await env.MHC_KV.get(BOARDS.jc.card + c.id) || await env.MHC_KV.get(BOARDS.jc.bin + c.id)) continue;
      await env.MHC_KV.put(BOARDS.jc.card + c.id, JSON.stringify({ ...c, key: c.id }));
    }
    if (!(await env.MHC_KV.get('orders:pre-per-card-backup'))) await env.MHC_KV.put('orders:pre-per-card-backup', raw);
  }
  await env.MHC_KV.put('jc:migrated', String(Date.now()));
}

// Routes after the PIN check in worker.js; name = 'pt' | 'jc'
export async function handleBoard(name, request, url, env, cors) {
  const b = BOARDS[name];
  const parts = url.pathname.split('/');            // ['', 'pt', 'orders', '<key>']
  const route = parts[2] || '';
  const key = decodeURIComponent(parts[3] || '');
  if (name === 'jc') await ensureJcMigrated(env);

  if (request.method === 'GET' && route === 'orders' && !key) {
    return json(cors, { orders: await listPrefix(env, b.card), ...(name === 'pt' ? { finishes: FINISHES } : {}) });
  }
  if (request.method === 'GET' && route === 'deleted') {
    return json(cors, { orders: await listPrefix(env, b.bin) });
  }
  if (!validKey(key)) return json(cors, { error: 'Not found' }, 404);

  if (request.method === 'PUT' && route === 'orders') {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(cors, { error: 'too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json(cors, { error: 'Invalid JSON' }, 400); }
    if (!body || typeof body !== 'object') return json(cors, { error: 'Invalid card' }, 400);
    const existing = await env.MHC_KV.get(b.card + key, 'json');
    const card = b.clean(key, body, existing);
    if (name === 'pt' && card.num == null) card.num = nextPtNum(await listPrefix(env, b.card));
    if (name === 'jc' && !card.id) card.id = nextJcId([...await listPrefix(env, b.card), ...await listPrefix(env, b.bin)]);
    await env.MHC_KV.put(b.card + key, JSON.stringify(card));
    return json(cors, { ok: true, card });
  }
  if (request.method === 'DELETE' && route === 'orders') {
    const existing = await env.MHC_KV.get(b.card + key);
    if (existing) {
      const card = JSON.parse(existing);
      card.deletedAt = Date.now();
      await env.MHC_KV.put(b.bin + key, JSON.stringify(card), { expirationTtl: BIN_TTL });
      await env.MHC_KV.delete(b.card + key);
    }
    return json(cors, { ok: true });
  }
  if (request.method === 'POST' && route === 'restore') {
    const binned = await env.MHC_KV.get(b.bin + key, 'json');
    if (!binned) return json(cors, { error: 'not found' }, 404);
    delete binned.deletedAt;
    binned.lastUpdated = Date.now();
    await env.MHC_KV.put(b.card + key, JSON.stringify(binned));
    await env.MHC_KV.delete(b.bin + key);
    return json(cors, { ok: true, card: binned });
  }
  return json(cors, { error: 'Not found' }, 404);
}

// Old JC page (GET/PUT /orders): served from the per-card store
export async function handleLegacyJc(request, env, cors) {
  await ensureJcMigrated(env);
  const cards = await listPrefix(env, BOARDS.jc.card);
  if (request.method === 'GET') {
    const savedAt = cards.reduce((m, c) => Math.max(m, Number(c.lastUpdated) || 0), 0);
    return json(cors, { orders: cards, savedAt });
  }
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json(cors, { error: 'Invalid JSON' }, 400); }
  const incoming = Array.isArray(body) ? body : (body?.orders || []);
  const byKey = new Map(cards.map(c => [c.key, c]));
  const usedIds = new Set(cards.map(c => c.id));
  let merged = 0;
  for (const c of incoming) {
    if (!c || typeof c !== 'object') continue;
    // Cards the old page got from the server carry `key`; keyless ones are either from its pre-switch cache
    // (same MHC id and creation time as a copied card) or brand new. A new card never overwrites anything.
    let cur = null;
    if (c.key) {
      cur = byKey.get(c.key);
      if (!cur) continue;                                   // deleted on the new board: don't bring it back
    } else {
      const same = byKey.get(c.id);
      if (same && Number(same.createdAt) === Number(c.createdAt)) cur = same;
      else if (await env.MHC_KV.get(BOARDS.jc.bin + c.id, 'json').then(d => d && Number(d.createdAt) === Number(c.createdAt))) continue;
    }
    if (cur && !((Number(c.lastUpdated) || 0) > (Number(cur.lastUpdated) || 0))) continue;
    const key = cur ? cur.key : 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let id = cur ? cur.id : c.id;
    if (!cur && (!jcNum(id) || usedIds.has(id))) id = nextJcId([...cards, ...[...usedIds].map(i => ({ id: i }))]);
    usedIds.add(id);
    const card = { ...cleanJc(key, c, cur), id, lastUpdated: Number(c.lastUpdated) || Date.now() };
    await env.MHC_KV.put(BOARDS.jc.card + key, JSON.stringify(card));
    if (!cur) byKey.set(key, card);
    merged++;
  }
  return json(cors, { ok: true, merged });
}

// ── Shopify order webhook ─────────────────────────────────────────────
function customerFields(order) {
  const addr = order.shipping_address || order.billing_address || {};
  return {
    shopifyOrderId: String(order.id), shopifyOrderName: order.name || '',
    customerName: [addr.first_name || order.customer?.first_name, addr.last_name || order.customer?.last_name].filter(Boolean).join(' '),
    email: order.email || order.customer?.email || '',
    phone: order.phone || addr.phone || order.customer?.phone || '',
    address: [addr.address1, addr.address2, addr.city, addr.province_code || addr.province, addr.zip, addr.country].filter(Boolean).join(', '),
  };
}

const linesFor = (order, vendors) => (order.line_items || []).filter(i => vendors.includes((i.vendor || '').toLowerCase().trim()));

// Each throws on failure so the webhook returns 500 and Shopify retries (both dedupe on the Shopify order id)
export async function addPaktechzOrder(env, order, fetchBarcodes) {
  const lines = linesFor(order, PT_VENDORS);
  if (!lines.length) return null;
  const b = BOARDS.pt, key = 'S' + order.id;
  if (await env.MHC_KV.get(b.card + key)) return 'duplicate';
  if (await env.MHC_KV.get(b.bin + key)) return 'deleted';   // removed on purpose: don't bring it back
  const barcodes = await fetchBarcodes(env, lines.map(i => i.variant_id));
  const now = Date.now();
  const card = {
    id: key, num: nextPtNum(await listPrefix(env, b.card)), draft: true, ...customerFields(order),
    items: lines.map(i => ({
      part: basePart(barcodes[i.variant_id] || i.sku || ''), finish: finishFromVariant(i.variant_title),
      qty: i.quantity || 1, title: i.title || i.name || '',
    })),
    tracking: '', notes: '', stages: [false, false, false, false, false], stageAt: [null, null, null, null, null],
    createdAt: new Date(order.created_at || now).getTime(), lastUpdated: now,
  };
  await env.MHC_KV.put(b.card + key, JSON.stringify(card));
  return card.id;
}

export async function addJcOrder(env, order, fetchBarcodes) {
  const lines = linesFor(order, JC_VENDORS);
  if (!lines.length) return null;
  await ensureJcMigrated(env);
  const b = BOARDS.jc, key = 'S' + order.id, sid = String(order.id);
  if (await env.MHC_KV.get(b.card + key) || await env.MHC_KV.get(b.bin + key)) return 'duplicate';
  const cards = await listPrefix(env, b.card);
  const binned = await listPrefix(env, b.bin);
  if ([...cards, ...binned].some(c => c.shopifyOrderId === sid)) return 'duplicate';   // cards from before the switch
  // Order webhooks don't include barcodes, so look them up per variant; fall back to SKU then name
  const barcodes = await fetchBarcodes(env, lines.map(i => i.variant_id));
  const now = Date.now();
  const card = {
    key, id: nextJcId([...cards, ...binned]), draft: true, ...customerFields(order),
    partNumbers: lines.map(i => barcodes[i.variant_id] || i.sku || i.name).filter(Boolean).join('\n'),
    tracking: '', notes: '', stages: [false, false, false, false, false],
    createdAt: new Date(order.created_at || now).getTime(), lastUpdated: now,
  };
  await env.MHC_KV.put(b.card + key, JSON.stringify(card));
  return card.id;
}
