# HubSpot Setup for PipelineSync AI — What You Need + Step-by-Step

This is the exact setup for this repo. Today the app runs on a **mock** (`[hubspot-mock] lead push:` in the logs). With 2 values from HubSpot it becomes live.

**Date:** 2026-09-18
**Repo:** `PipelineSync/AI` (`server.js` + `netlify/functions/deliver.js` `->` `lib/core.js:makeLeadPayload`)

---

## 1. What you need FROM HubSpot (checklist before you start)

You only need to copy **2 values** out of HubSpot. Everything else stays inside HubSpot.

| # | What to copy | Where you paste it | Why |
|---|---|---|---|
| **1 — REQUIRED** | **Private App Access Token** → looks like `pat-na1-xxxxxxxx-xxxx-...` | `HUBSPOT_ACCESS_TOKEN` env var (Netlify + local `.env`) | This is how `deliver.js` (Function D) creates the Contact/Deal. It never goes to the browser — server only. |
| **2 — REQUIRED** | **Meetings Scheduler Link** → `https://meetings.hubspot.com/your-name/...` | `SCHEDULER_LINK` env var | This replaces the mock booking panel in `public/app.js` with your real HubSpot Meetings embed. |
| **3 — Auto** | **Portal ID (Hub ID)** | You don't paste it — just note it for debugging | Visible in HubSpot URL `app.hubspot.com/.../<PORTAL_ID>/...` |
| **4 — Optional** | **Existing Deal Pipeline ID** | Only if you want to push into an *existing* pipeline instead of creating new | If blank, we create `PipelineSync - Revenue Blueprint` pipeline |

**Access you need in HubSpot to get these:** Super Admin or Admin with `App Marketplace Access` + `Contacts` + `Deals` edit rights. If you are not admin, ask your admin to create the Private App and send you the token.

---

## 2. HubSpot account requirements for this blueprint

The blueprint itself (`lib/core.js:KB`) assumes:

- **Sales Hub Professional is the floor** (`KB-TIER-01`) — workflows are required. Starter *cannot* run them, so don't test on a Starter portal.
- If you are on Enterprise, add 4+ reps / 12+ week cycle / 500+ leads/mo triggers — still works.
- Marketing Hub Professional + Service Hub are added automatically when thresholds hit — no extra setup.

Any paid HubSpot CRM with contacts + deals works for the *test* push. Workflows just won't run on Starter.

---

## 3. Step-by-step — Create the Private App & get the token (5 min)

### Step 1 — Open Private Apps
1. Log in to **HubSpot** → top-right **Settings** (gear icon)
2. Left sidebar → **Integrations** → **Private Apps**
3. Click **Create a private app**

> If you don't see Private Apps: you are not Super Admin. Ask an admin or go to `app.hubspot.com/private-apps/<YOUR_PORTAL_ID>` directly.

### Step 2 — Name it
- **Name:** `PipelineSync AI`
- **Logo:** upload `public/logo.svg` (optional)
- **Description:** `PipelineSync AI — server-side lead push (contacts + deals + timeline) and blueprint delivery`

### Step 3 — Set Scopes (Scopes tab)

This is the critical part. Tick **exactly these scopes** — nothing more, nothing less:

**CRM:**
- `crm.objects.contacts` — **Write + Read** (create/update contact)
- `crm.objects.companies` — **Write + Read** (optional, for company association)
- `crm.objects.deals` — **Write + Read** (create deal from blueprint)
- `crm.schemas.contacts` — **Read** (read custom properties)
- `crm.schemas.companies` — **Read**
- `crm.schemas.deals` — **Read**
- `crm.objects.owners` — **Read** (assign deal owner if needed)

**Optional but recommended (for timeline notes):**
- `timeline` — if you want the blueprint PDF link as a timeline event
- `crm.objects.custom` — only if you use custom objects

Do **NOT** add `oauth`, `media`, or `content` — not needed and widens risk.

