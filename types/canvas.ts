import type { Node, Edge } from "@xyflow/react"

export const NODE_SHAPES = [
  "rectangle",
  "diamond",
  "circle",
  "pill",
  "cylinder",
  "hexagon",
] as const

export type NodeShape = (typeof NODE_SHAPES)[number]

export const NODE_COLORS = [
  { fill: "#1F1F1F", text: "#EDEDED" },
  { fill: "#10233D", text: "#52A8FF" },
  { fill: "#2E1938", text: "#BF7AF0" },
  { fill: "#331B00", text: "#FF990A" },
  { fill: "#3C1618", text: "#FF6166" },
  { fill: "#3A1726", text: "#F75F8F" },
  { fill: "#0F2E18", text: "#62C073" },
  { fill: "#062822", text: "#0AC7B4" },
] as const

export const SHAPE_DEFAULTS: Record<NodeShape, { width: number; height: number }> = {
  rectangle: { width: 160, height: 80 },
  diamond: { width: 160, height: 120 },
  circle: { width: 100, height: 100 },
  pill: { width: 160, height: 72 },
  cylinder: { width: 120, height: 100 },
  hexagon: { width: 140, height: 120 },
}

// Default size for a freshly-dropped container. Wide/tall enough to
// immediately hold a handful of regular nodes without the user having to
// resize it right away.
export const CONTAINER_DEFAULTS = { width: 420, height: 300 }

// Containers render behind everything else so members placed inside them
// stay visually on top. Set as the React Flow node's top-level `zIndex`
// (not a data field) at creation time.
export const CONTAINER_Z_INDEX = -1

export interface CanvasNodeData extends Record<string, unknown> {
  label: string
  color?: string
  textColor?: string
  shape?: NodeShape
  // When true, this node renders and behaves as a container (a labeled
  // boundary box, e.g. "VPC" or "Private Subnet") instead of a regular
  // shape. Intentionally reuses the same CanvasNode/canvasNode node type
  // rather than introducing a second React Flow node type — that keeps
  // every place that already handles CanvasNode[] (autosave, canvas
  // load/save, spec generation, templates, useNodes<CanvasNode>()) working
  // unchanged, since a container is still just a CanvasNode with a flag.
  isContainer?: boolean
  // For a regular (non-container) node: the id of the container node it
  // conceptually belongs inside, if any. Purely metadata — nothing in the
  // client renders based on this field. It exists so Ghost AI can declare
  // "this node belongs in that boundary box" without needing to compute
  // the boundary's geometry itself; the design-agent settle pass reads it
  // to auto-fit each container around its members. A human placing a node
  // inside a container box by eye never needs to set this.
  containerId?: string
}

export interface CanvasEdgeData extends Record<string, unknown> {
  label?: string
}

export type CanvasNode = Node<CanvasNodeData, "canvasNode">
export type CanvasEdge = Edge<CanvasEdgeData, "canvasEdge">