'use strict';
/* Phase 3: email the finished blueprint PDF to the lead.
 *
 * Resend's REST API is called with fetch, so this adds no npm dependency and works on both
 * mounts (the Netlify deliver function and the local dev server) through lib/deliver-core.js.
 *
 * Rules this module exists to keep:
 *   - the recipient is decided by the caller from the HMAC-signed session token, never from
 *     anything the browser sent, so the attachment cannot be redirected by editing the form;
 *   - a send either really happened (Resend returned an id) or it is reported as not sent with
 *     a reason. Nothing here ever reports success that the provider did not confirm;
 *   - nothing throws: the PDF download in the browser must never depend on the email;
 *   - the API key is read from the environment only and is never echoed into a result, a
 *     response body or a log line.
 *
 * Environment (server-side only, never in public/):
 *   PDF_EMAIL_API_KEY   Resend API key (re_...). Unset => the feature is off and reported as off.
 *   PDF_EMAIL_FROM      the From header. Must be an address on a domain verified in Resend.
 *   PDF_EMAIL_SUBJECT   optional subject template; {first_name} {name} {vertical} {tier} {date}
 *   PDF_EMAIL_REPLY_TO  optional Reply-To address
 */
const core = require('./core');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_SUBJECT = 'Your PipelineSync blueprint is attached';
const DEFAULT_TIMEOUT_MS = 8000;
/* Resend accepts 40 MB of attachments; stay well inside it and inside the function timeout. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BRAND = {
  // Brand sheet 1. The email carries the logo's colours, not Otto: he belongs to the product.
  navy: '#0C2B5E', steel: '#3E6892', orange: '#FF7A1A',
  ink: '#1F2933', muted: '#5B6B7B', line: '#DCE3EA',
  bg: '#F6F7F9', card: '#FFFFFF', foot: '#EDF1F5'
};

function str(v) { return String(v == null ? '' : v).trim(); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function isEmail(v) {
  const s = str(v).toLowerCase();
  return s.length > 0 && s.length <= 254 && EMAIL_RE.test(s);
}

/* Only http(s) links are ever rendered, so a malformed value in an environment variable cannot
   become a javascript: URL inside the email. */
function safeLink(v) {
  const s = str(v);
  if (!s || s.length > 500 || /\s/.test(s)) return '';
  return /^https?:\/\//i.test(s) ? s : '';
}

/* Returns null when the feature is switched off (no key), so callers can report "off" instead
   of "failed" without guessing. A key with no PDF_EMAIL_FROM stays configured but is unusable,
   and sendBlueprintEmail() says exactly that. */
function emailConfig(env) {
  env = env || process.env;
  const apiKey = str(env.PDF_EMAIL_API_KEY);
  if (!apiKey) return null;
  return {
    apiKey,
    from: str(env.PDF_EMAIL_FROM),
    replyTo: str(env.PDF_EMAIL_REPLY_TO),
    subject: str(env.PDF_EMAIL_SUBJECT) || DEFAULT_SUBJECT,
    schedulerLink: safeLink(env.SCHEDULER_LINK)
  };
}

function isEnabled(env) {
  return !!emailConfig(env);
}

/* Subject template: {first_name} {name} {vertical} {tier} {date}. Unknown placeholders are left
   alone rather than dropped, so a typo is visible instead of silent. */
function subjectFor(template, ctx) {
  const c = ctx || {};
  const out = str(template || DEFAULT_SUBJECT)
    .replace(/\{(first_name|name|vertical|tier|date)\}/g, (m, k) => str(c[k]) || m)
    .replace(/\s+/g, ' ')
    .trim();
  return (out || DEFAULT_SUBJECT).slice(0, 180);
}

/* The 2-3 sentence summary, built only from values the blueprint actually carries. No new
   numbers, no promises: the same rule the blueprint follows. */
