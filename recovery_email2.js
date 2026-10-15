// 48-hour reminder: short, same look as email 1 (logo, items, one button, one review, help).
import { esc, itemsHtml } from './recovery_parts.js';

const F = "'Tomorrow','Helvetica Neue',Arial,sans-serif";

export function email2(d) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Still thinking it over?</title>
<link href="https://fonts.googleapis.com/css2?family=Tomorrow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 0; background: #f4f4f4; }
  table { border-collapse: collapse; }
  img { border: 0; display: block; max-width: 100%; }
  @media (max-width: 620px) {
    .wrap { width: 100% !important; }
    .px { padding-left: 18px !important; padding-right: 18px !important; }
    .h1 { font-size: 24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your parts are still saved. Questions on fitment or timing? Just reply.&#8202;&#847;&#8202;&#847;&#8202;&#847;</div>
<table role="presentation" width="100%" style="background:#f4f4f4;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" style="width:600px;background:#ffffff;">

  <tr><td class="px" align="center" style="padding:28px 40px 20px;border-bottom:1px solid #ececec;">
    <a href="https://vanteautomotive.com"><img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-logo-a6192e.png" width="115" alt="Vanté Automotive" style="width:115px;"></a>
  </td></tr>

  <tr><td class="px" style="padding:40px 40px 8px;font-family:${F};color:#1e1e1e;">
    <p style="margin:0 0 12px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#A6192E;font-weight:600;">Still saved for you</p>
    <h1 class="h1" style="margin:0 0 16px;font-size:30px;line-height:1.15;font-weight:700;text-transform:uppercase;letter-spacing:0.02em;">Still thinking it over?</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#444;">
      ${d.first ? 'Hi ' + esc(d.first) + ', your' : 'Your'} selection is still waiting. If anything is holding you back, whether it's fitment, finish or delivery timing, just reply to this email and one of our specialists will help you personally.
    </p>
  </td></tr>

  <tr><td class="px" style="padding:26px 40px 6px;">
    <table role="presentation" width="100%">${itemsHtml(d)}
    </table>
  </td></tr>

  <tr><td class="px" align="center" style="padding:22px 40px 10px;">
    <table role="presentation"><tr><td align="center" style="background:#A6192E;">
      <a href="${esc(d.url)}" style="display:inline-block;padding:17px 46px;font-family:${F};font-size:14px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Complete my order</a>
    </td></tr></table>
  </td></tr>

  <tr><td class="px" style="padding:30px 40px 8px;">
    <table role="presentation" width="100%" style="background:#f7f7f7;">
      <tr>
        <td width="40%" valign="middle" style="padding:0;">
          <img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-review-rs6-gerry.jpg" width="230" alt="Audi RS6 with Vanté front splitter, customer photo" style="width:100%;height:auto;">
        </td>
        <td width="60%" valign="middle" style="padding:16px 20px;font-family:${F};">
          <p style="margin:0 0 6px;font-size:13px;color:#A6192E;letter-spacing:2px;">★★★★★</p>
          <p style="margin:0 0 8px;font-size:16px;line-height:1.35;font-weight:600;color:#1e1e1e;">“Super finish, delivery took some time as stated. Perfect as indicated in the description.”</p>
          <p style="margin:0;font-size:12px;color:#777;">FlintE · verified buyer</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td class="px" align="center" style="padding:26px 40px 12px;font-family:${F};">
    <p style="margin:0;font-size:13px;line-height:1.7;color:#666;">Worldwide tracked shipping · Duties paid · 12-month warranty · Pay in 3, 6 or 12 with Shop Pay</p>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#444;">
      <a href="https://wa.me/447466447152" style="color:#A6192E;font-weight:600;text-decoration:none;">WhatsApp</a>
      &nbsp;·&nbsp;
      <a href="mailto:info@vanteautomotive.com" style="color:#A6192E;font-weight:600;text-decoration:none;">info@vanteautomotive.com</a>
      &nbsp;·&nbsp; or just reply.
    </p>
  </td></tr>

  <tr><td class="px" align="center" style="padding:28px 40px 34px;font-family:${F};">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#999;">Vanté Automotive · Engineered in carbon</p>
    <p style="margin:0;font-size:11px;color:#aaa;">You received this because you started a checkout at <a href="https://vanteautomotive.com" style="color:#aaa;">Vanté Automotive</a>.<br><a href="${esc(d.unsub)}" style="color:#aaa;">Don’t email me about this checkout</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
