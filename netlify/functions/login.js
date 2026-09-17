'use strict';
/* Netlify function: /api/auth/login - alias for the entry gate (/api/auth/start).
 *
 * The app no longer asks for a password: it asks for a name and an email and goes straight
 * to the AI voice call. The old path is kept so an already-deployed site, a cached client,
 * or a bookmarked redirect keeps working. Same handler, same validation, no password.
 */
module.exports = require('./start');
