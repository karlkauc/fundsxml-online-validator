# CLAUDE.md — XML Online Viewer

XML data viewer + XSD validator. FastAPI + lxml backend, React/TS/Vite/Tailwind
frontend, served as one container. Sibling of the **XSD Online Viewer**
(<https://www.xsd-viewer.online>); shares its architecture and hardening.

## Layout

- `backend/app/` — FastAPI app. `parser/` (security, xml_tree, xsd_store,
  schema_fetch, validate), `api/` (xml, xsd, validate, releases, feedback,
  `_common.py` with `reject()`), `report/excel.py`, `usage/` (anonymous usage
  events + feedback store, ported from the XSD viewer), `cache.py`, `config.py`,
  `main.py`.
- `frontend/src/` — SPA: `components/` (Uploader, XmlTreeView, DiagramView,
  ValidationPanel, FundsXmlReleases), `stores/appStore.ts`, `api/client.ts`.
- `docs/DEPLOY_CLOUD_RUN.md` — hardening/deploy reference.
- Header/dialogs (Search, Feedback, XSD Viewer link, GitHub, About, theme)
  mirror the XSD viewer; shared links/events live in `frontend/src/lib/links.ts`.
- **XML-first workflow.** The XSD panel is disabled until an XML document is
  loaded (`Uploader`'s `disabled`/`disabledHint`; exempt on `/fundsxml`, which
  loads a release schema before any document exists), the XML panel rejects
  `.xsd` input with a pointer to the XSD viewer, and the empty state explains
  what the app is for. Keep the XSD framed as *validation only* — the schema
  visualiser is the sibling site.
- **Auto-schema.** `parse_xml` reads `xsi:schemaLocation` /
  `xsi:noNamespaceSchemaLocation` off the root into `XmlDocModel.schema_hints`
  (relative locations resolve against `source_url`, set only for URL loads).
  `POST /api/xsd/auto` (`{xml_id}`) then runs `parser/schema_fetch.fetch_schema_set`,
  which walks the schema's own `schemaLocation` references over the network,
  rewrites them to local paths (`build_xmlschema` compiles with `no_network=True`,
  so an absolute URL would silently not resolve) and hands the set to the shared
  `ingest_xsd(source="auto", …)`. Only the entry point must be reachable —
  a dependency that 404s is skipped so `BUNDLED_SCHEMAS` can cover it (the live
  FundsXML case). The frontend funnels every XML entry point through `applyXml`
  in `App.tsx`; `appStore.xsdSource` (`"auto" | "manual"`) makes sure a schema
  the user picked is never overwritten.
- **Responsive tiers.** Phone `< md` (768): one pane at a time, switched by
  the bottom `MobileNav` (Tree / Diagram / Validation). `App.tsx` keeps
  `viewMode` (store) plus a local `validationOpen` flag that is the phone's
  Validation pane and the tablet's drawer. Tablet `md`–`lg`: tab strip +
  view, Validation as a right slide-over opened by "Show validation".
  Desktop `≥ lg`: the two-column grid. `lib/useMediaQuery.ts`
  (`MD_QUERY`/`LG_QUERY`) must stay in sync with the Tailwind screens;
  the custom `touch:` (coarse pointer) and `short:` (max-height 500px)
  screens live in `tailwind.config.ts`. On phones the Files section
  collapses after a successful XML (`applyXml`) or manual XSD (`applyXsd`)
  load. Header actions beyond Search fold into `HeaderActions`' "More"
  menu below `lg`; the diagram toolbar goes icon-only below `md`
  (`DiagramView/DiagramToolbar.tsx`, first fit via `fitOptions.ts`).
- **Usage statistics** (`docs/USAGE_STATS.md`): off unless `USAGE_DB_URL` is
  set. Routers call `emit("xml_load"|"xsd_load"|"validate"|"export", …)`,
  `spa_fallback` (`mount_spa()`) emits `page_view` only for routes in `SPA_ROUTES`
  (`/`, `/fundsxml`) — every other unknown path is a 404 without event, so add new
  client-side routes there; rows land in `usage_event`
  (`backend/sql/usage_stats.sql`, same columns as the XSD viewer). Rejections
  go through `_common.reject()` so nothing is emitted twice.
- `POST /api/feedback` stores to Postgres when `USAGE_DB_URL` (or the override
  `FEEDBACK_DB_URL`, +`_PASSWORD`) is set (table: `backend/sql/feedback.sql`,
  store `backend/app/usage/feedback.py`); otherwise it logs the feedback at
  WARNING level. Prod uses DB `xmlviewer_stats` on the Hetzner host; read it
  with `python3 tools/feedback_report.py [--days N] [--full]`. See `docs/FEEDBACK.md`.
- Cloud Run request stats (Monitoring metric + request-log classification
  page/static/api/scanner with scanner share per day, top scanner paths/IPs, crawlers):
  `python3 tools/usage_report.py [--days N] [--no-logs]` (needs gcloud auth).

## Local dev / test

```bash
cd backend && pip install -e ".[dev]" && uvicorn app.main:app --reload --port 8080
cd frontend && npm install && npm run dev          # proxies /api -> 8080
cd backend && pytest && ruff check .
cd frontend && npm run build && npm run lint
docker compose up --build                          # full image at http://127.0.0.1:8093
```

E2E (Playwright, phone + tablet emulation in Chromium): build the frontend
first, then `cd e2e && npm install && npx playwright install chromium &&
npx playwright test`. The config boots the backend with
`STATIC_DIR=../frontend/dist`; set `E2E_PORT=8097` if 8080 is taken, or
`E2E_EXTERNAL=1 E2E_BASE_URL=http://127.0.0.1:8093` against the compose
image. `e2e/` also holds the bare `playwright` used by `scripts/record_demo.mjs`.

## Deployment — Google Cloud Run

- **Public site:** **https://www.xml-viewer.online/** (apex
  <https://xml-viewer.online/> also mapped), Cloud Run service
  `xml-online-viewer` in project **`xml-viewer-online`**, region
  `europe-west1`. Managed TLS via Cloud Run domain mappings.
- The repo also publishes an image to GHCR via CI
  (`ghcr.io/karlkauc/xml-online-viewer`), and a local Docker instance is
  reverse-proxied at `xml-viewer.status20.net` (legacy/parallel).

**Always pass `--project xml-viewer-online` explicitly** — the active gcloud
config may default to another project (e.g. `findatex-validator`), in which case
omitting the flag deploys to the wrong project.

```bash
# Build + deploy from source (hardened settings, complete env-var list)
scripts/deploy.sh                 # downloads GeoLite2 into backend/geoip/, then gcloud run deploy
SKIP_GEOIP=1 scripts/deploy.sh    # deploy without refreshing the GeoIP DB
```

`scripts/deploy.sh` is the single source of truth for the `gcloud run deploy`
flags. `--set-env-vars` **replaces** every plain env var, so any new variable
must be added there. Current set: `LOG_LEVEL, MAX_UPLOAD_MB, MAX_ZIP_ENTRIES,
MAX_ZIP_UNCOMPRESSED_MB, MAX_XML_NODES, CACHE_TTL_MIN, CACHE_MAX_ENTRIES,
FETCH_MAX_RESPONSE_MB, USAGE_DB_URL` (replaces the former `FEEDBACK_DB_URL`;
feedback falls back to the usage DSN). Secrets (`--update-secrets`):
`USAGE_DB_PASSWORD=xmlviewer-feedback-db-password`,
`USAGE_HASH_SECRET=xmlviewer-usage-hash-secret`,
`MAXMIND_LICENSE_KEY=xmlviewer-maxmind-license-key`. The `.gcloudignore`
whitelists `backend/geoip/*.mmdb` so the downloaded database reaches Cloud
Build. Before the first deploy with usage tracking: apply
`backend/sql/usage_stats.sql` on the VPS and create the two new secrets
(`docs/USAGE_STATS.md`, "One-time setup").

Domain mappings (already created; DNS lives at the registrar):

```bash
gcloud beta run domain-mappings create --service xml-online-viewer \
  --domain www.xml-viewer.online --region europe-west1 --project xml-viewer-online
# apex xml-viewer.online mapped likewise (A/AAAA records)
```

Billing account: `xsd-viewer` (shared with the sibling project). Project number
`239650873304`. See `docs/DEPLOY_CLOUD_RUN.md` for sizing, Cloud Armor rate
limiting, VPC egress (SSRF backstop) and image scanning.

## Conventions

- All user-facing output is English; the Excel report carries app metadata in
  its document properties only.
- Security model (XXE/SSRF/XML-bomb/ZIP-bomb, security headers/HSTS, node and
  size caps) lives in `backend/app/parser/security.py` + `main.py`; extend, don't
  bypass. URL loaders intentionally accept arbitrary public URLs (SSRF guarded by
  private-IP block + DNS-pinning).
