# Technical reference

Operator- and developer-facing notes for self-hosting, configuring, securing
and developing the XML Online Viewer. For a feature tour, see the
[README](../README.md). For deployment to Google Cloud Run specifically, see
[DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md).

The app is a single container: a multi-stage image builds the React/Vite
frontend (Node) and serves the static SPA together with the FastAPI + lxml
backend from one Python runtime.

## Self-hosting

Run the published image:

```bash
docker run --rm -p 8080:8080 ghcr.io/karlkauc/xml-online-viewer:latest
```

Open <http://localhost:8080> and drop an XML file into the browser.

### docker-compose

```bash
docker compose up --build
```

The bundled `docker-compose.yml` builds `xml-online-viewer:latest` and binds it
to `127.0.0.1:8093` — intended as a local sandbox, not for public exposure.

### Google Cloud Run

A step-by-step guide for deploying this container to Cloud Run (build, sizing,
env vars, Cloud Armor rate limiting, VPC egress and image scanning) lives in
[DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md).

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Server port |
| `MAX_UPLOAD_MB` | `50` | Maximum upload size |
| `MAX_ZIP_ENTRIES` | `2000` | Maximum entries in an uploaded XSD ZIP |
| `MAX_ZIP_UNCOMPRESSED_MB` | `200` | Maximum uncompressed size of an XSD ZIP (ZIP-bomb guard) |
| `MAX_XML_NODES` | `500000` | Maximum number of nodes in a parsed XML document |
| `ALLOWED_SCHEMA_HOSTS` | *(empty)* | Empty = any public http(s) host allowed (private/loopback stay blocked). Set to a regex, or comma-separated list of regexes, to lock URL fetching to a whitelist. |
| `FETCH_MAX_RESPONSE_MB` | `10` | Maximum size of a URL-fetched XML/XSD response |
| `CACHE_TTL_MIN` | `60` | In-memory parse-cache lifetime (minutes) |
| `CACHE_MAX_ENTRIES` | `64` | Cache size per type (XML / XSD / validation) |
| `CORS_ALLOW_ORIGINS` | *(empty)* | Only set if a foreign frontend calls the API |
| `LOG_LEVEL` | `INFO` | Log level |

## Security model

XXE, SSRF, XML-bomb and ZIP-bomb protection, the security headers / HSTS, and
the node- and size-caps live in `backend/app/parser/security.py` and
`backend/app/main.py`. **Extend these, don't bypass them.** The URL loaders
intentionally accept arbitrary public URLs; SSRF is guarded by a private-IP
block plus DNS-pinning. See [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md) for the
infrastructure-level backstops (Cloud Armor, VPC egress).

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/xml/{upload,text,url}` | Load XML data → tree model |
| GET | `/api/xml/{xml_id}` | Cached XML model |
| POST | `/api/xsd/{upload,text,url}` | Load XSD schema (file / ZIP) |
| POST | `/api/xsd/auto` | `{xml_id}` → load the schema the document names via `xsi:schemaLocation` |
| GET | `/api/fundsxml/releases` | List FundsXML GitHub releases |
| POST | `/api/fundsxml/releases/{tag}/load` | Load a schema from a release |
| POST | `/api/validate` | `{xml_id, xsd_id}` → validation result |
| GET | `/api/validate/{validation_id}/excel` | Download Excel report |
| GET | `/api/health` | Liveness |

## Local development

Backend (FastAPI, port 8080):

```bash
cd backend
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8080
```

Frontend (Vite dev server, port 5173, proxies `/api` → 8080):

```bash
cd frontend
npm install
npm run dev
```

## Tests & linting

```bash
cd backend && pytest          # API, parser and validation tests
cd backend && ruff check .
cd frontend && npm run build  # tsc + vite build
cd frontend && npm run lint
```

## Recording the README demo GIF

The README's animated demo is produced by `scripts/record_demo.mjs`, which
drives the local sandbox via Playwright and writes a WebM recording to
`docs/media/_raw/`. The walkthrough uses the sample pair in `samples/`
(`library.xml` is intentionally invalid against `library.xsd` so the error
highlighting is shown). Convert the recording to GIF with ffmpeg:

```bash
# Bring the sandbox up
docker compose up -d --build

# Install Playwright once (browsers are downloaded on first run)
cd e2e && npm install && npx playwright install chromium && cd ..

# Record the walkthrough
node scripts/record_demo.mjs

# Convert (run from docs/media/_raw)
cd docs/media/_raw
ffmpeg -y -i *.webm -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" overview.palette.png
ffmpeg -y -i *.webm -i overview.palette.png \
  -lavfi "fps=12,scale=960:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle" \
  ../overview.gif
rm overview.palette.png
```
