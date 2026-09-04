/**
 * Receive an XML file handed over from the sibling XSD viewer.
 *
 * Flow: xsd-viewer.online opens `https://www.xml-viewer.online/?from=xsd-viewer`
 * in a new tab while keeping the File in memory. Once mounted we post
 * `{type: "xml-viewer:ready"}` to the opener; it answers with
 * `{type: "xml-viewer:file", name, content}` (content is a transferred
 * ArrayBuffer), optionally with `schema: {name, content, mainFilename}` — the
 * schema loaded over there as a single .xsd or a ZIP of all its files — so
 * the document can be validated right away. Origins are checked strictly on
 * both sides; without the `from` parameter nothing here runs.
 */

export const HANDOFF_SOURCE = "xsd-viewer";

// Keep in step with HANDOFF_SENDER_ORIGINS in the XSD viewer (lib/xmlViewerHandoff.ts).
const SENDER_ORIGINS = [
  "https://www.xsd-viewer.online",
  "https://xsd-viewer.online",
  "https://viewer.status20.net",
];

export interface HandoffSchema {
  name: string;
  content: ArrayBuffer;
  /** Root schema inside a ZIP; absent for a single .xsd. */
  mainFilename?: string;
}

export interface HandoffFileMessage {
  type: "xml-viewer:file";
  name: string;
  content: ArrayBuffer;
  schema?: HandoffSchema;
}

/** The schema part of a hand-off, as a File plus the ZIP's main entry. */
export interface HandoffSchemaFile {
  file: File;
  mainFilename?: string;
}

function isAllowedOrigin(origin: string): boolean {
  if (SENDER_ORIGINS.includes(origin)) return true;
  // Local development: both apps run on localhost dev servers.
  return import.meta.env.DEV && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function isHandoffLanding(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get("from") === HANDOFF_SOURCE;
}

function isSchema(data: unknown): data is HandoffSchema {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.name === "string" &&
    d.content instanceof ArrayBuffer &&
    (d.mainFilename === undefined || typeof d.mainFilename === "string")
  );
}

function isFileMessage(data: unknown): data is HandoffFileMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "xml-viewer:file" &&
    typeof d.name === "string" &&
    d.content instanceof ArrayBuffer &&
    (d.schema === undefined || isSchema(d.schema))
  );
}

function schemaFile(schema: HandoffSchema): HandoffSchemaFile {
  const lower = schema.name.toLowerCase();
  const type = lower.endsWith(".zip") ? "application/zip" : lower.endsWith(".xsd") ? "application/xml" : "";
  return { file: new File([schema.content], schema.name, { type }), mainFilename: schema.mainFilename };
}

/**
 * Announce readiness to the opener and resolve the handed-over File (plus
 * the schema, when one came along). Returns a cleanup function; `onFile` is
 * called at most once.
 */
export function receiveHandoff(onFile: (file: File, schema?: HandoffSchemaFile) => void): () => void {
  const opener = window.opener as Window | null;
  if (!opener) return () => {};

  let done = false;
  const onMessage = (event: MessageEvent) => {
    if (done || event.source !== opener || !isAllowedOrigin(event.origin)) return;
    if (!isFileMessage(event.data)) return;
    done = true;
    window.removeEventListener("message", onMessage);
    const type = event.data.name.toLowerCase().endsWith(".xml") ? "application/xml" : "";
    const schema = event.data.schema ? schemaFile(event.data.schema) : undefined;
    onFile(new File([event.data.content], event.data.name, { type }), schema);
  };
  window.addEventListener("message", onMessage);

  // targetOrigin must be a single value; posting to a non-matching origin is
  // silently dropped, so announce to every sender we accept.
  const targets = import.meta.env.DEV ? [...SENDER_ORIGINS, "*"] : SENDER_ORIGINS;
  for (const origin of targets) {
    try {
      opener.postMessage({ type: "xml-viewer:ready" }, origin);
    } catch {
      /* opener closed or cross-origin severed — nothing to do */
    }
  }
  return () => window.removeEventListener("message", onMessage);
}