function summarySentences(bp) {
  const b = bp || {};
  const meta = b.meta || {};
  const stack = b.stack || {};
  const pipeline = b.pipeline || {};
  const coa = b.coa || {};
  const sentences = [];

  const vertical = str(meta.verticalLabel);
  if (vertical) sentences.push('Thanks for walking us through your ' + vertical.toLowerCase() + ' business on the call.');
  else sentences.push('Thanks for taking the discovery call.');

  const tier = str(stack.tier);
  const label = str(pipeline.label);
  const variant = str(pipeline.variant);
  const variantAdds = variant && label && label.toLowerCase().indexOf(variant.toLowerCase()) < 0;
  if (tier && label) {
    sentences.push('Your blueprint recommends ' + tier + ' built on the ' + label +
      (variantAdds ? ' (' + variant + ' close)' : '') + ', with the lead sources and workflows you confirmed.');
  } else if (tier) {
    sentences.push('Your blueprint recommends ' + tier + ', with the workflows and lead sources you confirmed.');
  }

  const monthly = coa.totalMonthly;
  const six = coa.totalSix;
  if (typeof monthly === 'number' && isFinite(monthly) && monthly > 0) {
    sentences.push('Against your own numbers, the gaps we mapped are costing about ' + core.fmtMoney(monthly) +
      ' a month' + (typeof six === 'number' && isFinite(six) && six > 0 ? ', or ' + core.fmtMoney(six) + ' over six months' : '') + '.');
  }
  return sentences.slice(0, 3);
}

