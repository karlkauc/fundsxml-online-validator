import { useCallback, useEffect, useRef, useState } from "react";
import {
  uploadXmlFile,
  uploadXmlText,
  uploadXmlUrl,
  uploadXsdFile,
  uploadXsdText,
  uploadXsdUrl,
  loadXsdFromRelease,
  listFundsXmlReleases,
  type FundsXmlRelease,
} from "./api/client";
import { useApp } from "./stores/appStore";
import { isHandoffLanding, receiveHandoff } from "./lib/handoff";
import clsx from "clsx";
import { Uploader } from "./components/Uploader";
import { XmlTreeView } from "./components/XmlTreeView/XmlTreeView";
import { DiagramView } from "./components/DiagramView/DiagramView";
import { ValidationPanel } from "./components/ValidationPanel";
import { ThemeToggle } from "./components/ThemeToggle";

// Stable landing route fundsxml.org can link to: opens the XSD loader on the
// FundsXML Releases tab and auto-loads the newest release's schema.
const isFundsXmlRoute = window.location.pathname.replace(/\/+$/, "") === "/fundsxml";
// Opened from xsd-viewer.online with an XML file to hand over (see lib/handoff).
const isHandoff = isHandoffLanding();

/** Pick a release's main schema: the FundsXML* file, else the largest asset. */
function pickMainAsset(release: FundsXmlRelease) {
  return (
    release.assets.find((a) => /^fundsxml/i.test(a.filename)) ??
    release.assets.reduce((best, a) => (a.size > best.size ? a : best), release.assets[0])
  );
}

export default function App() {
  const xmlDoc = useApp((s) => s.xmlDoc);
  const xsdInfo = useApp((s) => s.xsdInfo);
  const setXml = useApp((s) => s.setXml);
  const setXsd = useApp((s) => s.setXsd);
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  const [filesOpen, setFilesOpen] = useState(true);
  const [handoff, setHandoff] = useState<{ status: "waiting" | "loading" | "error"; detail?: string } | null>(
    isHandoff ? { status: "waiting" } : null,
  );

  const onXmlFile = useCallback(async (f: File) => setXml(await uploadXmlFile(f)), [setXml]);
  const onXmlText = useCallback(async (c: string) => setXml(await uploadXmlText(c)), [setXml]);
  const onXmlUrl = useCallback(async (u: string) => setXml(await uploadXmlUrl(u)), [setXml]);
  const onXsdFile = useCallback(
    async (f: File, mainFilename?: string) => setXsd(await uploadXsdFile(f, mainFilename)),
    [setXsd],
  );
  const onXsdText = useCallback(async (c: string) => setXsd(await uploadXsdText(c)), [setXsd]);
  const onXsdUrl = useCallback(async (u: string) => setXsd(await uploadXsdUrl(u)), [setXsd]);
  const onXsdRelease = useCallback(
    async (tag: string, filename: string) => setXsd(await loadXsdFromRelease(tag, filename)),
    [setXsd],
  );

  // On /fundsxml, auto-load the newest (stable) release's schema once. On
  // failure the Releases tab is already open, so the user can pick manually.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!isFundsXmlRoute || autoLoaded.current || xsdInfo) return;
    autoLoaded.current = true;
    void (async () => {
      try {
        const { releases } = await listFundsXmlReleases();
        const release = releases.find((r) => !r.prerelease) ?? releases[0];
        if (!release || release.assets.length === 0) return;
        const main = pickMainAsset(release);
        setXsd(await loadXsdFromRelease(release.tag_name, main.filename));
      } catch (err) {
        console.error("Failed to auto-load latest FundsXML release", err);
      }
    })();
  }, [xsdInfo, setXsd]);

  // Landing from the XSD viewer: announce readiness, then load the posted
  // file as if the user had uploaded it here. Falls back to manual upload if
  // the opener never answers (popup blocker, old deploy).
  useEffect(() => {
    if (!isHandoff) return;
    const cleanup = receiveHandoff((file) => {
      setHandoff({ status: "loading", detail: file.name });
      void uploadXmlFile(file)
        .then((doc) => {
          setXml(doc);
          setHandoff(null);
          window.history.replaceState(null, "", window.location.pathname);
        })
        .catch((err) => setHandoff({ status: "error", detail: err instanceof Error ? err.message : String(err) }));
    });
    const timer = window.setTimeout(() => setHandoff((h) => (h?.status === "waiting" ? null : h)), 10_000);
    return () => {
      cleanup();
      window.clearTimeout(timer);
    };
  }, [setXml]);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 dark:border-slate-800">
        <h1 className="text-base font-semibold">XML Online Viewer</h1>
        <p className="text-xs text-slate-500 hidden sm:block">
          View XML data · validate against XSD · export errors to Excel
        </p>
        <div className="ml-auto flex items-center gap-3">
          <a
            href="https://fundsxml.org"
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-accent hover:underline"
          >
            fundsxml.org
          </a>
          <ThemeToggle />
        </div>
      </header>

      <div className="border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setFilesOpen((o) => !o)}
          aria-expanded={filesOpen}
          className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-900"
        >
          <span className="text-slate-500 text-xs w-3">{filesOpen ? "▾" : "▸"}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Files
          </span>
          {!filesOpen && (
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
              XML: {xmlDoc ? xmlDoc.filename : "—"} · XSD:{" "}
              {xsdInfo ? xsdInfo.main_filename : "—"}
            </span>
          )}
        </button>
        {handoff && (
          <p
            role="status"
            className={clsx(
              "mx-4 mt-2 rounded px-3 py-1.5 text-xs",
              handoff.status === "error"
                ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
                : "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
            )}
          >
            {handoff.status === "waiting" && "Receiving file from XSD Viewer…"}
            {handoff.status === "loading" && `Loading ${handoff.detail}…`}
            {handoff.status === "error" && `Could not load the file from XSD Viewer: ${handoff.detail}`}
          </p>
        )}
        {filesOpen && (
          <div className="px-4 pb-4">
            <Uploader
              xmlStatus={xmlDoc ? `${xmlDoc.filename} (${xmlDoc.node_count} nodes)` : null}
              xsdStatus={xsdInfo ? xsdInfo.main_filename : null}
              onXmlFile={onXmlFile}
              onXmlText={onXmlText}
              onXmlUrl={onXmlUrl}
              onXsdFile={onXsdFile}
              onXsdText={onXsdText}
              onXsdUrl={onXsdUrl}
              onXsdRelease={onXsdRelease}
              defaultXsdMode={isFundsXmlRoute ? "releases" : "file"}
            />
          </div>
        )}
      </div>

      <main className="flex-1 min-h-0">
        {!xmlDoc ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            Load XML data to see the view.
          </div>
        ) : (
          <div className="h-full grid grid-cols-1 lg:grid-cols-[1fr_28rem] divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
            <div className="min-h-0 h-full flex flex-col">
              <div className="flex gap-1 px-3 py-2 border-b border-slate-200 dark:border-slate-800" role="tablist">
                {(["tree", "diagram"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={viewMode === m}
                    className={clsx(
                      "px-3 py-1 text-sm font-medium rounded-md",
                      viewMode === m
                        ? "bg-accent text-white dark:bg-accent-dark dark:text-slate-950"
                        : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700",
                    )}
                    onClick={() => setViewMode(m)}
                  >
                    {m === "tree" ? "Tree" : "Diagram"}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0">
                {viewMode === "tree" ? <XmlTreeView /> : <DiagramView />}
              </div>
            </div>
            <div className="min-h-0 h-full">
              <ValidationPanel />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
