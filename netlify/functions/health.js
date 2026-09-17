'use strict';
/* Netlify function: /api/health */
const { json } = require('../../lib/netlify-helpers');
exports.handler = async () => json(200, { ok: true, service: 'pipelinesync-ai-prototype', version: '0.2', mode: 'netlify' });
