/* Drives the real frontend (public/app.js) through the whole journey in jsdom,
   hitting the real local server. Catches runtime JS errors the browser would hit. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const BASE = 'http://127.0.0.1:8080';
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/<script src="app.js"><\/script>/, '');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };

(async () => {
  const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  window.fetch = (p, o) => fetch(new URL(p, BASE).toString(), o);
  window.addEventListener('error', e => { console.log('  WINDOW ERROR:', e.message); failures++; });

  window.eval(appJs);
  await sleep(200);

  ok(document.querySelector('#lg-email'), 'login screen rendered');
  document.getElementById('demo-btn').click();
  await sleep(400);
  ok(document.querySelector('#consent-go'), 'consent screen after login');

  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  await sleep(200);
  ok(document.querySelector('#intake-input'), 'intake screen with input');
  ok(document.querySelectorAll('.bubble.ai').length >= 1, 'interviewer asked first question');

  // load the solar persona
  document.getElementById('persona-sel').value = 'solar';
  document.getElementById('persona-go').click();
  await sleep(600);
  ok(document.querySelector('#structure-btn'), 'structure button shown after persona load');
  ok(document.querySelectorAll('.bubble.user').length === 12, 'all 12 demo answers in chat');

  // structure (loader ~2.3s + api)
  document.getElementById('structure-btn').click();
  await sleep(4200);
  ok(document.querySelector('#confirm-fields'), 'review screen rendered');
  const nullBadges = document.querySelectorAll('.nullbadge').length;
  console.log('  (review shows ' + nullBadges + ' "Not stated" badges)');
  ok(document.querySelector('.side-chip.filled') || document.querySelector('input[data-key]'), 'review fields present');

  // confirm -> generating (~5.5s + api)
  document.getElementById('confirm-fields').click();
  await sleep(7000);
  ok(document.querySelector('.doc'), 'blueprint document rendered');
  ok(document.querySelector('.coa-item'), 'cost of inaction items rendered');
  ok(document.querySelectorAll('.chip.kb').length > 5, 'KB reference chips rendered');
  const emDash = document.querySelector('.doc').textContent.includes('\u2014');
  ok(!emDash, 'no em dashes in blueprint view');

  // unlock PDF
  document.getElementById('unlock-btn').click();
  await sleep(100);
  document.getElementById('un-consent').click();
  document.getElementById('un-go').click();
  await sleep(1200);
  ok(document.querySelector('.success-card'), 'delivery success card shown');
  ok(document.body.textContent.includes('HubSpot contact ID'), 'hubspot contact id shown');

  // booking
  document.getElementById('book-btn').click();
  await sleep(200);
  const dayBtn = document.querySelector('[data-day]');
  ok(!!dayBtn, 'booking screen rendered with days');
  dayBtn.click();
  await sleep(150);
  document.querySelectorAll('[data-slot]')[1].click();
  await sleep(150);
  document.getElementById('book-go').click();
  await sleep(150);
  ok(document.body.textContent.includes('Meeting requested'), 'meeting requested state');
  document.getElementById('finish-btn').click();
  await sleep(150);
  ok(document.body.textContent.includes('Your blueprint is on its way'), 'done screen rendered');

  console.log('\n' + (failures === 0 ? 'UI SMOKE TEST PASSED' : failures + ' UI FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('UI smoke error:', e); process.exit(1); });
