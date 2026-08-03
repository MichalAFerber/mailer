// The §6 chrome, extracted from tgwab-standards/templates/tgwab-email-layout.html.
// Author comments are stripped: they are guidance for editing the layout, not
// email content, and one of them contains a literal {{BODY}} that a naive
// replace mistakes for the slot. The MSO conditional is functional and kept.
//
// Tokens here are STRING REPLACEMENT. {{BODY}} is not — it is renderer output.
export const LAYOUT = String.raw`<!DOCTYPE html>
<html lang="en" style="margin:0;padding:0;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{{SUBJECT}}</title>

<style>
  @media only screen and (max-width:600px) {
    .wrap     { padding:16px !important; }
    .card     { padding:28px 20px !important; border-radius:12px !important; }
    .h1       { font-size:22px !important; letter-spacing:-.4px !important; }
    .cell     { padding:9px 8px !important; font-size:12px !important; }
    .mono-blk { font-size:12px !important; padding:14px !important; }
    .btn      { display:block !important; text-align:center !important; }
    .foot-pad { padding:20px 21px 0 21px !important; }
  }

  @media (prefers-color-scheme: dark) {
    body, .page      { background:#0c0d0f !important; }
    .card            { background:#16181c !important; border-color:#292d33 !important; }
    .ink, .h1        { color:#f2f4f7 !important; }
    .muted           { color:#9aa3ad !important; }
    .rule            { border-color:#292d33 !important; background:#292d33 !important; }
    .wash            { background:#1d2025 !important; }
    .cell            { border-color:#292d33 !important; color:#d6dae0 !important; }
    .btn, .btn-wrap  { background:#f2f4f7 !important; color:#14161a !important; }
    .link            { color:#8ab4f8 !important; }
    .mono-blk        { background:#1d2025 !important; border-color:#31363d !important; color:#e4e8ee !important; }
    .mono-in         { background:#1d2025 !important; color:#e4e8ee !important; }
    .li              { color:#d6dae0 !important; }
  }

  a { text-decoration:none; }
  a:hover { text-decoration:underline; }
  /* Collapse suits the data tables (shared 1px hairlines). Any cell with BOTH a
     border and a border-radius must override to separate or the corner squares off. */
  table { border-collapse:collapse; }
  img { border:0; outline:none; -ms-interpolation-mode:bicubic; }
</style>
<!--[if mso]>
<style>
  * { font-family: Arial, Helvetica, sans-serif !important; }
  .mono, .mono-blk, .mono-in, .h1, .label { font-family: Consolas, 'Courier New', monospace !important; }
</style>
<![endif]-->
</head>

<body class="page" style="margin:0;padding:0;width:100%;background:#eceef1;color:#14161a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;">

<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">
  {{PREHEADER}}
  &#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eceef1" class="page" style="background:#eceef1;">
<tr><td align="center" class="wrap" style="padding:32px;">

<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0;">

  
  <tr><td style="padding:0 4px 18px 4px;">
    <img src="{{LOGO_URL}}" width="26" height="26" alt=""
         style="width:26px;height:26px;border-radius:6px;vertical-align:middle;">
    <span class="mono ink" style="font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;font-weight:700;letter-spacing:-.2px;color:#14161a;vertical-align:middle;padding-left:9px;">
      {{BRAND_NAME}}<span style="color:{{ACCENT}};">.</span>
    </span>
  </td></tr>

  <tr><td bgcolor="#ffffff" class="card" style="background:#ffffff;border-radius:16px;border:1px solid #dfe3e8;padding:40px 36px;">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td height="3" style="height:3px;line-height:3px;font-size:0;background:{{ACCENT}};width:44px;">&nbsp;</td>
      <td height="3" style="height:3px;line-height:3px;font-size:0;">&nbsp;</td>
    </tr></table>

{{BODY}}

  </td></tr>

  
  <tr><td class="foot-pad" style="padding:22px 37px 0 37px;">
    
    {{FOOTER}}
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;