### Step 4 — Create & copy the token
1. Click **Create app** (top-right)
2. Modal shows **Access token** — `pat-na1-...` — **Copy it now**. You see it only once.
3. Click **Continue creating** → **Show token** again if needed (still one-time).

> Store it in 1Password / vault. Do not paste it in Slack, GitHub, or `public/` — it is a secret. The repo `.env` is gitignored for this reason.

### Step 5 — Get your Meetings Scheduler Link
1. In HubSpot → **Sales** → **Meetings** → **Meetings Scheduler** (or **Library** → **Meetings**)
2. If none exists: **Create scheduling page** → **One-on-one** → call it `PipelineSync — 30-min Blueprint Review`
3. Set: duration **30 min**, location **Zoom / Google Meet**, availability, buffer.
4. Click **Copy link** → `https://meetings.hubspot.com/<your-slug>/pipelinesync-blueprint-review`
5. Test it in incognito — it should load without login.

---

## 4. Where to paste the 2 values

### A. Deployed site (Netlify — production)

1. Netlify dashboard → your site (`pipelinesync-ai`) → **Site configuration** → **Environment variables** → **Add a variable**
2. Add:
   ```
   HUBSPOT_ACCESS_TOKEN = pat-na1-xxxxxxxx...
   SCHEDULER_LINK = https://meetings.hubspot.com/...
   PS_TOKEN_SECRET = any long random string (e.g. openssl rand -hex 32)
   ```
   Scope: **All scopes** / **Functions** — default is fine. Never set as "Builds" only.
3. **Deploys** → **Trigger deploy** → **Deploy site** — env vars need a redeploy to reach functions.

### B. Local dev (`node server.js`)

1. In repo root `/home/user/AI`:
   ```bash
   cp .env.example .env   # if you don't have one
   nano .env
   ```
2. Add the same two lines:
   ```
   HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx...
   SCHEDULER_LINK=https://meetings.hubspot.com/...
   PS_TOKEN_SECRET=local-dev-secret-change-me
   # Optional for local testing via ngrok/preview:
   # SUPABASE_URL=...
   # SUPABASE_SECRET_KEY=...
   ```
3. Restart: `node server.js` — you will see `Discovery call voice: ...` in logs.

> **Security rule from `server.js` + `lib/netlify-helpers.js`:** the token is read **only** inside `netlify/functions/deliver.js` / `server.js`. Check `public/app.js` — it never contains `HUBSPOT_ACCESS_TOKEN`. If `PS_TOKEN_SECRET` is missing in production (`CONTEXT=production` on Netlify), the server throws `Server misconfigured: missing token secret` rather than using the dev fallback.

---

## 5. What the live push does (so you know what to create in HubSpot)

Current **mock** payload (`lib/core.js:makeLeadPayload`) is:

```json
{
  "contact_id": "mock-xxxx",
  "email": "client@company.com",
  "name": "Juan Dela Cruz",
  "source": "pipelinesync-ai-blueprint",
  "lifecycle_stage": "lead",
  "industry": "solar",
  "answers": { "...23 Section 7 fields..." },
  "blueprint_ref": { "vertical": "Solar", "tier": "Sales Hub Professional", "pipeline": "Single-call pipeline", "kb_version": "v1", "kb_references": ["KB-TIER-01", ...] },
  "voice_call": { "provider": "openai-realtime", "turns": 12, ... , "audio_retained": false }
}
```

**Live mapping we will wire (when you hand me the token):**

| Payload field | HubSpot target | Action |
|---|---|---|
| `email`, `name` | **Contacts** (`email`, `firstname`/`lastname` split via `cleanName`/`firstNameOf`) | `POST /crm/v3/objects/contacts` — search by email first, update if exists (do not duplicate) |
| `industry`, `answers.*`, `blueprint_ref` | **Custom contact/deal properties** (see §6) | `PATCH` after create |
| `blueprint_ref.tier` / `pipeline` | **Deals** → pipeline `PipelineSync - Revenue Blueprint` (or your existing ID) → stage `New` | `POST /crm/v3/objects/deals` + associate to contact |
| `voice_call` | **Deal note / Timeline event** (`audio_retained: false` always) | Add note: `Discovery call: openai-realtime, 12 turns, required fields captured` |
| Consent (`consent === true`) | **Contact property** `pipelinesync_consent` + `consent_timestamp` | Required before `buildPdf` — we already enforce `consent !== true` → 400 |

