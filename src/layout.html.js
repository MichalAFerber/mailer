// The §6 chrome, extracted from tgwab-standards/templates/tgwab-email-template.html.
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
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{{SUBJECT}}</title>

<style>
  @media only screen and (max-width:600px) {
    .wrap     { padding:16px !important; }
    .card     { padding:28px 20px !important; border-radius:12px !important; }
    .h1       { font-size:22px !important; letter-spacing:-.4px !important; }
    .cell     { padding:9px 8px !important; font-size:12px !important; }
    .mono-blk { font-size:12px !important; }
    .btn      { display:block !important; text-align:center !important; }
    .head-pad { padding:0 21px 18px 21px !important; }
    .foot-pad { padding:20px 21px 0 21px !important; }
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

<body class="page" style="margin:0;padding:0;width:100%;background:#ffffff;color:#14161a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;">

<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">
  {{PREHEADER}}
  &#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" class="page" style="background:#ffffff;">
<tr><td align="center" class="wrap" style="padding:32px;">

<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0;">

  
{{HEADER}}

  <tr><td bgcolor="#ffffff" class="card" style="background:#ffffff;border-radius:16px;border:1px solid #dfe3e8;padding:40px 36px;">

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
