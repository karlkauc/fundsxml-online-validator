import { Handle, Position } from "@xyflow/react";
import clsx from "clsx";
import { MAX_INLINE_ATTRS, NODE_WIDTH, type XmlNodeData } from "./buildGraph";

export function XmlElementNode({ data }: { data: XmlNodeData }) {
  const attrs = data.attributes ?? [];
  const isElement = data.kind === "element";
  // Node is error-free itself but an erroneous node hides in its subtree.
  const hasErrorBelow = !data.hasError && data.descendantErrorCount > 0;

  return (
    <div
      className={clsx(
        "rounded-md border bg-white dark:bg-slate-900 shadow-sm text-xs",
        data.selected
          ? "border-accent ring-2 ring-accent/50"
          : data.hasError
            ? "border-red-400 ring-2 ring-red-400/40"
            : hasErrorBelow
              ? "border-amber-400 ring-2 ring-amber-400/40"
              : "border-slate-300 dark:border-slate-700",
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} />

      <div
        className={clsx(
          "flex items-center justify-between gap-1 px-2 py-1 border-b rounded-t-md",
          data.hasError
            ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20"
            : hasErrorBelow
              ? "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20"
              : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800",
        )}
      >
        <span
          className={clsx(
            "font-mono font-semibold truncate",
            isElement
              ? "text-blue-700 dark:text-blue-300"
              : "text-slate-400 italic",
          )}
        >
          {data.tag}
        </span>
        {data.hasError && (
          <span
            className="shrink-0 chip bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
            aria-label={`${data.errorCount} validation error(s)`}
          >
            ✕ {data.errorCount}
          </span>
        )}
        {hasErrorBelow && (
          <span
            className="shrink-0 chip bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            aria-label={`${data.descendantErrorCount} error(s) in descendant nodes`}
          >
            ⤵ {data.descendantErrorCount}
          </span>
        )}
      </div>

      {data.text && (
        <div className="px-2 py-1 font-mono text-[11px] text-slate-700 dark:text-slate-300 truncate">
          {data.text}
        </div>
      )}

      {attrs.length > 0 && (
        <ul className="border-t border-slate-200 dark:border-slate-800 px-2 py-1 space-y-0.5">
          {attrs.slice(0, MAX_INLINE_ATTRS).map((attr) => (
            <li key={attr.name} className="font-mono text-[10px] truncate">
              <span className="text-amber-700 dark:text-amber-300">@{attr.name}</span>
              <span className="text-slate-400">=</span>
              <span className="text-emerald-700 dark:text-emerald-400">"{attr.value}"</span>
            </li>
          ))}
          {attrs.length > MAX_INLINE_ATTRS && (
            <li className="text-[10px] text-slate-500">
              +{attrs.length - MAX_INLINE_ATTRS} more…
            </li>
          )}
        </ul>
      )}

      {data.expandable && (
        <div
          className={clsx(
            "px-2 py-0.5 text-[10px] border-t border-slate-200 dark:border-slate-800 text-right",
            hasErrorBelow && !data.expanded
              ? "text-amber-700 dark:text-amber-300 font-medium"
              : "text-accent",
          )}
        >
          {hasErrorBelow && !data.expanded
            ? `⤵ ${data.descendantErrorCount} error(s) — expand`
            : data.expanded
              ? "Tap/click: collapse"
              : "Tap/click: expand"}
        </div>
      )}
      {data.expandable && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
