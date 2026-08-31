import { create } from "zustand";
import type {
  ValidationErrorItem,
  ValidationResponse,
  XmlDocModel,
  XmlNode,
  XsdInfo,
} from "../types/model";

function collectExpandableIds(root: XmlNode): Set<string> {
  const ids = new Set<string>();
  const walk = (node: XmlNode) => {
    if (node.children.length > 0) {
      ids.add(node.id);
      node.children.forEach(walk);
    }
  };
  walk(root);
  return ids;
}

/** Ids of all ancestors of `targetId` (root → parent), so selecting a node
 * can reveal it by expanding the chain above it. Empty if not found. */
function ancestorIds(root: XmlNode, targetId: string): string[] {
  const path: string[] = [];
  const walk = (node: XmlNode, trail: string[]): boolean => {
    if (node.id === targetId) {
      path.push(...trail);
      return true;
    }
    const nextTrail = [...trail, node.id];
    return node.children.some((c) => walk(c, nextTrail));
  };
  walk(root, []);
  return path;
}

function indexErrors(
  errors: ValidationErrorItem[],
): Map<string, ValidationErrorItem[]> {
  const map = new Map<string, ValidationErrorItem[]>();
  for (const err of errors) {
    if (!err.node_id) continue;
    const list = map.get(err.node_id);
    if (list) list.push(err);
    else map.set(err.node_id, [err]);
  }
  return map;
}

/** For each node, the number of errors *strictly below* it (not its own), so a
 * collapsed parent can signal that an erroneous node hides in its subtree.
 * Single post-order pass over the tree. */
function computeDescendantErrorCounts(
  root: XmlNode,
  errorsByNodeId: Map<string, ValidationErrorItem[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const dfs = (node: XmlNode): number => {
    const own = errorsByNodeId.get(node.id)?.length ?? 0;
    let below = 0;
    for (const child of node.children) below += dfs(child);
    if (below > 0) counts.set(node.id, below);
    return own + below;
  };
  dfs(root);
  return counts;
}

/** Where the currently loaded schema came from. A "manual" pick is never
 * replaced by auto-detection — the user's choice wins. */
export type XsdSource = "auto" | "manual";

interface AppState {
  xmlDoc: XmlDocModel | null;
  xsdInfo: XsdInfo | null;
  xsdSource: XsdSource | null;
  validation: ValidationResponse | null;
  errorsByNodeId: Map<string, ValidationErrorItem[]>;
  descendantErrorCounts: Map<string, number>;

  expandedIds: Set<string>;
  selectedNodeId: string | null;
  searchQuery: string;
  viewMode: "tree" | "diagram";
  minimapVisible: boolean;

  setXml: (doc: XmlDocModel) => void;
  setXsd: (info: XsdInfo, origin?: XsdSource) => void;
  clearXsd: () => void;
  setValidation: (result: ValidationResponse) => void;
  clearValidation: () => void;
  toggleExpanded: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  setSelected: (id: string | null) => void;
  setSearch: (q: string) => void;
  setViewMode: (mode: "tree" | "diagram") => void;
  setMinimapVisible: (visible: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  xmlDoc: null,
  xsdInfo: null,
  xsdSource: null,
  validation: null,
  errorsByNodeId: new Map(),
  descendantErrorCounts: new Map(),

  expandedIds: new Set(),
  selectedNodeId: null,
  searchQuery: "",
  viewMode: "diagram",
  minimapVisible: false,

  setXml: (doc) =>
    set({
      xmlDoc: doc,
      // A new document invalidates an auto-detected schema (it was derived
      // from the previous one); a manual pick is kept.
      ...(get().xsdSource === "auto" ? { xsdInfo: null, xsdSource: null } : {}),
      // Expand only the root, so the first level (root + direct children) is
      // visible and everything below stays collapsed.
      expandedIds: new Set([doc.root.id]),
      selectedNodeId: null,
      validation: null,
      errorsByNodeId: new Map(),
      descendantErrorCounts: new Map(),
    }),

  setXsd: (info, origin = "manual") =>
    set({
      xsdInfo: info,
      xsdSource: origin,
      validation: null,
      errorsByNodeId: new Map(),
      descendantErrorCounts: new Map(),
    }),

  clearXsd: () =>
    set({
      xsdInfo: null,
      xsdSource: null,
      validation: null,
      errorsByNodeId: new Map(),
      descendantErrorCounts: new Map(),
    }),

  setValidation: (result) => {
    const errorsByNodeId = indexErrors(result.errors);
    const root = get().xmlDoc?.root;
    set({
      validation: result,
      errorsByNodeId,
      descendantErrorCounts: root
        ? computeDescendantErrorCounts(root, errorsByNodeId)
        : new Map(),
    });
  },

  clearValidation: () =>
    set({ validation: null, errorsByNodeId: new Map(), descendantErrorCounts: new Map() }),

  toggleExpanded: (id) => {
    const next = new Set(get().expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ expandedIds: next });
  },

  expandAll: () => {
    const doc = get().xmlDoc;
    if (doc) set({ expandedIds: collectExpandableIds(doc.root) });
  },

  collapseAll: () => set({ expandedIds: new Set() }),

  setSelected: (id) => {
    if (!id) {
      set({ selectedNodeId: null });
      return;
    }
    // Reveal the node in both views by expanding its ancestor chain.
    const doc = get().xmlDoc;
    if (doc) {
      const next = new Set(get().expandedIds);
      for (const anc of ancestorIds(doc.root, id)) next.add(anc);
      set({ selectedNodeId: id, expandedIds: next });
    } else {
      set({ selectedNodeId: id });
    }
  },

  setSearch: (q) => set({ searchQuery: q }),

  setViewMode: (mode) => set({ viewMode: mode }),

  setMinimapVisible: (visible) => set({ minimapVisible: visible }),
}));
