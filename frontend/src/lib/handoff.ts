/**
 * Receive an XML file handed over from the sibling XSD viewer.
 *
 * Flow: xsd-viewer.online opens `https://www.xml-viewer.online/?from=xsd-viewer`
 * in a new tab while keeping the File in memory. Once mounted we post
 * `{type: "xml-viewer:ready"}` to the opener; it answers with
 * `{type: "xml-viewer:file", name, content}` (content is a transferred
 * ArrayBuffer). Origins are checked strictly on both sides; without the
 * `from` parameter nothing here runs.
 */

export const HANDOFF_SOURCE = "xsd-viewer";

// Keep in step with HANDOFF_SENDER_ORIGINS in the XSD viewer (lib/xmlViewerHandoff.ts).
const SENDER_ORIGINS = [
  "https://www.xsd-viewer.online",
  "https://xsd-viewer.online",
  "https://viewer.status20.net",
];

export interface HandoffFileMessage {
  type: "xml-viewer:file";
  name: string;
  content: ArrayBuffer;
}

function isAllowedOrigin(origin: string): boolean {
  if (SENDER_ORIGINS.includes(origin)) return true;
  // Local development: both apps run on localhost dev servers.
  return import.meta.env.DEV && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function isHandoffLanding(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get("from") === HANDOFF_SOURCE;
}

function isFileMessage(data: unknown): data is HandoffFileMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "xml-viewer:file" && typeof d.name === "string" && d.content instanceof ArrayBuffer;
}

/**
 * Announce readiness to the opener and resolve the handed-over File.
 * Returns a cleanup function; `onFile` is called at most once.
 */
export function receiveHandoff(onFile: (file: File) => void): () => void {
  const opener = window.opener as Window | null;
  if (!opener) return () => {};

  let done = false;
  const onMessage = (event: MessageEvent) => {
    if (done || event.source !== opener || !isAllowedOrigin(event.origin)) return;
    if (!isFileMessage(event.data)) return;
    done = true;
    window.removeEventListener("message", onMessage);
    const type = event.data.name.toLowerCase().endsWith(".xml") ? "application/xml" : "";
    onFile(new File([event.data.content], event.data.name, { type }));
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
