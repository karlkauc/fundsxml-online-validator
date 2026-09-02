import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  listFundsXmlReleases,
  type FundsXmlRelease,
} from "../api/client";

interface FundsXmlReleasesProps {
  onSelect: (tagName: string, filename: string) => void;
  busy: boolean;
}

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; releases: FundsXmlRelease[] };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

export function FundsXmlReleases({ onSelect, busy }: FundsXmlReleasesProps) {
  const [state, setState] = useState<ListState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await listFundsXmlReleases();
      setState({ kind: "ready", releases: response.releases });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = (tagName: string, filename: string) => {
    if (!busy) onSelect(tagName, filename);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs text-slate-600 dark:text-slate-400">
          XSD schemas from{" "}
          <a
            href="https://github.com/fundsxml/schema/releases"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            fundsxml/schema
          </a>{" "}
          — click a row to load. Learn more at{" "}
          <a
            href="https://fundsxml.org"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            fundsxml.org
          </a>
          .
        </p>
        {state.kind === "ready" && (
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
            onClick={() => void load()}
            disabled={busy}
          >
            Refresh
          </button>
        )}
      </div>

      {state.kind === "loading" && (
        <p className="text-xs text-slate-500 py-2">Loading releases…</p>
      )}

      {state.kind === "error" && (
        <div className="py-2">
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            Could not load releases: {state.message}
          </p>
          <button type="button" className="btn btn-primary mt-2" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {state.kind === "ready" && state.releases.length === 0 && (
        <p className="text-xs text-slate-500 py-2">No XSD releases found.</p>
      )}

      {state.kind === "ready" && state.releases.length > 0 && (
        <div className="max-h-64 overflow-y-auto overflow-x-auto border border-slate-200 dark:border-slate-800 rounded">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <th className="py-1 px-2 font-semibold">Version</th>
                <th className="hidden sm:table-cell py-1 px-2 font-semibold">Date</th>
                <th className="py-1 px-2 font-semibold">File</th>
                <th className="hidden sm:table-cell py-1 px-2 font-semibold text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {state.releases.flatMap((release) =>
                release.assets.map((asset, assetIdx) => {
                  const isFirst = assetIdx === 0;
                  return (
                    <tr
                      key={`${release.tag_name}:${asset.filename}`}
                      className={
                        "border-b border-slate-100 dark:border-slate-900 " +
                        (busy
                          ? "opacity-60 cursor-wait "
                          : "hover:bg-slate-50 dark:hover:bg-slate-900/50 cursor-pointer ")
                      }
                      role="button"
                      tabIndex={busy ? -1 : 0}
                      aria-disabled={busy}
                      onClick={() => activate(release.tag_name, asset.filename)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          activate(release.tag_name, asset.filename);
                        }
                      }}
                    >
                      {isFirst && (
                        <td
                          className="py-1 touch:py-2.5 px-2 font-mono align-top whitespace-nowrap"
                          rowSpan={release.assets.length}
                        >
                          {release.tag_name}
                          {release.prerelease && (
                            <span className="ml-1 inline-block px-1 py-0.5 text-[9px] font-semibold uppercase rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                              pre
                            </span>
                          )}
                        </td>
                      )}
                      {isFirst && (
                        <td
                          className="hidden sm:table-cell py-1 px-2 align-top text-slate-600 dark:text-slate-400"
                          rowSpan={release.assets.length}
                        >
                          {formatDate(release.published_at)}
                        </td>
                      )}
                      <td className="py-1 touch:py-2.5 px-2 font-mono break-all">
                        {asset.filename}
                      </td>
                      <td className="hidden sm:table-cell py-1 px-2 text-right text-slate-600 dark:text-slate-400">
                        {formatBytes(asset.size)}
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
