// Generated from theme_premium/emails/abandoned_checkout.liquid (approved design). Do not edit by hand.
import { esc, itemsHtml } from "./recovery_parts.js";
export function email1(d) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Your parts are saved</title>
<link href="https://fonts.googleapis.com/css2?family=Tomorrow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 0; background: #f4f4f4; }
  table { border-collapse: collapse; }
  img { border: 0; display: block; max-width: 100%; }
  a { color: #A6192E; }
  .f { font-family: 'Tomorrow', 'Helvetica Neue', Arial, sans-serif; }
  @media (max-width: 620px) {
    /* phones keep the desktop layout, just scaled: nothing stacks */
    .wrap { width: 100% !important; }
    .px { padding-left: 18px !important; padding-right: 18px !important; }
    .h1 { font-size: 24px !important; }
    .qpad { padding: 12px 12px !important; }
    .qtxt { font-size: 14px !important; }
    .sm { font-size: 11.5px !important; }
    .smh { font-size: 12.5px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;">

<!-- preheader -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your selection is saved. Made to order for your car, delivered with duties paid.&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;</div>

<table role="presentation" width="100%" style="background:#f4f4f4;">
<tr><td align="center" style="padding:24px 12px;">

<table role="presentation" class="wrap" width="600" style="width:600px;background:#ffffff;">

  <!-- logo -->
  <tr><td class="px" align="center" style="padding:28px 40px 20px;border-bottom:1px solid #ececec;">
    <a href="https://vanteautomotive.com"><img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-logo-a6192e.png" width="115" alt="Vanté Automotive" style="width:115px;"></a>
  </td></tr>

  <!-- hero -->
  <tr><td class="px f" style="padding:40px 40px 8px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;color:#1e1e1e;">
    <p style="margin:0 0 12px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#A6192E;font-weight:600;">Your parts are saved</p>
    <h1 class="h1" style="margin:0 0 16px;font-size:30px;line-height:1.15;font-weight:700;text-transform:uppercase;letter-spacing:0.02em;">Made for your car.<br>Worth the wait.</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#444;">
      ${d.first ? 'Hi ' + esc(d.first) + ', we' : 'We'} kept your selection for you. Every Vanté part is made to order: laid up in carbon for your car, cured, finished by hand and checked before it ships. Nothing sits on a shelf, and that is exactly why it fits like it came from the factory.
    </p>
  </td></tr>

  <!-- items -->
  <tr><td class="px" style="padding:26px 40px 6px;">
    <table role="presentation" width="100%">
      ${itemsHtml(d)}
    </table>
  </td></tr>

  <!-- CTA -->
  <tr><td class="px" align="center" style="padding:22px 40px 10px;">
    <table role="presentation"><tr><td align="center" style="background:#A6192E;">
      <a href="${esc(d.url)}" class="f" style="display:inline-block;padding:17px 46px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Complete my order</a>
    </td></tr></table>
    <p class="f" style="margin:14px 0 0;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:13px;color:#555;">
      First order? Use <strong style="color:#A6192E;letter-spacing:0.06em;">WLCM5</strong> for 5% off.
    </p>
  </td></tr>

  <!-- the journey -->
  <tr><td class="px f" style="padding:38px 40px 6px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;">
    <p style="margin:0 0 18px;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;color:#1e1e1e;text-align:center;">What happens after you order</p>
    <table role="presentation" width="100%">
      <tr>
        <td class="col gap" width="33%" valign="top" align="center" style="padding:0 8px;">
          <div style="width:30px;height:30px;line-height:30px;border-radius:50%;background:#A6192E;color:#fff;font-weight:700;font-size:13px;text-align:center;margin:0 auto 10px;">1</div>
          <p class="smh" style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1e1e1e;">Made for your car</p>
          <p class="sm" style="margin:0;font-size:13px;line-height:1.5;color:#666;">Hand-laid carbon, cured and finished to order, typically in 3–5 weeks.</p>
        </td>
        <td class="col gap" width="33%" valign="top" align="center" style="padding:0 8px;">
          <div style="width:30px;height:30px;line-height:30px;border-radius:50%;background:#A6192E;color:#fff;font-weight:700;font-size:13px;text-align:center;margin:0 auto 10px;">2</div>
          <p class="smh" style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1e1e1e;">Checked &amp; shipped</p>
          <p class="sm" style="margin:0;font-size:13px;line-height:1.5;color:#666;">Every part is inspected, then sent fully tracked, standard or express.</p>
        </td>
        <td class="col" width="33%" valign="top" align="center" style="padding:0 8px;">
          <div style="width:30px;height:30px;line-height:30px;border-radius:50%;background:#A6192E;color:#fff;font-weight:700;font-size:13px;text-align:center;margin:0 auto 10px;">3</div>
          <p class="smh" style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1e1e1e;">At your door</p>
          <p class="sm" style="margin:0;font-size:13px;line-height:1.5;color:#666;">Duties and import taxes already paid. No surprise bills on delivery.</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- proof: the wait, in customers' words -->
  <tr><td class="px" style="padding:40px 40px 8px;">
    <p class="f" style="margin:0 0 6px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;color:#1e1e1e;text-align:center;">From people who waited</p>
    <p class="f" style="margin:0 0 20px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:13px;color:#A6192E;text-align:center;letter-spacing:2px;">★★★★★ <span style="color:#777;letter-spacing:0;">verified buyers</span></p>
    <table role="presentation" width="100%" style="background:#f7f7f7;">
      <tr>
        <td class="col" width="44%" valign="middle" style="padding:0;">
          <img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-review-carbon-sam.jpg" width="264" alt="Carbon fibre part as delivered, photo by a customer" style="width:100%;height:auto;">
        </td>
        <td class="col qpad f" width="56%" valign="middle" style="padding:22px 24px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;">
          <p class="qtxt" style="margin:0 0 10px;font-size:19px;line-height:1.35;font-weight:600;color:#1e1e1e;">“Parts took some time but the quality is perfect.”</p>
          <p style="margin:0;font-size:12px;color:#777;">Sam3s · Audi RS3 8Y.5 front inlet ducts</p>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" style="margin-top:14px;">
      <tr>
        <td class="col gap" width="50%" valign="top" style="padding:0 7px 0 0;">
          <img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-review-rs6-gerry.jpg" width="260" alt="Audi RS6 with Vanté front splitter, customer photo" style="width:100%;height:auto;">
          <p class="f smh" style="margin:10px 0 0;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:14px;color:#1e1e1e;font-weight:600;">“Looks great!”</p>
          <p class="f" style="margin:2px 0 0;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:12px;color:#777;">Gerry M. · Audi RS6 C8 front splitter</p>
        </td>
        <td class="col" width="50%" valign="top" style="padding:0 0 0 7px;">
          <img src="https://cdn.shopify.com/s/files/1/0692/3475/3654/files/vante-review-rs3-szum.jpg" width="260" alt="Audi RS3 with Vanté carbon rear diffuser, customer photo" style="width:100%;height:auto;">
          <p class="f smh" style="margin:10px 0 0;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:14px;color:#1e1e1e;font-weight:600;">“Spot on fitment and finish, like stock.”</p>
          <p class="f" style="margin:2px 0 0;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:12px;color:#777;">Szum · Audi RS3 rear spoiler &amp; diffuser</p>
        </td>
      </tr>
    </table>
    <p class="f" style="margin:18px 0 0;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.55;color:#444;text-align:center;font-style:italic;">“Super finish, delivery took some time as stated. Perfect as indicated in the description.”<br><span style="font-style:normal;font-size:12px;color:#777;">FlintE · verified buyer</span></p>
  </td></tr>

  <!-- reasons -->
  <tr><td class="px f" style="padding:38px 40px 8px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;">
    <table role="presentation" width="100%" style="border-top:1px solid #ececec;border-bottom:1px solid #ececec;">
      <tr>
        <td class="col gap" width="50%" valign="top" style="padding:20px 10px 8px 0;">
          <p class="smh" style="margin:0 0 3px;font-size:14px;font-weight:600;color:#1e1e1e;">Worldwide shipping</p>
          <p class="sm" style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#666;">Fully tracked to your door. Free on every body kit.</p>
          <p class="smh" style="margin:0 0 3px;font-size:14px;font-weight:600;color:#1e1e1e;">Duties paid</p>
          <p class="sm" style="margin:0;font-size:13px;line-height:1.5;color:#666;">Import duties and taxes covered, wherever you are.</p>
        </td>
        <td class="col" width="50%" valign="top" style="padding:20px 0 8px 10px;">
          <p class="smh" style="margin:0 0 3px;font-size:14px;font-weight:600;color:#1e1e1e;">12-month warranty</p>
          <p class="sm" style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#666;">On every part we make.</p>
          <p class="smh" style="margin:0 0 3px;font-size:14px;font-weight:600;color:#1e1e1e;">Pay over time</p>
          <p class="sm" style="margin:0;font-size:13px;line-height:1.5;color:#666;">Split it into 3, 6 or 12 payments with Shop Pay at checkout.</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- second CTA + help -->
  <tr><td class="px f" align="center" style="padding:30px 40px 12px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;">
    <table role="presentation"><tr><td align="center" style="background:#A6192E;">
      <a href="${esc(d.url)}" style="display:inline-block;padding:15px 40px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Return to checkout</a>
    </td></tr></table>
    <p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:#444;">
      Not sure about fitment, finish or timing? Talk to a specialist before you order:<br>
      <a href="https://wa.me/447466447152" style="color:#A6192E;font-weight:600;text-decoration:none;">WhatsApp</a>
      &nbsp;·&nbsp;
      <a href="mailto:info@vanteautomotive.com" style="color:#A6192E;font-weight:600;text-decoration:none;">info@vanteautomotive.com</a>
      &nbsp;·&nbsp; or just reply to this email.
    </p>
  </td></tr>

  <!-- footer -->
  <tr><td class="px f" align="center" style="padding:32px 40px 36px;font-family:'Tomorrow','Helvetica Neue',Arial,sans-serif;">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#999;">Vanté Automotive · Engineered in carbon</p>
    <p style="margin:0;font-size:11px;color:#aaa;">You received this because you started a checkout at <a href="https://vanteautomotive.com" style="color:#aaa;">Vanté Automotive</a>.<br><a href="${esc(d.unsub)}" style="color:#aaa;">Don’t email me about this checkout</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;
}
