# CLAUDE.md — XML Online Viewer

XML data viewer + XSD validator. FastAPI + lxml backend, React/TS/Vite/Tailwind
frontend, served as one container. Sibling of the **XSD Online Viewer**
(<https://www.xsd-viewer.online>); shares its architecture and hardening.

## Layout

- `backend/app/` — FastAPI app. `parser/` (security, xml_tree, xsd_store,
  validate), `api/` (xml, xsd, validate, releases), `report/excel.py`,
  `cache.py`, `config.py`, `main.py`.
- `frontend/src/` — SPA: `components/` (Uploader, XmlTreeView, DiagramView,
  ValidationPanel, FundsXmlReleases), `stores/appStore.ts`, `api/client.ts`.
- `docs/DEPLOY_CLOUD_RUN.md` — hardening/deploy reference.
- Header/dialogs (Search, Feedback, XSD Viewer link, GitHub, About, theme)
  mirror the XSD viewer; shared links/events live in `frontend/src/lib/links.ts`.
- `POST /api/feedback` stores to Postgres when `FEEDBACK_DB_URL`
  (+`FEEDBACK_DB_PASSWORD`) is set (table: `backend/sql/feedback.sql`);
  otherwise it logs the feedback at WARNING level (visible in Cloud Run logs).

## Local dev / test

```bash
cd backend && pip install -e ".[dev]" && uvicorn app.main:app --reload --port 8080
cd frontend && npm install && npm run dev          # proxies /api -> 8080
cd backend && pytest && ruff check .
cd frontend && npm run build && npm run lint
docker compose up --build                          # full image at http://127.0.0.1:8092
```

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
# Build + deploy from source (hardened settings)
gcloud run deploy xml-online-viewer --source . \
  --project xml-viewer-online --region europe-west1 \
  --allow-unauthenticated --ingress all \
  --memory 1Gi --cpu 1 --concurrency 20 --max-instances 5 --timeout 120 \
  --set-env-vars LOG_LEVEL=INFO,MAX_UPLOAD_MB=50,MAX_ZIP_ENTRIES=2000,MAX_ZIP_UNCOMPRESSED_MB=200,MAX_XML_NODES=500000,CACHE_TTL_MIN=60,CACHE_MAX_ENTRIES=64,FETCH_MAX_RESPONSE_MB=10
```

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