If `HUBSPOT_ACCESS_TOKEN` is **not set**, the function keeps logging `[hubspot-mock] lead push:` to Netlify Functions logs — nothing breaks, you just don't get a real contact.

---

## 6. Custom properties to create (recommended — 2 min each, or we auto-create via API)

If you skip this, contacts/deals still create, but extra fields land in the deal **description** fallback. Creating them gives you filters, lists, and reporting.

**Create in HubSpot → Settings → Properties → Select object → Create property**

**Contacts — group `PipelineSync AI`:**

| Property label | Field name (internal) | Type | Group | Example value |
|---|---|---|---|---|
| PipelineSync Industry | `pipelinesync_industry` | Dropdown: `solar`, `medical`, `home_services`, `ecommerce`, `generic` | PipelineSync AI | `solar` |
| Typical Deal Size | `pipelinesync_deal_size` | Number | PipelineSync AI | `120000` |
| Monthly Lead Volume | `pipelinesync_monthly_leads` | Number | PipelineSync AI | `45` |
| Close Rate % | `pipelinesync_close_rate` | Number | PipelineSync AI | `22` |
| Biggest Headache | `pipelinesync_headache` | Multi-line text | PipelineSync AI | `Leads slip between calls` |
| Six Month Goal | `pipelinesync_goal` | Multi-line text | PipelineSync AI | `40 deals/mo` |
| Business Description | `pipelinesync_business_desc` | Multi-line text | PipelineSync AI | `Solar installs...` |
| Blueprint KB Version | `pipelinesync_kb_version` | Text | PipelineSync AI | `v1` |
| Blueprint Tier | `pipelinesync_tier` | Text | PipelineSync AI | `Sales Hub Professional` |
| Consent Given | `pipelinesync_consent` | Boolean | PipelineSync AI | `true` |

**Deals — same group:**

| Property | Field name | Type | Notes |
|---|---|---|---|
| Blueprint Vertical | `pipelinesync_vertical` | Text | `Solar` / `Medical` etc. |
| Pipeline Variant | `pipelinesync_pipeline_variant` | Dropdown: `one-call`, `two-call` | drives stage set |
| Blueprint Link | `pipelinesync_blueprint_link` | Text | URL if you later store PDF in HubSpot File Manager |
| KB References | `pipelinesync_kb_refs` | Multi-line text | `KB-TIER-01, KB-PIPE-O1...` — audit |

> Internal names must be **lowercase + underscores** — HubSpot enforces this. The code in `deliver.js` will use these exact names.

**Deal Pipeline (Deals → Pipelines):**
- Create pipeline: `PipelineSync - Revenue Blueprint`
- Stages: `New` → `Contacted` → `Qualified` → `Proposal` → `Closed Won` → `Closed Lost` (for `one-call`) or the 8-stage `two-call` variant from `KB.pipelines`. We match `close_type` automatically.

---

## 7. How to verify it works

### Test on Netlify (deployed)
1. Open `https://<your-site>.netlify.app` → enter **name + email** → **Agree & Start Call** → pick a persona → **Load demo answers** → **Structure my answers** → **Confirm and generate blueprint** → tick **Consent** → **Unlock the PDF**
2. Netlify → **Functions** → `deliver` → **Logs** → you should see `lead push:` with real `contact_id` (not `mock-`) when live, else `[hubspot-mock]`
3. HubSpot → **Contacts** → search the email you just used → open contact → check custom properties + **Associations** → deal in `PipelineSync - Revenue Blueprint` pipeline.

