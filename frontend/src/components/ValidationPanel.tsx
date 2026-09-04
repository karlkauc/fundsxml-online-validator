import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { ApiError, excelReportUrl, runValidation } from "../api/client";
import { DesktopAppCard } from "./DesktopAppCard";
import { useApp } from "../stores/appStore";
import type { Severity } from "../types/model";

const SEVERITY_CLASS: Record<Severity, string> = {
  fatal: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

interface ValidationPanelProps {
  /** Called after an error row selected its node (phones jump back to the view). */
  onPick?: () => void;
  /** Renders a close button in the caption row (the tablet drawer). */
  onClose?: () => void;
}

export function ValidationPanel({ onPick, onClose }: ValidationPanelProps = {}) {
  const xmlDoc = useApp((s) => s.xmlDoc);
  const xsdInfo = useApp((s) => s.xsdInfo);
  const validation = useApp((s) => s.validation);
  const setValidation = useApp((s) => s.setValidation);
  const setSelected = useApp((s) => s.setSelected);
  const selectedNodeId = useApp((s) => s.selectedNodeId);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canValidate = !!xmlDoc && !!xsdInfo;

  const validate = useCallback(async () => {
    if (!xmlDoc || !xsdInfo) return;
    setError(null);
    setBusy(true);
    try {
      const result = await runValidation(xmlDoc.xml_id, xsdInfo.xsd_id);
      setValidation(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [xmlDoc, xsdInfo, setValidation]);

  // Validate automatically whenever a new XML or XSD is loaded (both present).
  // loadXml/loadXsd clear the previous result, so changing either id re-runs.
  const xmlId = xmlDoc?.xml_id;
  const xsdId = xsdInfo?.xsd_id;
  useEffect(() => {
    if (xmlId && xsdId) void validate();
  }, [xmlId, xsdId, validate]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Validation
        </span>
        {onClose && (
          <button
            type="button"
            className="btn px-2.5 hidden md:inline-flex lg:hidden"
            onClick={onClose}
            aria-label="Close validation"
            title="Close validation"
          >
            ✕
          </button>
        )}
      </div>

      <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canValidate || busy}
          onClick={() => void validate()}
        >
          {busy ? "Validating…" : "Validate"}
        </button>

        {validation && (
          <a
            className="btn"
            href={excelReportUrl(validation.validation_id)}
            download
          >
            ⬇ Excel report
          </a>
        )}

        {validation && (
          <span
            className={clsx(
              "chip",
              validation.is_valid
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
            )}
          >
            {validation.is_valid
              ? "Valid"
              : `${validation.errors.length} errors`}
          </span>
        )}
      </div>

      {!canValidate && (
        <p className="p-3 text-sm text-slate-500">
          Load XML data and an XSD schema to validate.
        </p>
      )}
      {error && (
        <p className="p-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {validation && (
        <div className="flex-1 min-h-0 overflow-auto">
          {validation.is_valid ? (
            <p className="p-3 text-sm text-emerald-600 dark:text-emerald-400">
              ✓ The document is valid against the schema.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {validation.errors.map((err, i) => (
                <li
                  key={i}
                  className={clsx(
                    "px-3 py-2 touch:py-3 text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900",
                    err.node_id &&
                      selectedNodeId === err.node_id &&
                      "bg-blue-50 dark:bg-blue-900/30",
                  )}
                  onClick={() => {
                    if (!err.node_id) return;
                    setSelected(err.node_id);
                    onPick?.();
                  }}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={clsx("chip", SEVERITY_CLASS[err.severity])}>
                      {err.severity}
                    </span>
                    {err.line != null && (
                      <span className="font-mono text-xs text-slate-400">
                        Line {err.line}
                        {err.column ? `:${err.column}` : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-700 dark:text-slate-300">{err.message}</p>
                  {err.path && (
                    <p className="font-mono text-[11px] text-slate-400 truncate mt-0.5">
                      {err.path}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {validation && (
        <div className="px-3 pb-3">
          <DesktopAppCard variant="inline">
            Fix errors in a schema-aware editor, add Schematron business rules, or validate whole
            folders with the free desktop app:
          </DesktopAppCard>
        </div>
      )}
    </div>
  );
}
