import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  autoLoadXsd,
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
import type { XmlDocModel, XsdInfo } from "./types/model";
import { useApp } from "./stores/appStore";
import { isHandoffLanding, receiveHandoff } from "./lib/handoff";
import clsx from "clsx";
import { Uploader } from "./components/Uploader";
import { XmlTreeView } from "./components/XmlTreeView/XmlTreeView";
import { DiagramView } from "./components/DiagramView/DiagramView";
import { ValidationPanel } from "./components/ValidationPanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { AboutDialog } from "./components/AboutDialog";
import { HeaderActions, type HeaderAction } from "./components/HeaderActions";
import { MobileNav, type MobilePane } from "./components/MobileNav";
import { LG_QUERY, MD_QUERY, matchesMediaQuery, useMediaQuery } from "./lib/useMediaQuery";
import { useDismiss } from "./lib/useDismiss";
import {
  FUNDSXML_SAMPLE_URL,
  GITHUB_REPO_URL,
  XSD_VIEWER_URL,
  openAbout,
  openFeedback,
  openSearch,
} from "./lib/links";

// Stable landing route fundsxml.org can link to: opens the XSD loader on the
// FundsXML Releases tab and auto-loads the newest release's schema.
const isFundsXmlRoute = window.location.pathname.replace(/\/+$/, "") === "/fundsxml";
// Opened from xsd-viewer.online with an XML file to hand over (see lib/handoff).
const isHandoff = isHandoffLanding();

/** Why auto-detection did not end with a loaded schema: either the document
 * points at a schema on the user's own disk ("local"), or the download failed. */
