import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useApp } from "../../stores/appStore";
import { buildDiagramGraph, NODE_WIDTH } from "./buildGraph";
import { XmlElementNode } from "./XmlElementNode";
import { exportFlowAsPng, exportFlowAsSvg } from "./exportImage";
import { computeAnchoredViewport } from "./anchorViewport";
import { DiagramToolbar, type ExportFormat } from "./DiagramToolbar";
import { initialFitOptions } from "./fitOptions";
import { MD_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

const NODE_TYPES = {
  xmlElement: XmlElementNode as unknown as React.ComponentType<NodeProps>,
};

const MINIMAP_LIGHT = {
  nodeColor: "#475569",
  nodeStrokeColor: "#1e293b",
  maskColor: "rgba(15, 23, 42, 0.12)",
  bgColor: "#ffffff",
} as const;
const MINIMAP_DARK = {
  nodeColor: "#cbd5e1",
  nodeStrokeColor: "#f1f5f9",
  maskColor: "rgba(226, 232, 240, 0.15)",
  bgColor: "#0f172a",
} as const;

function subscribeToHtmlClass(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
function getIsDark(): boolean {
  return document.documentElement.classList.contains("dark");
}
function useIsDarkTheme(): boolean {
  return useSyncExternalStore(subscribeToHtmlClass, getIsDark, () => false);
}

export function DiagramView() {
  return (
    <ReactFlowProvider>
      <DiagramInner />
    </ReactFlowProvider>
  );
}

function DiagramInner() {
  const xmlDoc = useApp((s) => s.xmlDoc);
  const selectedNodeId = useApp((s) => s.selectedNodeId);
  const expandedIds = useApp((s) => s.expandedIds);
  const errorsByNodeId = useApp((s) => s.errorsByNodeId);
  const descendantErrorCounts = useApp((s) => s.descendantErrorCounts);
  const setSelected = useApp((s) => s.setSelected);
  const toggleExpanded = useApp((s) => s.toggleExpanded);
  const expandAll = useApp((s) => s.expandAll);
  const collapseAll = useApp((s) => s.collapseAll);
  const minimapVisible = useApp((s) => s.minimapVisible);
  const setMinimapVisible = useApp((s) => s.setMinimapVisible);

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!xmlDoc) return { nodes: [], edges: [] };
    return buildDiagramGraph(
      xmlDoc.root,
      expandedIds,
      selectedNodeId,
      errorsByNodeId,
      descendantErrorCounts,
    );
  }, [xmlDoc, expandedIds, selectedNodeId, errorsByNodeId, descendantErrorCounts]);

  const flow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const isDark = useIsDarkTheme();
  const minimapColors = isDark ? MINIMAP_DARK : MINIMAP_LIGHT;
  // Phones get icon-only toolbar buttons and a fit centred on one node.
  const compact = !useMediaQuery(MD_QUERY);
  // Latest fit options without re-running the fit effects on every render.
  const rootId = xmlDoc?.root.id ?? null;
  const fitOptionsRef = useRef(initialFitOptions(nodes, selectedNodeId, rootId, compact));
  fitOptionsRef.current = initialFitOptions(nodes, selectedNodeId, rootId, compact);

  // Keeps a clicked node visually fixed across the toggle-driven re-layout.
  const pendingAnchorRef = useRef<
    { nodeId: string; worldX: number; worldY: number } | null
  >(null);
  // Selection ids that originated from a click *inside* the diagram — those
  // keep their anchor and must NOT trigger the auto-centering below.
  const internalSelectRef = useRef<string | null>(null);
  // The id we have already centered on, so we center once per external select.
  const centeredForRef = useRef<string | null>(null);

  // Only re-fit when the loaded document changes — re-fitting on every
  // expand/collapse would jitter the viewport and lose pan/zoom. The fit has
  // to wait until React Flow has taken over the new nodes and measured them:
  // fitting unmeasured nodes (especially the single-node fit on phones)
  // lands on a bogus viewport. Nodes are uncontrolled here (no
  // onNodesChange), so `useNodesInitialized` never flips; poll a few frames.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    if (nodes.length === 0) return;
    let attempts = 0;
    let raf = 0;
    const tryFit = () => {
      const ready = nodesRef.current.every((n) => {
        const internal = flow.getInternalNode(n.id);
        return (
          internal?.internals.userNode === n &&
          !!internal.measured.width &&
          !!internal.measured.height
        );
      });
      if (ready) {
        void flow.fitView(fitOptionsRef.current);
        return;
      }
      if (++attempts < 120) raf = requestAnimationFrame(tryFit);
    };
    raf = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xmlDoc?.xml_id]);

  // On phones the diagram can sit inside a hidden (display:none) pane while
  // a document loads, so React Flow's fitView measures a 0x0 box. Re-fit the
  // first time the container gains real size. Inert on desktop.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let hadSize = el.clientWidth > 0 && el.clientHeight > 0;
    const observer = new ResizeObserver(() => {
      const hasSize = el.clientWidth > 0 && el.clientHeight > 0;
      if (!hadSize && hasSize && nodes.length > 0) {
        requestAnimationFrame(() => flow.fitView(fitOptionsRef.current));
      }
      hadSize = hasSize;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [flow, nodes.length]);

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    const newNode = nodes.find((n) => n.id === anchor.nodeId);
    if (!newNode) return;
    const next = computeAnchoredViewport(
      { worldX: anchor.worldX, worldY: anchor.worldY },
      newNode.position,
      flow.getViewport(),
    );
    flow.setViewport(next);
  }, [nodes, flow]);

  // Center the viewport on a node selected from outside the diagram (a tree
  // row or a validation error). Selections made by clicking a node in the
  // diagram keep their anchored position and are skipped.
  useEffect(() => {
    if (!selectedNodeId) {
      centeredForRef.current = null;
      return;
    }
    if (selectedNodeId === internalSelectRef.current) {
      centeredForRef.current = selectedNodeId;
      internalSelectRef.current = null;
      return;
    }
    if (centeredForRef.current === selectedNodeId) return;
    if (!nodes.some((n) => n.id === selectedNodeId)) return; // not revealed yet
    centeredForRef.current = selectedNodeId;
    requestAnimationFrame(() => {
      const node = flow.getNode(selectedNodeId);
      if (!node) return;
      const w = node.measured?.width ?? NODE_WIDTH;
      const h = node.measured?.height ?? 64;
      flow.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        zoom: flow.getZoom(),
        duration: 400,
      });
    });
  }, [selectedNodeId, nodes, flow]);

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      const data = node.data as { nodeId?: string; expandable?: boolean } | undefined;
      if (!data?.nodeId) return;
      internalSelectRef.current = data.nodeId;
      setSelected(data.nodeId);
      if (data.expandable) {
        pendingAnchorRef.current = {
          nodeId: data.nodeId,
          worldX: node.position.x,
          worldY: node.position.y,
        };
        toggleExpanded(data.nodeId);
      }
    },
    [setSelected, toggleExpanded],
  );

  const onExport = useCallback(
    async (format: ExportFormat) => {
      const viewportEl =
        wrapperRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
      if (!viewportEl) return;
      const exportNodes = flow.getNodes();
      try {
        if (format === "svg") {
          await exportFlowAsSvg(viewportEl, exportNodes, { filename: "xml-diagram.svg" });
        } else {
          await exportFlowAsPng(viewportEl, exportNodes, { filename: "xml-diagram.png" });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alert(`${format.toUpperCase()} export failed: ${msg}`);
      }
    },
    [flow],
  );

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <DiagramToolbar
        compact={compact}
        minimapVisible={minimapVisible}
        canExpand={!!xmlDoc}
        canCollapse={expandedIds.size > 0}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onToggleMinimap={() => setMinimapVisible(!minimapVisible)}
        onExport={(format) => void onExport(format)}
      />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        {minimapVisible && (
          <MiniMap pannable zoomable nodeStrokeWidth={2} {...minimapColors} />
        )}
        <Controls />
      </ReactFlow>
    </div>
  );
}
