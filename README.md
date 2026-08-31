# XML Online Viewer

**Read your XML, validate it against any XSD, and export the errors to Excel —
right in your browser. No install, no account, nothing stored.**

Open <https://www.xml-viewer.online> and drop in an `.xml` file. You get a
collapsible tree and an interactive diagram of your data side by side with a
validation panel. If the document names its schema, that schema is fetched and
applied automatically; otherwise add an `.xsd` yourself. Either way the document
is checked instantly — every error is pinned to the exact node that caused it.

> Looking to **visualise a schema** rather than a document? That is the sister
> tool, the [XSD Online Viewer](https://www.xsd-viewer.online). Here an `.xsd`
> is only ever used to validate a loaded XML document.

![Load XML, explore the tree and diagram, validate against an XSD, export errors to Excel](docs/media/overview.gif)

## What you can do with it

- **See your data two ways.** A collapsible **tree** of elements, attributes,
  values and comments, and a graphical **diagram** (horizontal node graph with
  expand/collapse, pan & zoom and a minimap). Switch between them at any time.
- **The schema finds itself.** When the document carries an
  `xsi:schemaLocation` / `xsi:noNamespaceSchemaLocation`, that schema (plus
  everything it imports) is downloaded and applied for you, and validation runs
  right away. You can replace or remove it at any time — a schema you pick by
  hand is never overwritten.
- **Validate against any XSD.** Drop a schema and the document is checked
  automatically — no button to hunt for. A green *Valid* badge or a count of
  the errors appears immediately.
- **Find every error, exactly.** Each error is highlighted on the offending
  node in **red**; any parent whose subtree hides an error is flagged **amber**
  (`⤵ N`), so you can open just the branches that matter. Click an error and
  the viewer reveals and centres that node for you.
- **Export the errors to Excel.** Download a `.xlsx` report of every validation
  error — each one shown with the line before, the highlighted error line, and
  the line after, so the report stands on its own.
- **Multi-file schemas.** Drop a single `.xsd`, or a `.zip` containing the main
  schema plus its `xs:import` / `xs:include` targets (e.g. FundsXML4 with
  xmldsig) — the viewer resolves the bundle into one schema. The main file is
  auto-detected, and the W3C `xmldsig-core-schema.xsd` is supplied for you when
  a schema references it but doesn't include it.
- **Search the tree.** Full-text search across tags, attributes and values to
  jump straight to what you're looking for in large documents.
- **Export the diagram.** Save the diagram as **PNG** or **SVG** for docs,
  tickets or slides.
- **Load from anywhere.** File upload, pasted text, or a public `http(s)` URL —
  for both the XML and the XSD (URL loading is SSRF-guarded).
- **Light & dark.** The UI follows your `prefers-color-scheme` and has a manual
  toggle.
- **Handles real-world files.** Virtualised tree rendering and lazy diagram
  layout keep large documents responsive.

## Validate against FundsXML releases

If you work with [FundsXML](https://fundsxml.org/), you don't need to track down
the right schema. Open the **XSD schema** panel, pick the **FundsXML Releases**
tab, and load any official release straight from the
[`fundsxml/schema`](https://github.com/fundsxml/schema/releases) GitHub repo —
including its `xmldsig-core-schema.xsd` companion — with one click. Then drop in
your FundsXML document and validate.

## Your data stays with you

- **Nothing is stored.** Files are parsed in memory and dropped from a
  short-lived cache. There is no database, no file persistence, and no analytics
  on your documents.
- **No account, no login.** Just open the site and drop a file.
- **You can run it yourself.** The whole app is a single Docker container — see
  [docs/TECHNICAL.md](docs/TECHNICAL.md) for self-hosting.

## No warranty

This tool is offered free of charge and **without any warranty**. Validation is
a best-effort check and the visualisation is a best-effort rendering of your
document; do **not** rely on it as the single source of truth for regulatory,
contractual or production decisions — always verify against the authoritative
schema and an established validator. Use is at your own risk.

## Found a bug? Missing a feature?

Please open an issue on GitHub — bug reports, reproduction steps and feature
requests are all welcome:

➡️ <https://github.com/karlkauc/xml-online-viewer/issues>

## Technical details, self-hosting & development

Configuration, security hardening, environment variables, the HTTP API, Cloud
Run deployment and the local dev-setup steps all live in
**[docs/TECHNICAL.md](docs/TECHNICAL.md)**.

This is a sibling project to the
[Online XSD Viewer](https://www.xsd-viewer.online); it shares that project's
architecture (FastAPI + lxml backend, React / TypeScript / Vite / Tailwind
frontend) and its security-critical code (XXE, SSRF and XML-bomb protection).

## Author

Built and maintained by **Karl Kauc** — [github.com/karlkauc](https://github.com/karlkauc).
