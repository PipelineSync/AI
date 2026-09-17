'use strict';
/* Netlify function: /api/auth/logout (stateless: tokens are signed, nothing to delete) */
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({ ok: true })
});
