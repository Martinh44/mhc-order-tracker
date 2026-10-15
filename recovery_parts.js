// Shared bits for the checkout-recovery emails (recovery_email1.js / recovery_email2.js).
export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function money(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(n);
  } catch {
    return '£' + n.toFixed(2);
  }
}

// Square thumbnail from the Shopify CDN (same 192px crop as the approved template)
function thumb(src) {
  if (!src) return '';
  return src + (src.includes('?') ? '&' : '?') + 'width=192&height=192&crop=center';
}

export function itemsHtml(d) {
  return d.items.map(it => `
      <tr>
        <td width="96" valign="top" style="padding:12px 16px 12px 0;border-top:1px solid #ececec;">
          ${it.image ? `<img src="${esc(thumb(it.image))}" width="96" height="96" alt="" style="width:96px;height:96px;object-fit:cover;background:#f6f6f6;">` : ''}
        </td>
        <td valign="middle" class="f" style="padding:12px 0;border-top:1px solid #ececec;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;">
          <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#1e1e1e;line-height:1.3;">${esc(it.title)}</p>
          ${it.variant && it.variant !== 'Default Title' ? `<p style="margin:0 0 4px;font-size:13px;color:#777;">${esc(it.variant)}</p>` : ''}
          <p style="margin:0;font-size:13px;color:#777;">Qty ${esc(it.quantity)} · <span style="color:#1e1e1e;font-weight:600;">${esc(money(it.linePrice, d.currency))}</span></p>
        </td>
      </tr>`).join('');
}