interface AutoSchemaNote {
  kind: "local" | "error";
  detail: string;
}

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
  const xsdSource = useApp((s) => s.xsdSource);
  const setXml = useApp((s) => s.setXml);
  const setXsd = useApp((s) => s.setXsd);
  const clearXsd = useApp((s) => s.clearXsd);
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  const validation = useApp((s) => s.validation);
  const [filesOpen, setFilesOpen] = useState(true);
  // Below `md` (phones): the Validation pane is showing instead of the
  // tree/diagram. Between `md` and `lg` (tablets): the validation drawer is
  // open. Ignored from `lg` up, where validation is a fixed column.
  const [validationOpen, setValidationOpen] = useState(false);
  const atLeastMd = useMediaQuery(MD_QUERY);
  const wide = useMediaQuery(LG_QUERY);
  const asideRef = useRef<HTMLElement | null>(null);
  const closeValidation = useCallback(() => setValidationOpen(false), []);
  // Escape / tap outside close the tablet drawer. Not on phones: there the
  // pointer-down on the bottom nav would race the nav's own click.
  useDismiss(asideRef, validationOpen && atLeastMd && !wide, closeValidation);
  const mobilePane: MobilePane = validationOpen ? "validation" : viewMode;
  const onMobilePane = useCallback(
    (pane: MobilePane) => {
      if (pane === "validation") {
        setValidationOpen(true);
        return;
      }
      setViewMode(pane);
      setValidationOpen(false);
    },
    [setViewMode],
  );
  const openTreeSearch = useCallback(() => {
    setViewMode("tree");
    setValidationOpen(false);
    // XmlTreeView owns the listener and may only mount in the next commit
    // (coming from the diagram or the phone's Validation pane).
    requestAnimationFrame(() => openSearch());
  }, [setViewMode]);
  // Outcome of auto-detecting the schema from the document, when it did not
  // simply succeed. Never blocks: the document is shown either way.
  const [autoSchema, setAutoSchema] = useState<AutoSchemaNote | null>(null);

  // Ctrl/Cmd-K focuses the tree search, same shortcut as the XSD viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [handoff, setHandoff] = useState<{ status: "waiting" | "loading" | "error"; detail?: string } | null>(
    isHandoff ? { status: "waiting" } : null,
  );

  // Every XML entry point (file, paste, URL, example, xsd-viewer handoff) goes
  // through here, so auto-detection of the schema behaves identically for all
  // of them and the validation panel picks it up on its own.
  const applyXml = useCallback(
    async (doc: XmlDocModel) => {
      setXml(doc);
      setAutoSchema(null);
      // A fresh document opens on the view, not the validation panel. On
      // phones the loaders would otherwise leave no room for it; read the
      // width imperatively so a later rotation does not re-collapse Files.
      setValidationOpen(false);
      if (!matchesMediaQuery(MD_QUERY)) setFilesOpen(false);
      // setXml already dropped a previously auto-detected schema; a schema the
      // user picked by hand is kept and must not be overridden.
      if (useApp.getState().xsdInfo) return;

      const usable = doc.schema_hints.find((h) => h.resolved_url);
      if (!usable) {
        const local = doc.schema_hints[0];
        if (local) setAutoSchema({ kind: "local", detail: local.location });
        return;
      }
      try {
        setXsd(await autoLoadXsd(doc.xml_id), "auto");
      } catch (err) {
        setAutoSchema({
          kind: "error",
          detail: err instanceof ApiError ? err.message : String(err),
        });
      }
    },
    [setXml, setXsd],
  );

  const onXmlFile = useCallback(async (f: File) => applyXml(await uploadXmlFile(f)), [applyXml]);
  const onXmlText = useCallback(async (c: string) => applyXml(await uploadXmlText(c)), [applyXml]);
  const onXmlUrl = useCallback(async (u: string) => applyXml(await uploadXmlUrl(u)), [applyXml]);
  const onXmlSample = useCallback(
    async () => applyXml(await uploadXmlUrl(FUNDSXML_SAMPLE_URL)),
    [applyXml],
  );
  // A schema the user loaded by hand. On phones the open loaders would push
  // the document and the validation result off screen, so Files collapses
  // once the load succeeded (the summary row keeps both filenames visible).
  const applyXsd = useCallback(
    (info: XsdInfo) => {
      setXsd(info);
      if (!matchesMediaQuery(MD_QUERY)) setFilesOpen(false);
    },
    [setXsd],
  );
  const onXsdFile = useCallback(
    async (f: File, mainFilename?: string) => applyXsd(await uploadXsdFile(f, mainFilename)),
    [applyXsd],
  );
  const onXsdText = useCallback(async (c: string) => applyXsd(await uploadXsdText(c)), [applyXsd]);
  const onXsdUrl = useCallback(async (u: string) => applyXsd(await uploadXsdUrl(u)), [applyXsd]);
  const onXsdRelease = useCallback(
    async (tag: string, filename: string) => applyXsd(await loadXsdFromRelease(tag, filename)),
    [applyXsd],
  );
  const onXsdClear = useCallback(() => {
    clearXsd();
    setAutoSchema(null);
  }, [clearXsd]);

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
  // file as if the user had uploaded it here — and the schema, when the
  // sender attached one, so validation starts on its own. Falls back to
  // manual upload if the opener never answers (popup blocker, old deploy).
  useEffect(() => {
    if (!isHandoff) return;
    const cleanup = receiveHandoff((file, schema) => {
      setHandoff({ status: "loading", detail: file.name });
      void uploadXmlFile(file)
        .then(async (doc) => {
          await applyXml(doc);
          if (schema) {
            setHandoff({ status: "loading", detail: schema.file.name });
            applyXsd(await uploadXsdFile(schema.file, schema.mainFilename));
            setValidationOpen(true);
          }
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
  }, [applyXml, applyXsd]);

  // Everything but Search and the theme toggle folds into a "More" menu
  // below `lg`, so the header stays a single row on phones.
  const secondaryActions = useMemo<HeaderAction[]>(
    () => [
      { key: "feedback", label: "💬 Feedback", title: "Send feedback", ariaLabel: "Send feedback", onClick: openFeedback },
      {
        key: "xsd-viewer",
        label: "XSD Viewer ↗",
        title: "Have an XML Schema instead? Open our sister tool XSD Viewer",
        ariaLabel: "Open XSD Viewer (sister tool for XML Schemas)",
        href: XSD_VIEWER_URL,
        external: true,
      },
      { key: "github", label: "GitHub", title: "Source code on GitHub", ariaLabel: "Source code on GitHub", href: GITHUB_REPO_URL, external: true },
      { key: "about", label: "ℹ️ About", title: "About this app", ariaLabel: "About this app", onClick: openAbout },
    ],
    [],
  );

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-3 short:py-1 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-base md:text-lg font-semibold shrink-0">XML Online Viewer</h1>
          <p className="hidden lg:block text-sm text-slate-500 dark:text-slate-400 truncate">
            View any XML file as a tree or diagram · validate it against an XSD
          </p>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
          <button
            type="button"
            className="btn"
            onClick={openTreeSearch}
            disabled={!xmlDoc}
            title="Search (Ctrl/Cmd-K)"
            aria-label="Search"
          >
            <span aria-hidden="true">🔍</span>
            <span className="hidden sm:inline">Search</span>
          </button>
          <HeaderActions actions={secondaryActions} inline={wide} />
          <ThemeToggle />
        </div>
      </header>

      <div className="border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setFilesOpen((o) => !o)}
          aria-expanded={filesOpen}
          className="w-full min-w-0 flex items-center gap-2 px-3 md:px-4 py-1.5 touch:py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-900"
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
          <div className="px-3 md:px-4 pb-3 md:pb-4">
            <Uploader
              xmlStatus={xmlDoc ? `${xmlDoc.filename} (${xmlDoc.node_count} nodes)` : null}
              xsdStatus={xsdInfo ? xsdInfo.main_filename : null}
              onXmlFile={onXmlFile}
              onXmlText={onXmlText}
              onXmlUrl={onXmlUrl}
              onXmlSample={onXmlSample}
              onXsdFile={onXsdFile}
              onXsdText={onXsdText}
              onXsdUrl={onXsdUrl}
              onXsdRelease={onXsdRelease}
              onXsdClear={onXsdClear}
              defaultXsdMode={isFundsXmlRoute ? "releases" : "file"}
              // The /fundsxml landing route loads a release schema before any
              // document exists, so it keeps the loader enabled.
              xsdDisabled={!xmlDoc && !isFundsXmlRoute}
              xsdStatusNote={
                xsdSource === "auto" ? (
                  <span className="chip bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                    auto-detected
                  </span>
                ) : null
              }
            />
            {autoSchema && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status">
                {autoSchema.kind === "local"
                  ? `This document references ${autoSchema.detail}. Load that schema on the right to validate it.`
                  : `The schema referenced by this document could not be loaded (${autoSchema.detail}). Load it manually on the right.`}
              </p>
            )}
          </div>
        )}
      </div>

      <main className="flex-1 min-h-0">
        {!xmlDoc ? (
          <div className="h-full overflow-y-auto">
            <div className="min-h-full flex items-center justify-center p-4 md:p-6">
            <div className="max-w-lg text-center">
              <h2 className="text-xl font-semibold mb-2">Start with an XML file</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
                Drop it into <strong>XML data</strong> above — nothing is stored, and no account
                is needed.
              </p>
              <ul className="text-sm text-slate-600 dark:text-slate-400 space-y-1.5 mb-5 text-left inline-block">
                {[
                  ["🌳", "Browse the document as a collapsible tree or as a diagram"],
                  ["🔍", "Search across elements, attributes and values (Ctrl/Cmd-K)"],
                  [
                    "✅",
                    "Validate against an XSD — auto-detected from the document when it names one — and export the errors to Excel",
                  ],
                ].map(([icon, text]) => (
                  <li key={text} className="flex gap-2">
                    <span aria-hidden="true">{icon}</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void onXmlSample()}
                >
                  Load a FundsXML example
                </button>
              </p>
              <p className="mt-5 text-xs text-slate-500 dark:text-slate-400">
                Have an XML Schema (.xsd) instead?{" "}
                <a
                  className="underline underline-offset-2"
                  href={XSD_VIEWER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Visualise it in the XSD Viewer ↗
                </a>
              </p>
            </div>
            </div>
          </div>
        ) : (
          // Phone: one pane at a time (bottom nav). Tablet (md): tab strip +
          // view, validation in a drawer. Desktop (lg): two columns.
          <div className="h-full min-h-0 flex flex-col md:grid md:grid-cols-1 lg:grid-cols-[1fr_28rem]">
            <div
              className={clsx(
                "min-h-0 h-full flex-col md:flex",
                validationOpen ? "hidden" : "flex flex-1",
              )}
            >
              <div className="hidden md:flex items-center gap-1 px-3 py-2 short:py-1 border-b border-slate-200 dark:border-slate-800">
                <div className="flex gap-1" role="tablist">
                  {(["tree", "diagram"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={viewMode === m}
                      className={clsx(
                        "px-3 py-1 touch:py-2 text-sm font-medium rounded-md",
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
                {/* Tablet only: validation lives in a drawer. */}
                <button
                  type="button"
                  className="btn ml-auto hidden md:inline-flex lg:hidden"
                  onClick={() => setValidationOpen((v) => !v)}
                  aria-label="Show validation"
                  aria-pressed={validationOpen}
                  title={validationOpen ? "Hide the validation panel" : "Show the validation panel"}
                >
                  ✅ Validation
                  {validation && !validation.is_valid && (
                    <span className="chip bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                      {validation.errors.length}
                    </span>
                  )}
                </button>
              </div>
              <div className="flex-1 min-h-0">
                {viewMode === "tree" ? <XmlTreeView /> : <DiagramView />}
              </div>
            </div>
            {validationOpen && (
              <div
                className="hidden md:block lg:hidden fixed inset-0 z-20 bg-black/30"
                aria-hidden="true"
                onClick={closeValidation}
              />
            )}
            <aside
              ref={asideRef}
              aria-label="Validation"
              className={clsx(
                "min-h-0 flex-col bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 md:border-l",
                validationOpen
                  ? "flex flex-1 md:flex-none md:fixed md:inset-y-0 md:right-0 md:z-30 md:w-[400px] md:max-w-[90vw] md:shadow-2xl"
                  : "hidden",
                "lg:flex lg:static lg:inset-auto lg:z-auto lg:w-auto lg:max-w-none lg:shadow-none lg:h-full",
              )}
            >
              <ValidationPanel
                onPick={() => {
                  // Phones: show the picked node. Tablets keep the drawer open.
                  if (!atLeastMd) setValidationOpen(false);
                }}
                onClose={closeValidation}
              />
            </aside>
          </div>
        )}
      </main>

      {xmlDoc && <MobileNav pane={mobilePane} onChange={onMobilePane} />}

      <FeedbackDialog />
      <AboutDialog />
    </div>
  );
}
