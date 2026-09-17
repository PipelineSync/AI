'use strict';
/*
 * Tiny zero-dependency .env loader for LOCAL dev only.
 * Netlify injects environment variables itself, so this file is never needed there.
 * Existing process.env values always win, so `OPENAI_API_KEY=sk-... node server.js`
 * still overrides whatever sits in .env.
 */
const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])((?:\\.|[^\\])*?)\1\s*(?:#.*)?$/.exec(value);
    if (quoted) {
      // strip matching surrounding quotes (a pasted key with quotes is a common 401 cause)
      value = quoted[2];
    } else {
      // strip a trailing inline comment on unquoted values
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

function load(file) {
  const target = file || path.resolve(__dirname, '..', '.env');
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch { return { loaded: false, file: target, keys: [] }; }
  const vars = parse(text);
  const keys = [];
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      if (v !== '') { process.env[k] = v; keys.push(k); }
    }
  }
  return { loaded: true, file: target, keys };
}

module.exports = { load, parse };