### Test locally
```bash
node server.js
# in another terminal:
curl -X POST http://localhost:8080/api/health
# Run full journey, then:
open http://localhost:8080/dev/outbox   # shows all pushes with voice_call block
```

### API smoke test (with your token)
```bash
curl -X POST "https://api.hubapi.com/crm/v3/objects/contacts" \
  -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"properties":{"email":"test+pipelinesync@yourdomain.com","firstname":"PipelineSync","lastname":"Test"}}' | jq
# Expect: {"id":"...","properties":{...}}
# Then delete test contact in HubSpot UI.
```

If you get `401`: token wrong / not redeployed. `403`: scopes missing — go back to Private App → Scopes.
If `deliver` returns `503` with `Supabase persistence failed` — that is Supabase, not HubSpot — set `SUPABASE_URL` etc. or leave them empty (app runs without Supabase).

---

## 8. What to send me to go live

When you are ready, paste in chat (or set the env vars yourself):

1. `HUBSPOT_ACCESS_TOKEN` (the `pat-na1-...` — I will add it to Netlify env for you and never log it)
2. `SCHEDULER_LINK` (the `meetings.hubspot.com/...` link)
3. Portal ID (optional, for logs)
4. Whether to **create a new pipeline** or use an **existing pipeline ID** + its stage IDs

I will then:
- Replace the `logLead()` mock in `netlify/functions/deliver.js` (+ `server.js` outbox) with the real `fetch("https://api.hubapi.com/crm/v3/...")` POST (search-then-create, with `try/catch` so a HubSpot outage never blocks PDF delivery — PDF still returns `pdf_base64`).
- Add the custom properties mapping from §6 (with fallback to deal description if a property does not exist yet).
- Wire `SCHEDULER_LINK` into `public/app.js` booking embed (replacing the mock day/slot picker when the env is set).
- Push to `arena/01a0b64d-ai` and redeploy.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Server misconfigured: missing token secret` (500) | `PS_TOKEN_SECRET` not set in production | Add `PS_TOKEN_SECRET` in Netlify → redeploy |
| PDF downloads but no HubSpot contact | `HUBSPOT_ACCESS_TOKEN` not set | Add it → redeploy → check Functions → `deliver` logs for `401/403` |
| `401 Unauthorized` from `api.hubapi.com` | Token typo / wrong portal / revoked | Re-copy from Private Apps → re-set env |
| `403 Forbidden` + `scope` in error | Scopes missing | Private Apps → Scopes → add `crm.objects.contacts.write` etc. → Update → re-copy token (token encodes scopes) |
| `429` Rate limited | Too many test pushes | Wait 10s, or add `429` retry in `deliver.js` (we handle it) |
| Meetings embed shows blank | `SCHEDULER_LINK` wrong / not public | Open link incognito, ensure **Meetings** → **Scheduling page** is **Active** |
| CSP blocks Meetings iframe | `frame-ancestors` | The embed is an iframe to `meetings.hubspot.com` — `connect-src 'self'` allows it; the Meetings link itself is the iframe `src`, not an API call |

---

## 10. Security checklist (do not skip)

- [ ] Token is in **Netlify Environment variables** scoped to **Functions**, not in `public/`, not in Git, not in a Netlify build log.
- [ ] `.env` is **gitignored** (it is: `/.env` in `.gitignore`).
- [ ] Rotate token every 90 days: Private Apps → your app → **Rotate token** → update Netlify env → redeploy.
- [ ] `audio_retained: false` is always set — we never store audio, only transcript text in `voice_call` block.
- [ ] `SCHEDULER_LINK` is public — no secret, safe to commit in code if needed (but we keep it in env).

---

**Next step:** Create the Private App (§3, 3 minutes), copy the `pat-na1-...` + Meetings link, and say *“here is my token”* — I will wire `deliver.js` live in one commit and verify with a test contact against your portal.
