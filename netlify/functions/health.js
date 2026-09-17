'use strict';
/* Netlify function: /api/health */
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({ ok: true, service: 'pipelinesync-ai-prototype', version: '0.2', mode: 'netlify' })
});
