'use strict';
/* Netlify function: /api/auth/logout (stateless: tokens are signed, nothing to delete) */
const { json } = require('../../lib/netlify-helpers');
exports.handler = async () => json(200, { ok: true });
