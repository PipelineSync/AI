# HubSpot Custom Properties Setup

PipelineSync AI writes a set of `pipelinesync_*` custom properties to HubSpot contacts and deals. These properties were previously auto-created inside the request path (`ensureCustomPropertiesOnce` in `lib/hubspot.js`), which added latency to the entry gate.

**Now property creation is out of the hot path.** Run the setup script once after creating your Private App token.

## One-time setup

1. Create a Private App in HubSpot (Settings → Integrations → Private Apps) with scopes:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
   - `crm.schemas.contacts.write` (needed only for this setup)
   - `crm.schemas.deals.write` (needed only for this setup)

2. Copy the token (`pat-na1-...`) and set it in your environment:

```bash
export HUBSPOT_ACCESS_TOKEN=pat-na1-...
# optional timeouts
export HUBSPOT_TIMEOUT_MS=4000
```

3. Run the setup:

```bash
npm run hubspot:setup
# or
node scripts/hubspot-setup.js
```

The script creates:

**Contacts (13):**
- `pipelinesync_source`, `pipelinesync_industry`, `pipelinesync_deal_size`, `pipelinesync_monthly_leads`, `pipelinesync_close_rate`, `pipelinesync_monthly_deals`, `pipelinesync_headache`, `pipelinesync_goal`, `pipelinesync_business_desc`, `pipelinesync_kb_version`, `pipelinesync_tier`, `pipelinesync_pipeline_variant`, `pipelinesync_consent`

**Deals (5):**
- `pipelinesync_vertical`, `pipelinesync_pipeline_variant`, `pipelinesync_kb_refs`, `pipelinesync_kb_version`, `pipelinesync_business_desc`

It is idempotent — existing properties are reported as "Exists" and not recreated.

## Runtime behavior

- **Normal requests** (`/api/auth/start`, `/api/deliver`) do **not** attempt to create properties. They write only the properties that exist, and if HubSpot returns 400 naming unknown properties, they drop only those names and retry.
- **Fallback auto-create:** If you set `HUBSPOT_AUTO_CREATE_PROPS=true`, a 400 that names missing properties will trigger creation of those properties and a retry. This is kept as a safety net, but the setup script is recommended. When a 400 names no specific property, the code drops every custom property (last-resort), logs which were dropped, and includes `droppedProps` in the result so it appears in the HubSpot note and logs.
- **Timeouts:** Every HubSpot fetch uses `HUBSPOT_TIMEOUT_MS` (default 4000) via AbortController. Retry-After/backoff waits are capped at 1000 ms. The entry gate has a total budget `HUBSPOT_START_BUDGET_MS` (default 3500); if exceeded, it returns `hubspot:{ok:false,pending:true}` with no contact id in the token, and deliver will find or create the contact later by email.

## Optional deal configuration

- `HUBSPOT_DEAL_AMOUNT` — if set, used as deal `amount`; otherwise amount is left empty (typical_deal_size stays only on contact).
- `HUBSPOT_DEAL_PIPELINE` — internal pipeline ID to set on new deals.
- `HUBSPOT_DEAL_STAGE` — internal stage ID to set on new deals.
- `HUBSPOT_OWNER_ID` — HubSpot owner ID to set as `hubspot_owner_id` on new contacts and deals.

See `.env.example` for all commented options.

## Verification

After setup, create a test lead via `/api/auth/start` and check HubSpot contact properties contain `pipelinesync_*`. The HubSpot note on deliver will also show if any custom props were dropped.

## Troubleshooting

- `409 already exists` → property already present, safe to ignore (script reports "Exists").
- `403` → token missing schema write scopes for setup; add them temporarily.
- Timeout → check network, or increase `HUBSPOT_TIMEOUT_MS`.
- If you see `Dropped custom props` in logs or HubSpot note, run setup again or enable `HUBSPOT_AUTO_CREATE_PROPS=true` for one request.
