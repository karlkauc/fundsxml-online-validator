import { useEffect, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import clsx from "clsx";
import { useApp } from "../../stores/appStore";
import { buildTreeRows, type TreeRow } from "./treeRows";
import { EVENT_OPEN_SEARCH } from "../../lib/links";

export function XmlTreeView() {
  const xmlDoc = useApp((s) => s.xmlDoc);
  const expandedIds = useApp((s) => s.expandedIds);
  const searchQuery = useApp((s) => s.searchQuery);
  const selectedNodeId = useApp((s) => s.selectedNodeId);
  const errorsByNodeId = useApp((s) => s.errorsByNodeId);
  const descendantErrorCounts = useApp((s) => s.descendantErrorCounts);
  const toggleExpanded = useApp((s) => s.toggleExpanded);
  const expandAll = useApp((s) => s.expandAll);
  const collapseAll = useApp((s) => s.collapseAll);
  const setSelected = useApp((s) => s.setSelected);
  const setSearch = useApp((s) => s.setSearch);

  const virtuoso = useRef<VirtuosoHandle | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);

  // Header "Search" button / Ctrl-K: focus the search box.
  useEffect(() => {
    const onOpen = () => {
      searchInput.current?.focus();
      searchInput.current?.select();
    };
    window.addEventListener(EVENT_OPEN_SEARCH, onOpen);
    return () => window.removeEventListener(EVENT_OPEN_SEARCH, onOpen);
  }, []);

  const rows = useMemo<TreeRow[]>(() => {
    if (!xmlDoc) return [];
    return buildTreeRows(xmlDoc.root, expandedIds, searchQuery);
  }, [xmlDoc, expandedIds, searchQuery]);

  // When a node is selected (e.g. by clicking a validation error), scroll to it.
  useEffect(() => {
    if (!selectedNodeId) return;
    const idx = rows.findIndex((r) => r.node.id === selectedNodeId);
    if (idx >= 0)
      virtuoso.current?.scrollToIndex({ index: idx, align: "center", behavior: "smooth" });
  }, [selectedNodeId, rows]);

  if (!xmlDoc) return null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {xmlDoc.filename}
        </span>
        <span className="font-mono text-[10px] text-slate-400">
          {xmlDoc.node_count} nodes · {rows.length} visible
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="btn !px-2 !py-1" onClick={expandAll}>
            Expand all
          </button>
          <button type="button" className="btn !px-2 !py-1" onClick={collapseAll}>
            Collapse all
          </button>
        </div>
      </div>
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <input
          ref={searchInput}
          type="search"
          placeholder="Search tag, attribute or value… (Ctrl/Cmd-K)"
          className="w-full text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          value={searchQuery}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="flex-1 min-h-0">
        <Virtuoso
          ref={virtuoso}
          style={{ height: "100%" }}
          totalCount={rows.length}
          itemContent={(idx) => {
            const row = rows[idx];
            return (
              <TreeRowView
                row={row}
                expanded={expandedIds.has(row.node.id)}
                selected={selectedNodeId === row.node.id}
                errorCount={errorsByNodeId.get(row.node.id)?.length ?? 0}
                belowCount={descendantErrorCounts.get(row.node.id) ?? 0}
                onToggle={() => toggleExpanded(row.node.id)}
                onSelect={() => setSelected(row.node.id)}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

interface RowProps {
  row: TreeRow;
  expanded: boolean;
  selected: boolean;
  errorCount: number;
  belowCount: number;
  onToggle: () => void;
  onSelect: () => void;
}

function TreeRowView({
  row,
  expanded,
  selected,
  errorCount,
  belowCount,
  onToggle,
  onSelect,
}: RowProps) {
  const { node, depth, hasChildren } = row;
  const hasError = errorCount > 0;
  // Only relevant when the node itself is error-free: a descendant has an error.
  const hasErrorBelow = !hasError && belowCount > 0;

  return (
    <div
      className={clsx(
        "flex items-center gap-1 cursor-pointer select-none text-sm border-l-2 py-0.5",
        selected
          ? "bg-blue-50 dark:bg-blue-900/30 border-accent"
          : hasError
            ? "bg-red-50 dark:bg-red-900/20 border-red-400"
            : hasErrorBelow
              ? "bg-amber-50 dark:bg-amber-900/15 border-amber-400"
              : "border-transparent hover:bg-slate-50 dark:hover:bg-slate-900",
      )}
      style={{ paddingLeft: `${depth * 14 + 6}px`, paddingRight: 8 }}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      onClick={onSelect}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          className="px-1 text-slate-500"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="inline-block w-5" />
      )}

      {node.kind === "element" ? (
        <>
          <span className="font-mono text-blue-700 dark:text-blue-300">
            &lt;{node.tag}
          </span>
          {node.attributes.map((a) => (
            <span key={a.name} className="font-mono text-xs whitespace-nowrap">
              <span className="text-amber-700 dark:text-amber-300"> {a.name}</span>
              <span className="text-slate-400">=</span>
              <span className="text-emerald-700 dark:text-emerald-400">"{a.value}"</span>
            </span>
          ))}
          <span className="font-mono text-blue-700 dark:text-blue-300">&gt;</span>
          {node.text && (
            <span className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[40ch]">
              {node.text}
            </span>
          )}
        </>
      ) : (
        <span className="font-mono text-slate-400 italic truncate">
          {node.kind === "comment" ? "<!-- " : ""}
          {node.tag} {node.text}
          {node.kind === "comment" ? " -->" : ""}
        </span>
      )}

      {hasError && (
        <span
          className="ml-1 chip bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
          title={`${errorCount} validation error(s)`}
        >
          ✕ {errorCount}
        </span>
      )}
      {hasErrorBelow && (
        <span
          className="ml-1 chip bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          title={`${belowCount} error(s) in descendant nodes`}
        >
          ⤵ {belowCount}
        </span>
      )}
    </div>
  );
}
