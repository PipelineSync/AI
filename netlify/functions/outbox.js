'use strict';
/* Netlify function: /dev/outbox
 * On Netlify there is no shared in-memory store, so lead pushes are written
 * to the function logs instead. This page tells testers where to look.
 */
exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline';"
  },
  body: [
    '<!doctype html><meta charset="utf-8"><title>HubSpot lead outbox (Netlify)</title>',
    '<style>body{font:14px/1.6 system-ui;background:#f6f7f9;margin:0;padding:28px;max-width:760px}h1{font-size:20px}code{background:#eef1f4;padding:2px 6px;border-radius:5px;font-size:13px}a{color:#e85c3a}</style>',
    '<h1>HubSpot lead outbox (mock Function D)</h1>',
    '<p>On Netlify the functions are serverless, so there is no shared memory between requests. Every lead push is therefore written to the <b>function logs</b> instead of a stored outbox.</p>',
    '<p><b>Where to find your leads:</b> Netlify dashboard &rarr; this site &rarr; <b>Functions</b> tab &rarr; select <code>deliver</code> &rarr; <b>Logs</b>. Each push appears as a line starting with <code>[hubspot-mock] lead push:</code> containing the full JSON payload (email, answers, blueprint reference).</p>',
    '<p>Alternatively open <b>Deploys</b> &rarr; the active deploy &rarr; <b>Logs</b> and search for <code>[hubspot-mock]</code>.</p>',
    '<p>In production this call goes to the HubSpot API with the private app token; the payload shape in the logs is exactly what the contact will carry.</p>',
    '<p><a href="/"> &larr; Back to the app</a></p>'
  ].join('')
});
