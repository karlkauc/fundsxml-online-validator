import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ApiError } from "../api/client";
import { FundsXmlReleases } from "./FundsXmlReleases";
import { XSD_VIEWER_URL } from "../lib/links";

type Mode = "file" | "text" | "url" | "releases";

const MODE_LABEL: Record<Mode, string> = {
  file: "File",
  text: "Paste",
  url: "URL",
  releases: "FundsXML Releases",
};

/** Matches the opening tag of an XML Schema document (any prefix), close
 * enough to the XMLSchema namespace declaration to avoid false positives on
 * an instance document that merely has a <schema> element. */
const SCHEMA_ROOT_RE = /<(?:[\w.-]+:)?schema[\s>][\s\S]{0,400}XMLSchema/;

/** True when the input is an XML Schema rather than an instance document.
 * Used only by the XML panel, to explain the mix-up instead of failing with a
 * validation error further down. */
function looksLikeSchema(filename?: string, text?: string): boolean {
  if (filename && /\.xsd(\?|#|$)/i.test(filename)) return true;
  return !!text && SCHEMA_ROOT_RE.test(text.slice(0, 1024));
}

interface SourceLoaderProps {
  title: string;
  accept: string;
  placeholder: string;
  status: string | null;
  onFile: (file: File, mainFilename?: string) => Promise<void>;
  onText: (content: string) => Promise<void>;
  onUrl: (url: string) => Promise<void>;
  // When set, a ZIP may contain several schemas; an optional input lets the
  // user name the main file if it cannot be auto-detected.
  showMainFilename?: boolean;
  // When set, a "Releases" tab lets the user load a schema from a published
  // FundsXML GitHub release.
  onRelease?: (tagName: string, filename: string) => Promise<void>;
  // Tab to open on first render (defaults to "file").
  defaultMode?: Mode;
  // Greys the panel out; the loaders stay visible so the feature is
  // discoverable, but cannot be used yet.
  disabled?: boolean;
  disabledHint?: string;
  // One-click example document, offered under the drop zone.
  onSample?: () => Promise<void>;
  sampleLabel?: string;
  // Reject XML Schema input with an explanation instead of uploading it.
  rejectSchemaInput?: boolean;
  // Rendered after the "✓ <status>" line (e.g. how the schema was found).
  statusNote?: ReactNode;
  // When set, an ✕ button next to the status line unloads the current input.
  onClear?: () => void;
}

/** A single load surface (file / paste / URL) for either XML or XSD input. */
function SourceLoader({
  title,
  accept,
  placeholder,
  status,
  onFile,
  onText,
  onUrl,
  showMainFilename,
  onRelease,
  defaultMode = "file",
  disabled,
  disabledHint,
  onSample,
  sampleLabel,
  rejectSchemaInput,
  statusNote,
  onClear,
}: SourceLoaderProps) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemaMixUp, setSchemaMixUp] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [mainFilename, setMainFilename] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // A document may also be loaded from outside this panel (the empty-state
  // example button, the xsd-viewer handoff). Drop a stale mix-up warning once
  // something did load, so it cannot outlive the input it was about.
  useEffect(() => {
    if (status) setSchemaMixUp(false);
  }, [status]);

  const main = () => mainFilename.trim() || undefined;

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setSchemaMixUp(false);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Run `fn`, unless the input is an XML Schema and this panel wants XML. */
  const guarded = useCallback(
    (fn: () => Promise<void>, filename?: string, content?: string) => {
      if (rejectSchemaInput && looksLikeSchema(filename, content)) {
        setError(null);
        setSchemaMixUp(true);
        return;
      }
      void run(fn);
    },
    [rejectSchemaInput, run],
  );

  return (
    <div
      className={clsx("panel rounded-lg p-3 flex-1 min-w-0", disabled && "opacity-60")}
      aria-disabled={disabled || undefined}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex gap-1" role="tablist">
          {(["file", "text", "url", ...(onRelease ? ["releases"] : [])] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              disabled={disabled}
              className={clsx(
                "px-2 py-0.5 text-xs font-medium rounded disabled:cursor-not-allowed",
                mode === m
                  ? "bg-accent text-white dark:bg-accent-dark dark:text-slate-950"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
              )}
              onClick={() => setMode(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <div className={clsx(disabled && "pointer-events-none select-none")}>
        {mode === "file" && (
          <div
            className={clsx(
              "rounded border border-dashed border-slate-300 dark:border-slate-700 p-4 text-center text-sm transition-colors",
              dragOver && "border-accent bg-blue-50/60 dark:bg-blue-950/20",
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) guarded(() => onFile(f, main()), f.name);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) guarded(() => onFile(f, main()), f.name);
              }}
            />
            <p className="mb-2 text-slate-600 dark:text-slate-400">
              Drop a file here or choose one
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || disabled}
              onClick={() => fileInput.current?.click()}
            >
              Choose file…
            </button>
            {onSample && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                or{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-accent disabled:no-underline"
                  disabled={busy || disabled}
                  onClick={() => void run(onSample)}
                >
                  {sampleLabel ?? "load an example"}
                </button>
              </p>
            )}
            {showMainFilename && (
              <label className="block mt-3 text-[11px] text-slate-500 dark:text-slate-400">
                ZIP with multiple XSDs? The main schema is auto-detected — or
                specify it here:
                <input
                  type="text"
                  placeholder="e.g. FundsXML4.xsd"
                  className="mt-1 w-full font-mono text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  value={mainFilename}
                  onChange={(e) => setMainFilename(e.target.value)}
                />
              </label>
            )}
          </div>
        )}

        {mode === "text" && (
          <div>
            <textarea
              className="w-full h-28 font-mono text-xs p-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary mt-2"
              disabled={busy || disabled || !text.trim()}
              onClick={() => guarded(() => onText(text), undefined, text)}
            >
              Load
            </button>
          </div>
        )}

        {mode === "url" && (
          <div>
            <input
              type="url"
              placeholder="https://…"
              className="w-full font-mono text-xs px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary mt-2"
              disabled={busy || disabled || !url.trim()}
              onClick={() => guarded(() => onUrl(url.trim()), url.trim())}
            >
              Load
            </button>
          </div>
        )}

        {mode === "releases" && onRelease && (
          <FundsXmlReleases
            busy={busy}
            onSelect={(tag, filename) => void run(() => onRelease(tag, filename))}
          />
        )}
      </div>

      {disabled && disabledHint && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{disabledHint}</p>
      )}
      {!disabled && busy && <p className="mt-2 text-xs text-slate-500">Loading…</p>}
      {!disabled && schemaMixUp && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="alert">
          That&rsquo;s an XML Schema, not an XML document. Load it under{" "}
          <strong>XSD schema</strong> to validate a document against it — or open it in the{" "}
          <a
            className="underline underline-offset-2"
            href={XSD_VIEWER_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            XSD Viewer ↗
          </a>{" "}
          to visualise the schema itself.
        </p>
      )}
      {!disabled && error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {!disabled && !error && !schemaMixUp && !busy && status && (
        <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 flex-wrap">
          <span>✓ {status}</span>
          {statusNote}
          {onClear && (
            <button
              type="button"
              className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
              onClick={onClear}
              title="Unload"
              aria-label={`Unload ${status}`}
            >
              ✕
            </button>
          )}
        </p>
      )}
    </div>
  );
}

interface UploaderProps {
  xmlStatus: string | null;
  xsdStatus: string | null;
  onXmlFile: (f: File) => Promise<void>;
  onXmlText: (c: string) => Promise<void>;
  onXmlUrl: (u: string) => Promise<void>;
  onXmlSample: () => Promise<void>;
  onXsdFile: (f: File, mainFilename?: string) => Promise<void>;
  onXsdText: (c: string) => Promise<void>;
  onXsdUrl: (u: string) => Promise<void>;
  onXsdRelease: (tagName: string, filename: string) => Promise<void>;
  onXsdClear: () => void;
  // Initial tab for the XSD loader (e.g. "releases" on the /fundsxml route).
  defaultXsdMode?: Mode;
  // The schema is only meaningful for a loaded document, so the XSD loader
  // stays inert until there is one.
  xsdDisabled?: boolean;
  xsdStatusNote?: ReactNode;
}

export function Uploader(props: UploaderProps) {
  return (
    <div className="flex flex-col md:flex-row gap-3">
      <SourceLoader
        title="XML data"
        accept=".xml,application/xml,text/xml"
        placeholder="<FundsXML4>…"
        status={props.xmlStatus}
        onFile={props.onXmlFile}
        onText={props.onXmlText}
        onUrl={props.onXmlUrl}
        onSample={props.onXmlSample}
        sampleLabel="load a FundsXML example"
        rejectSchemaInput
      />
      <SourceLoader
        title="XSD schema"
        accept=".xsd,.zip,application/zip,application/xml"
        placeholder="<xs:schema>…"
        status={props.xsdStatus}
        onFile={props.onXsdFile}
        onText={props.onXsdText}
        onUrl={props.onXsdUrl}
        onRelease={props.onXsdRelease}
        onClear={props.xsdStatus ? props.onXsdClear : undefined}
        defaultMode={props.defaultXsdMode}
        disabled={props.xsdDisabled}
        disabledHint="Load an XML file first — a schema is only used to validate it."
        statusNote={props.xsdStatusNote}
        showMainFilename
      />
    </div>
  );
}