/* The branded HTML body plus its plain-text twin. Both carry the same facts. */
function buildEmail(opts) {
  const o = opts || {};
  const bp = o.blueprint || {};
  const to = str(o.to);
  const name = str(o.name);
  const firstName = core.firstNameOf(name) || str(o.firstName) || 'there';
  const filename = str(o.filename) || core.pdfFilename(bp);
  const vertical = str((bp.meta || {}).verticalLabel);
  const tier = str((bp.stack || {}).tier);
  const bookingLink = safeLink(o.schedulerLink);
  const subject = subjectFor(o.subjectTemplate || o.subject, {
    first_name: firstName, name, vertical, tier, date: str((bp.meta || {}).date)
  });
  const sentences = summarySentences(bp);

  const greet = firstName === 'there' ? 'Hello,' : 'Hi ' + firstName + ',';
  const attachLine = 'Your blueprint is attached as ' + filename + '.';
  const bookLine = bookingLink
    ? 'If you would like to walk through it, pick a time that suits you: ' + bookingLink
    : '';

  const text = [
    greet,
    '',
    ...sentences,
    '',
    attachLine,
    bookLine ? '' : null,
    bookLine || null,
    '',
    'PipelineSync AI',
    'Figures in the blueprint are planning estimates based on what you told us on the call, not a quote.'
  ].filter(l => l !== null).join('\n');

  const pStyle = `margin:0 0 14px;font-size:15px;line-height:1.6;color:${BRAND.ink}`;
  const paragraphs = sentences.map(s => `<p style="${pStyle}">${esc(s)}</p>`).join('');

  const html =
`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(attachLine)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:14px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:${BRAND.navy};padding:20px 28px;">
        <div style="font-size:13px;letter-spacing:.14em;font-weight:700;color:#FFFFFF;">PIPELINESYNC AI</div>
        <div style="margin-top:4px;font-size:12px;color:#B9CEDF;">${esc(vertical ? vertical + ' revenue operations blueprint' : 'Revenue operations blueprint')}</div>
      </td></tr>
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.35;color:${BRAND.navy};font-weight:700;">${esc(greet)}</h1>
        ${paragraphs}
        <p style="margin:18px 0 8px;font-size:15px;line-height:1.6;color:${BRAND.ink};"><strong>Your blueprint is attached as ${esc(filename)}.</strong></p>
        ${bookingLink ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;"><tr><td style="background:${BRAND.navy};border-radius:10px;"><a href="${esc(bookingLink)}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">Book your consultation</a></td></tr></table>
        <p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:${BRAND.muted};">Or open the scheduler directly: <a href="${esc(bookingLink)}" style="color:${BRAND.steel};">${esc(bookingLink)}</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:0 28px 24px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">You are receiving this because you asked for the blueprint after the discovery call${to ? ' on ' + esc(to) : ''}. The figures in the attached document are planning estimates based on what you told us, not a quote.</p>
      </td></tr>
      <tr><td style="background:${BRAND.foot};padding:16px 28px;font-size:12px;line-height:1.6;color:${BRAND.muted};">
        PipelineSync AI${bookingLink ? '' : ' - reply to this email and we will book the walkthrough.'}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text, to, filename };
}

/* Resend error responses are JSON ({statusCode, name, message}); anything else is passed through
   as a trimmed string. The API key is scrubbed from whatever we keep, so it can never leak into
   a response body or a log line. */
function resendError(status, body, apiKey) {
  let detail = '';
  if (body && typeof body === 'object') detail = str(body.message || body.error || body.name);
  else detail = str(body);
  if (!detail) detail = 'Resend rejected the request (HTTP ' + status + ').';
  return redact(detail, apiKey).slice(0, MAX_ERROR_CHARS);
}

function redact(text, secret) {
  let out = str(text);
  if (secret && out.indexOf(secret) >= 0) out = out.split(secret).join('[redacted]');
  return out;
}

async function readResponse(res) {
  if (!res) return '';
  if (typeof res.text === 'function') {
    try { return await res.text(); } catch (e) { return ''; }
  }
  if (typeof res.json === 'function') {
    try { return JSON.stringify(await res.json()); } catch (e) { return ''; }
  }
  return '';
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

/* Send the blueprint PDF to `to` as an attachment.
   Always resolves. Shape:
     { sent: true,  to, id, subject }
     { sent: false, to, error, configured }
   `configured` is false when no PDF_EMAIL_API_KEY is present (the feature is off on this host). */
async function sendBlueprintEmail(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const to = str(o.to).toLowerCase();
  const out = { sent: false, to: to || null, configured: false };

  if (!isEmail(to)) {
    out.error = 'No verified email address in this session, so the blueprint was not emailed.';
    return out;
  }
  const cfg = emailConfig(env);
  if (!cfg) {
    out.error = 'Email delivery is not configured on this server (PDF_EMAIL_API_KEY is not set), so the blueprint was not emailed.';
    return out;
  }
  out.configured = true;
  if (!cfg.from || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.from.replace(/^.*</, '').replace(/>.*$/, '').trim())) {
    out.error = 'PDF_EMAIL_FROM is not set to a usable From address, so the blueprint was not emailed.';
    return out;
  }
  const buffer = o.pdfBuffer;
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    out.error = 'There was no PDF to attach, so the blueprint was not emailed.';
    return out;
  }
  const content = buffer.toString('base64');
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    out.error = 'The PDF is larger than Resend accepts as an attachment, so it was not emailed.';
    return out;
  }
  const fetchImpl = o.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!fetchImpl) {
    out.error = 'This server cannot reach Resend because fetch is unavailable, so the blueprint was not emailed.';
    return out;
  }

  const mail = buildEmail({
    blueprint: o.blueprint, name: o.name, to,
    filename: o.filename, subjectTemplate: cfg.subject,
    schedulerLink: o.schedulerLink || cfg.schedulerLink
  });
  const payload = {
    from: cfg.from,
    to: [to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: [{ filename: mail.filename, content }]
  };
  if (cfg.replyTo) payload.reply_to = cfg.replyTo;

  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  out.attempted = true;
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cfg.apiKey,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });
    const text = await readResponse(res);
    const body = parseJson(text);
    if (!res || !res.ok) {
      out.error = resendError(res && res.status, body || text, cfg.apiKey);
      return out;
    }
    out.sent = true;
    out.subject = mail.subject;
    if (body && body.id) out.id = String(body.id);
    delete out.error;
    return out;
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''));
    out.error = aborted
      ? 'Resend did not respond within ' + Math.max(1, Math.round(timeoutMs / 1000)) + 's, so the blueprint was not emailed.'
      : redact('Could not reach Resend: ' + ((e && e.message) || 'unknown error'), cfg.apiKey).slice(0, MAX_ERROR_CHARS);
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* The email block the API returns to the browser and that is logged to HubSpot. Exactly the
   fields the UI needs to tell the truth, and nothing that carries the key. */
function publicEmail(result) {
  if (!result) return { sent: false, error: 'Email delivery was not attempted.' };
  const out = { sent: !!result.sent };
  if (result.to) out.to = result.to;
  if (result.sent) {
    if (result.id) out.id = result.id;
    if (result.subject) out.subject = result.subject;
  } else {
    out.error = str(result.error) || 'The blueprint could not be emailed.';
    if (result.configured === false) out.configured = false;
  }
  return out;
}

module.exports = {
  RESEND_ENDPOINT,
  DEFAULT_SUBJECT,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  emailConfig,
  isEnabled,
  isEmail,
  safeLink,
  subjectFor,
  summarySentences,
  buildEmail,
  sendBlueprintEmail,
  publicEmail
};
