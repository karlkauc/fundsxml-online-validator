import type { FitViewOptions, Node } from "@xyflow/react";

export const FULL_FIT: FitViewOptions = { padding: 0.2, maxZoom: 1.2, duration: 250 };

/**
 * Initial viewport after a document loads. Desktop fits the whole graph. On
 * compact viewports that would shrink nodes to an unreadable ~0.3 zoom, so
 * we centre on the selected node (or the document root) at a legible zoom and
 * let the user pan/pinch from there.
 */
export function initialFitOptions(
  nodes: Node[],
  selectedId: string | null,
  rootId: string | null,
  compact: boolean,
): FitViewOptions {
  if (!compact || nodes.length === 0) return FULL_FIT;
  // Flow node ids are the XML node ids. buildDiagramGraph lists children
  // before their parent, so the root has to be looked up, not taken first.
  const target =
    nodes.find((n) => n.id === selectedId) ?? nodes.find((n) => n.id === rootId) ?? nodes[0];
  return { nodes: [{ id: target.id }], padding: 0.3, minZoom: 0.75, maxZoom: 1.2, duration: 250 };
}
