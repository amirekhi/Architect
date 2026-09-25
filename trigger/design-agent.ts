import { task } from "@trigger.dev/sdk/v3";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool } from "ai";
import { z } from "zod";
import { LiveObject } from "@liveblocks/client";
import type { LiveblocksNode, LiveblocksEdge } from "@liveblocks/react-flow";
import { getLiveblocks } from "@/lib/liveblocks";
import {
  NODE_COLORS,
  SHAPE_DEFAULTS,
  NODE_SHAPES,
  CONTAINER_DEFAULTS,
  CONTAINER_Z_INDEX,
} from "@/types/canvas";
import type { CanvasNode, CanvasEdge, NodeShape } from "@/types/canvas";

const AI_USER_ID = "ghost-ai";
const AI_USER_INFO = { name: "Ghost AI", avatar: "", color: "#6457f9" };

const NODE_SYNC_CONFIG = {
  selected: false,
  dragging: false,
  measured: false,
  resizing: false,
  position: "atomic" as const,
  sourcePosition: "atomic" as const,
  targetPosition: "atomic" as const,
  extent: "atomic" as const,
  origin: "atomic" as const,
  handles: "atomic" as const,
};

const EDGE_SYNC_CONFIG = {
  selected: false,
  markerStart: "atomic" as const,
  markerEnd: "atomic" as const,
  label: "atomic" as const,
  labelBgPadding: "atomic" as const,
};

const COLOR_NAMES = ["neutral", "blue", "purple", "orange", "red", "pink", "green", "teal"];

function buildSystemPrompt(): string {
  const colorGuide = NODE_COLORS.map(
    (c, i) => `  ${i} (${COLOR_NAMES[i]}): fill=${c.fill} text=${c.text}`
  ).join("\n");

  return `You are Ghost AI, an expert system architect that generates technical architecture diagrams on a collaborative canvas.

ALLOWED SHAPES (use exact value):
- rectangle  → services, APIs, microservices, components
- cylinder   → databases, storage, caches
- hexagon    → external systems, third-party services, boundaries
- circle     → events, triggers, endpoints, user entry-points
- diamond    → decision gateways, conditionals
- pill       → processes, workflows, jobs

COLOR PALETTE (colorIndex 0-7):
${colorGuide}
Recommended mapping:
- 1 (blue)   → APIs, services, servers
- 7 (teal)   → databases, storage
- 3 (orange) → message queues, brokers, async flows
- 6 (green)  → success paths, healthy services, CDN
- 2 (purple) → auth, security, identity
- 5 (pink)   → user-facing UI, clients
- 0 (neutral)→ generic / unclassified

LAYOUT RULES:
- Start top-left at approximately x=100, y=80
- Horizontal gap between sibling nodes: 240-280px
- Vertical gap between rows: 160-200px
- Group related nodes in horizontal rows; use vertical rows for sequential flows
- Do not overlap nodes — leave clear gaps between every node's bounding box
- Edge IDs must be unique, e.g. "edge-api-auth", "edge-1"
- Node IDs must be unique short slugs, e.g. "api-gateway", "user-db", "auth-service"
- Your x/y placements are the real, final layout for the shapes you place
  relative to each other — lay them out carefully, since nothing will
  reflow or re-space your arrangement afterward. A lightweight pass only
  (a) moves your whole new group next to any existing node you connect to,
  or clear of existing content if you don't, and (b) nudges apart any
  boxes that still end up overlapping.
- If you are extending an existing canvas, prefer connecting new nodes to
  a relevant existing node with an edge where it makes sense — this lets
  the layout pass place your new group naturally next to what it relates
  to, instead of guessing at empty space.

CONTAINERS (boundary boxes — use sparingly, only when genuinely warranted):
- A container is a labeled box drawn around a group of nodes to show a
  real physical or logical boundary — a VPC, a public or private subnet,
  an availability zone or region, an on-prem vs. cloud split, a security
  or trust boundary, or an environment (dev/staging/prod). It is NOT a
  generic way to group things you think are "related" — a plain
  request/response flow, or a handful of services with no actual boundary
  concept, should have NO containers at all. Most requests need zero.
- To draw one: call addContainer with just an id, a label, and a
  colorIndex. Do not try to give it a position or size — you can't, the
  tool doesn't take one. Its geometry is computed automatically from
  whichever nodes you assign to it, after you finish placing them.
- To put a node inside a container: pass that container's id as
  containerId when calling addNode (for a new node) or updateNodeData
  (for a node that already exists). A node with no containerId sits
  directly on the canvas, outside any boundary.
- Never call moveNode or resizeNode on a container's id — its position
  and size are derived automatically from its members and any explicit
  move/resize you make will simply be overwritten.
- Prefer at most 2-4 containers per design. Do not put a container inside
  another container (nesting isn't supported).

GENERATION RULES:
- Create 5-12 nodes; do not overcrowd
- Add edges to show data/request flow
- Prefer clear left→right or top→bottom flows
- When the canvas already has nodes, extend or modify instead of replacing unless asked

INSTRUCTIONS:
- Call addNode for each node you want to place on the canvas
- Call addContainer for each boundary box you genuinely need (see CONTAINERS above), and set containerId on its members
- Call addEdge for each connection between nodes
- Call finalizeDesign last with a 1-2 sentence summary of what was designed`;
}

function clampColor(idx: number): number {
  return Math.min(Math.max(Math.round(idx ?? 0), 0), NODE_COLORS.length - 1);
}

const canvasTools = {
  addNode: tool({
    description: "Add a new node to the canvas",
    inputSchema: z.object({
      id: z.string().describe('Unique slug ID e.g. "api-gateway", "user-db"'),
      label: z.string().describe("Display label for the node"),
      shape: z.enum(NODE_SHAPES).describe("Node shape"),
      colorIndex: z.number().int().min(0).max(7).describe("Color palette index 0-7"),
      x: z.number().describe("X position in pixels"),
      y: z.number().describe("Y position in pixels"),
      containerId: z
        .string()
        .optional()
        .describe(
          "Optional: id of a container (created via addContainer) this node belongs inside. Omit if it isn't part of any boundary."
        ),
    }),
  }),
  moveNode: tool({
    description: "Move an existing node to a new position. Do not use this on a container.",
    inputSchema: z.object({
      id: z.string().describe("ID of the node to move"),
      x: z.number(),
      y: z.number(),
    }),
  }),
  resizeNode: tool({
    description: "Resize an existing node. Do not use this on a container.",
    inputSchema: z.object({
      id: z.string(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  }),
  updateNodeData: tool({
    description: "Update the label, shape, color, or container membership of an existing node",
    inputSchema: z.object({
      id: z.string(),
      label: z.string().optional(),
      shape: z.enum(NODE_SHAPES).optional(),
      colorIndex: z.number().int().min(0).max(7).optional(),
      containerId: z
        .string()
        .optional()
        .describe("Optional: assign this existing node to a container created via addContainer"),
    }),
  }),
  deleteNode: tool({
    description: "Delete a node from the canvas",
    inputSchema: z.object({
      id: z.string(),
    }),
  }),
  addContainer: tool({
    description:
      "Draw a labeled boundary box (e.g. a VPC, subnet, availability zone, trust boundary, or environment) around a group of related nodes. Only use this when the request genuinely implies a real boundary — see the CONTAINERS section of your instructions. Its position and size are computed automatically from whichever nodes are assigned to it via addNode's or updateNodeData's containerId; do not call moveNode or resizeNode on it.",
    inputSchema: z.object({
      id: z.string().describe('Unique slug ID e.g. "prod-vpc", "public-subnet"'),
      label: z.string().describe('Boundary label, e.g. "Production VPC", "Public Subnet"'),
      colorIndex: z.number().int().min(0).max(7).describe("Color palette index 0-7, used for the border and label"),
    }),
  }),
  addEdge: tool({
    description: "Add a directed edge between two nodes",
    inputSchema: z.object({
      id: z.string().describe('Unique edge ID e.g. "edge-api-db"'),
      source: z.string().describe("Source node ID"),
      target: z.string().describe("Target node ID"),
      label: z.string().optional().describe("Optional edge label"),
    }),
  }),
  deleteEdge: tool({
    description: "Delete an edge from the canvas",
    inputSchema: z.object({
      id: z.string(),
    }),
  }),
  finalizeDesign: tool({
    description: "Complete the design and provide a summary — call this last",
    inputSchema: z.object({
      summary: z.string().describe("1-2 sentence description of the designed architecture"),
    }),
  }),
};

type ToolName = keyof typeof canvasTools;
type ToolCall = { toolName: ToolName; input: Record<string, unknown> };

function describeAction(call: ToolCall): string {
  switch (call.toolName) {
    case "addNode": {
      const { label } = call.input as { label?: string };
      return `Adding "${label || "node"}"…`;
    }
    case "addContainer": {
      const { label } = call.input as { label?: string };
      return `Drawing boundary "${label || "container"}"…`;
    }
    case "addEdge": {
      const { source, target } = call.input as { source: string; target: string };
      return `Connecting ${source} → ${target}…`;
    }
    case "moveNode": {
      const { id } = call.input as { id: string };
      return `Repositioning "${id}"…`;
    }
    case "resizeNode": {
      const { id } = call.input as { id: string };
      return `Resizing "${id}"…`;
    }
    case "updateNodeData": {
      const { id } = call.input as { id: string };
      return `Updating "${id}"…`;
    }
    case "deleteNode": {
      const { id } = call.input as { id: string };
      return `Removing "${id}"…`;
    }
    case "deleteEdge":
      return "Removing a connection…";
    default:
      return "Working…";
  }
}

// ---- Layout settle pass -----------------------------------------------
//
// Two things happen here, in order:
//   1. Regular (non-container) touched nodes are translated as a rigid
//      group into a valid spot (anchored to a connected existing node, or
//      clear of existing content), then a collision pass nudges apart
//      anything that still overlaps. Containers never participate in this
//      — see the CONTAINERS notes throughout.
//   2. Every container that was touched this run, or whose membership
//      changed this run, is auto-fit: its position and size are set to
//      the bounding box of its current members (using their FINAL,
//      post-settle positions from step 1) plus padding. The model never
//      has to get container geometry right — it only has to say which
//      nodes go in which container.

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SettledRect {
  x: number;
  y: number;
  // Present only for containers — a container's size is derived from its
  // members, so unlike a regular node its box can change dimensions, not
  // just position.
  width?: number;
  height?: number;
}

interface SimpleEdge {
  id: string;
  source: string;
  target: string;
}

// Minimum enforced gap between any two (non-container) node boxes, in
// canvas pixels.
const OVERLAP_MARGIN = 24;
// Preferred gap when anchoring a new group next to a connected existing
// node, or placing an unconnected group/empty container clear of
// existing content.
const ANCHOR_GAP = 220;
const CLEAR_OF_EXISTING_GAP = 160;

// Padding between a container's edge and its members' bounding box. Top
// padding is larger to leave room for the label chip that sits on the
// container's top border.
const CONTAINER_PADDING_X = 40;
const CONTAINER_PADDING_TOP = 56;
const CONTAINER_PADDING_BOTTOM = 32;

function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

/**
 * Iteratively separates `movable` rects from each other and from `fixed`
 * (pre-existing, untouched) rects until nothing overlaps.
 *
 * Every pairwise push a node is subject to within one iteration (against
 * every fixed obstacle AND every other movable node) is summed into a
 * single delta before being applied, rather than applied immediately per
 * obstacle. Applying pushes serially can cause a node squeezed between
 * two things to bounce back and forth, partially undoing each correction;
 * accumulating first avoids that oscillation and converges reliably.
 */
function resolveOverlaps(movable: Map<string, Rect>, fixed: Rect[], iterations = 120): void {
  const ids = [...movable.keys()];
  if (ids.length === 0) return;

  for (let iter = 0; iter < iterations; iter++) {
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const id of ids) deltas.set(id, { dx: 0, dy: 0 });
    let maxOverlap = 0;

    for (const id of ids) {
      const r = movable.get(id)!;
      for (const obstacle of fixed) {
        if (!rectsOverlap(r, obstacle, OVERLAP_MARGIN)) continue;

        const pushRight = obstacle.x + obstacle.width + OVERLAP_MARGIN - r.x;
        const pushLeft = r.x + r.width + OVERLAP_MARGIN - obstacle.x;
        const pushDown = obstacle.y + obstacle.height + OVERLAP_MARGIN - r.y;
        const pushUp = r.y + r.height + OVERLAP_MARGIN - obstacle.y;
        const minX = Math.min(pushRight, pushLeft);
        const minY = Math.min(pushDown, pushUp);

        const d = deltas.get(id)!;
        if (minX < minY) {
          d.dx += pushRight < pushLeft ? pushRight : -pushLeft;
        } else {
          d.dy += pushDown < pushUp ? pushDown : -pushUp;
        }
        maxOverlap = Math.max(maxOverlap, Math.min(minX, minY));
      }
    }

    for (let i = 0; i < ids.length; i++) {
      const a = movable.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const b = movable.get(ids[j])!;
        if (!rectsOverlap(a, b, OVERLAP_MARGIN)) continue;

        const pushRight = b.x + b.width + OVERLAP_MARGIN - a.x;
        const pushLeft = a.x + a.width + OVERLAP_MARGIN - b.x;
        const pushDown = b.y + b.height + OVERLAP_MARGIN - a.y;
        const pushUp = a.y + a.height + OVERLAP_MARGIN - b.y;
        const minX = Math.min(pushRight, pushLeft);
        const minY = Math.min(pushDown, pushUp);

        const da = deltas.get(ids[i])!;
        const db = deltas.get(ids[j])!;
        if (minX < minY) {
          const shift = (pushRight < pushLeft ? pushRight : -pushLeft) / 2;
          da.dx -= shift;
          db.dx += shift;
        } else {
          const shift = (pushDown < pushUp ? pushDown : -pushUp) / 2;
          da.dy -= shift;
          db.dy += shift;
        }
        maxOverlap = Math.max(maxOverlap, Math.min(minX, minY));
      }
    }

    for (const id of ids) {
      const r = movable.get(id)!;
      const d = deltas.get(id)!;
      r.x += d.dx;
      r.y += d.dy;
    }

    if (maxOverlap <= 0) break;
  }
}

/**
 * Settles this run's touched nodes onto the canvas, then auto-fits any
 * containers around their members. Returns new geometry only for nodes
 * that actually changed — regular nodes get {x,y}; containers that were
 * refit also get {width,height}.
 */
function computeSettledLayout(
  touchedNodeIds: Set<string>,
  allRects: Map<string, Rect>,
  allEdges: SimpleEdge[],
  containerNodeIds: Set<string>,
  nodeContainerId: Map<string, string>
): Map<string, SettledRect> {
  const result = new Map<string, SettledRect>();

  // ---- Phase 1: settle regular (non-container) touched nodes ----
  const movable = new Map<string, Rect>();
  const untouchedRects = new Map<string, Rect>();
  for (const [id, rect] of allRects) {
    // Containers are handled entirely separately in phase 2 — they never
    // participate in translation or collision as either a mover or an
    // obstacle. A container is meant to be overlapped by its members, not
    // to block anything.
    if (containerNodeIds.has(id)) continue;
    if (touchedNodeIds.has(id)) movable.set(id, { ...rect });
    else untouchedRects.set(id, rect);
  }

  if (movable.size > 0) {
    let offsetX = 0;
    let offsetY = 0;

    if (untouchedRects.size > 0) {
      // Look for edges connecting a moved/new node to an existing
      // untouched node — these become anchors. For each anchor edge,
      // compute how far the connected node would need to shift so it
      // sits ANCHOR_GAP away from the anchor, in whatever direction it's
      // already roughly facing. Average across all anchor edges if
      // there's more than one.
      let sumDx = 0;
      let sumDy = 0;
      let anchorCount = 0;

      for (const edge of allEdges) {
        const srcMovable = movable.has(edge.source);
        const tgtMovable = movable.has(edge.target);

        let movedId: string | null = null;
        let anchorRect: Rect | null = null;
        if (srcMovable && !tgtMovable && untouchedRects.has(edge.target)) {
          movedId = edge.source;
          anchorRect = untouchedRects.get(edge.target)!;
        } else if (tgtMovable && !srcMovable && untouchedRects.has(edge.source)) {
          movedId = edge.target;
          anchorRect = untouchedRects.get(edge.source)!;
        }
        if (!movedId || !anchorRect) continue;

        const node = movable.get(movedId)!;
        const nodeCenterX = node.x + node.width / 2;
        const nodeCenterY = node.y + node.height / 2;
        const anchorCenterX = anchorRect.x + anchorRect.width / 2;
        const anchorCenterY = anchorRect.y + anchorRect.height / 2;

        const dxRaw = nodeCenterX - anchorCenterX;
        const dyRaw = nodeCenterY - anchorCenterY;
        const dist = Math.hypot(dxRaw, dyRaw) || 1;
        const desiredDist = (anchorRect.width + node.width) / 2 + ANCHOR_GAP;
        const desiredCenterX = anchorCenterX + (dxRaw / dist) * desiredDist;
        const desiredCenterY = anchorCenterY + (dyRaw / dist) * desiredDist;

        sumDx += desiredCenterX - nodeCenterX;
        sumDy += desiredCenterY - nodeCenterY;
        anchorCount += 1;
      }

      if (anchorCount > 0) {
        offsetX = sumDx / anchorCount;
        offsetY = sumDy / anchorCount;
      } else {
        // Nothing in the new group connects to existing content — place
        // the whole group clear of everything else instead of trusting
        // the model's guessed absolute coordinates.
        let minX = Infinity;
        let minY = Infinity;
        for (const r of movable.values()) {
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
        }
        let maxExistingX = -Infinity;
        let minExistingY = Infinity;
        for (const r of untouchedRects.values()) {
          maxExistingX = Math.max(maxExistingX, r.x + r.width);
          minExistingY = Math.min(minExistingY, r.y);
        }
        offsetX = maxExistingX + CLEAR_OF_EXISTING_GAP - minX;
        offsetY = minExistingY - minY;
      }
    }
    // else: canvas had no other (non-container) content — leave the AI's
    // own placement untouched (offsetX/offsetY stay 0).

    if (offsetX !== 0 || offsetY !== 0) {
      for (const r of movable.values()) {
        r.x += offsetX;
        r.y += offsetY;
      }
    }

    resolveOverlaps(movable, [...untouchedRects.values()]);

    for (const [id, rect] of movable) {
      const original = allRects.get(id)!;
      const x = Math.round(rect.x);
      const y = Math.round(rect.y);
      if (x !== original.x || y !== original.y) {
        result.set(id, { x, y });
      }
    }
  }

  // ---- Phase 2: auto-fit containers around their members ----
  if (containerNodeIds.size === 0) return result;

  // A regular node's final rect after phase 1: its settled position if it
  // moved, otherwise its original position — always with its original
  // width/height, since translation never resizes anything.
  function finalRectFor(id: string): Rect | undefined {
    const original = allRects.get(id);
    if (!original) return undefined;
    const settled = result.get(id);
    if (!settled) return original;
    return { x: settled.x, y: settled.y, width: original.width, height: original.height };
  }

  // Only refit a container if it's new this run, or at least one of its
  // members changed this run — a container nobody touched, whose members
  // also weren't touched, is left exactly as it is.
  const containersToFit = new Set<string>();
  for (const id of containerNodeIds) {
    if (touchedNodeIds.has(id)) containersToFit.add(id);
  }
  for (const [nodeId, containerId] of nodeContainerId) {
    if (touchedNodeIds.has(nodeId) && containerNodeIds.has(containerId)) {
      containersToFit.add(containerId);
    }
  }
  if (containersToFit.size === 0) return result;

  const membersByContainer = new Map<string, string[]>();
  for (const [nodeId, containerId] of nodeContainerId) {
    if (!containerNodeIds.has(containerId)) continue; // stale/unknown container reference
    if (!allRects.has(nodeId)) continue; // member was deleted this run
    const list = membersByContainer.get(containerId) ?? [];
    list.push(nodeId);
    membersByContainer.set(containerId, list);
  }

  // Fallback spot for a container with no members yet (e.g. addContainer
  // was called but nothing was assigned to it) — clear of everything
  // else already on the canvas, same idea as the no-anchor case above.
  let fallbackX: number | null = null;
  let fallbackY: number | null = null;
  {
    let maxX = -Infinity;
    let minY = Infinity;
    let any = false;
    for (const [id, r] of allRects) {
      if (containerNodeIds.has(id)) continue;
      maxX = Math.max(maxX, r.x + r.width);
      minY = Math.min(minY, r.y);
      any = true;
    }
    if (any) {
      fallbackX = maxX + CLEAR_OF_EXISTING_GAP;
      fallbackY = minY;
    }
  }

  for (const containerId of containersToFit) {
    const memberRects = (membersByContainer.get(containerId) ?? [])
      .map((id) => finalRectFor(id))
      .filter((r): r is Rect => Boolean(r));

    if (memberRects.length === 0) {
      const current = allRects.get(containerId);
      if (current && fallbackX !== null && fallbackY !== null) {
        result.set(containerId, {
          x: Math.round(fallbackX),
          y: Math.round(fallbackY),
          width: current.width,
          height: current.height,
        });
      }
      continue;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of memberRects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }

    result.set(containerId, {
      x: Math.round(minX - CONTAINER_PADDING_X),
      y: Math.round(minY - CONTAINER_PADDING_TOP),
      width: Math.round(maxX - minX + CONTAINER_PADDING_X * 2),
      height: Math.round(maxY - minY + CONTAINER_PADDING_TOP + CONTAINER_PADDING_BOTTOM),
    });
  }

  return result;
}

export const designAgent = task({
  id: "design-agent",
  retry: { maxAttempts: 2 },
  // Serializes runs that target the same room (concurrencyKey is passed
  // as roomId at trigger time — see app/api/ai/design/route.ts). Without
  // this, two prompts fired close together in the same room can both read
  // the canvas snapshot before either has written, so each computes a
  // layout with no knowledge of the other's new nodes and their results
  // can land on top of each other.
  queue: {
    concurrencyLimit: 1,
  },
  run: async (payload: { prompt: string; roomId: string; userId: string }) => {
    const lb = getLiveblocks();
    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    await lb
      .setPresence(payload.roomId, {
        userId: AI_USER_ID,
        data: { cursor: null, thinking: true },
        userInfo: AI_USER_INFO,
        ttl: 120_000,
      })
      .catch(() => {});

    await lb
      .broadcastEvent(payload.roomId, {
        type: "ai-status",
        message: "Ghost AI is analyzing your request…",
        status: "start",
      })
      .catch(() => {});

    try {
      // In-memory picture of the canvas, seeded once from a single
      // pre-generation read and kept in sync with every mutateStorage()
      // call this run makes as it happens. The settle pass never reads
      // storage again after this — see the note further down on why a
      // second read is unsafe to rely on.
      const liveNodes = new Map<string, Rect>();
      const liveEdges = new Map<string, SimpleEdge>();
      // Node ids that are containers (visual boundary boxes) rather than
      // regular shapes.
      const containerNodeIds = new Set<string>();
      // nodeId -> containerId, for every node (regular or container) that
      // currently declares container membership.
      const nodeContainerId = new Map<string, string>();

      let canvasContext = "The canvas is currently empty — create a fresh design.";
      try {
        const doc = await lb.getStorageDocument(payload.roomId, "json");
        const flow = (doc as Record<string, unknown>)?.flow as
          | {
              nodes?: Record<
                string,
                {
                  position?: { x: number; y: number };
                  width?: number;
                  height?: number;
                  data?: { isContainer?: boolean; containerId?: string };
                }
              >;
              edges?: Record<string, { id: string; source: string; target: string }>;
            }
          | undefined;

        for (const [id, nd] of Object.entries(flow?.nodes ?? {})) {
          if (!nd?.position) continue;
          liveNodes.set(id, {
            x: nd.position.x,
            y: nd.position.y,
            width: nd.width ?? SHAPE_DEFAULTS.rectangle.width,
            height: nd.height ?? SHAPE_DEFAULTS.rectangle.height,
          });
          if (nd.data?.isContainer) containerNodeIds.add(id);
          if (nd.data?.containerId) nodeContainerId.set(id, nd.data.containerId);
        }
        for (const edge of Object.values(flow?.edges ?? {})) {
          if (edge?.source && edge?.target) {
            liveEdges.set(edge.id, { id: edge.id, source: edge.source, target: edge.target });
          }
        }

        if (liveNodes.size > 0) {
          canvasContext = `Canvas has ${liveNodes.size} existing node(s). Current state:\n${JSON.stringify(
            { nodes: Object.fromEntries(liveNodes), edges: Object.fromEntries(liveEdges) },
            null,
            2
          )}\nExtend or modify based on the request; only clear if explicitly asked.`;
        }
      } catch {
        // No storage yet — treat as empty. All maps above stay empty,
        // which correctly represents a fresh canvas.
      }

      let appliedCount = 0;
      let summary = "Design applied to canvas.";

      // Tracks WHICH node ids this run touched (added, moved, resized,
      // relabeled/recolored, or had container membership changed) — the
      // ones the settle pass is allowed to move / use to decide which
      // containers need refitting.
      const touchedNodeIds = new Set<string>();

      const result = await generateText({
        model: google(process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite"),
        system: buildSystemPrompt(),
        prompt: `User request: ${payload.prompt}\n\n${canvasContext}`,
        tools: canvasTools,
        toolChoice: "required",
        onStepFinish: async (step) => {
          const calls = (step.toolCalls ?? []) as ToolCall[];

          for (const call of calls) {
            if (call.toolName === "finalizeDesign") {
              summary =
                (call.input as { summary?: string } | undefined)?.summary ?? summary;
              continue;
            }

            // Mirror this call's effect onto liveNodes/liveEdges (and the
            // container-tracking maps) in lockstep with the actual
            // storage mutation below, so the settle pass later has an
            // exact, race-free picture.
            switch (call.toolName) {
              case "addNode": {
                const { id, shape, x, y, containerId } = call.input as {
                  id: string;
                  shape: NodeShape;
                  x: number;
                  y: number;
                  containerId?: string;
                };
                const size = SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.rectangle;
                liveNodes.set(id, { x, y, width: size.width, height: size.height });
                touchedNodeIds.add(id);
                if (containerId) nodeContainerId.set(id, containerId);
                break;
              }
              case "addContainer": {
                const { id } = call.input as { id: string };
                // Placeholder geometry — phase 2 of the settle pass
                // overwrites this entirely based on the container's
                // members (or the "clear of existing content" fallback
                // if it ends up with none).
                liveNodes.set(id, {
                  x: 100,
                  y: 80,
                  width: CONTAINER_DEFAULTS.width,
                  height: CONTAINER_DEFAULTS.height,
                });
                touchedNodeIds.add(id);
                containerNodeIds.add(id);
                break;
              }
              case "moveNode": {
                const { id, x, y } = call.input as { id: string; x: number; y: number };
                const existing = liveNodes.get(id);
                liveNodes.set(id, {
                  x,
                  y,
                  width: existing?.width ?? SHAPE_DEFAULTS.rectangle.width,
                  height: existing?.height ?? SHAPE_DEFAULTS.rectangle.height,
                });
                touchedNodeIds.add(id);
                break;
              }
              case "resizeNode": {
                const { id, width, height } = call.input as {
                  id: string;
                  width: number;
                  height: number;
                };
                const existing = liveNodes.get(id);
                liveNodes.set(id, { x: existing?.x ?? 0, y: existing?.y ?? 0, width, height });
                touchedNodeIds.add(id);
                break;
              }
              case "updateNodeData": {
                const { id, containerId } = call.input as { id: string; containerId?: string };
                // Label/shape/color/containerId only — position and size
                // are untouched, so liveNodes already has the right rect.
                touchedNodeIds.add(id);
                if (containerId !== undefined) nodeContainerId.set(id, containerId);
                break;
              }
              case "deleteNode": {
                const { id } = call.input as { id: string };
                liveNodes.delete(id);
                touchedNodeIds.delete(id);
                containerNodeIds.delete(id);
                nodeContainerId.delete(id);
                break;
              }
              case "addEdge": {
                const { id, source, target } = call.input as {
                  id: string;
                  source: string;
                  target: string;
                };
                liveEdges.set(id, { id, source, target });
                break;
              }
              case "deleteEdge": {
                const { id } = call.input as { id: string };
                liveEdges.delete(id);
                break;
              }
            }

            await lb.mutateStorage(payload.roomId, ({ root }) => {
              const flow = root.get("flow");
              if (!flow) return;
              applyToolCall(call, flow.get("nodes"), flow.get("edges"));
            });

            appliedCount += 1;

            await lb
              .broadcastEvent(payload.roomId, {
                type: "ai-status",
                message: describeAction(call),
                status: "thinking",
              })
              .catch(() => {});
          }
        },
      });

      // --- Settle pass: translate this run's group into place, resolve
      // collisions, then auto-fit any containers around their members.
      // Uses liveNodes/liveEdges/containerNodeIds/nodeContainerId built
      // above — no storage read here, so nothing can be silently out of
      // date. ---
      if (touchedNodeIds.size > 0 || containerNodeIds.size > 0) {
        await lb
          .broadcastEvent(payload.roomId, {
            type: "ai-status",
            message: "Arranging layout…",
            status: "thinking",
          })
          .catch(() => {});

        const settled = computeSettledLayout(
          touchedNodeIds,
          liveNodes,
          [...liveEdges.values()],
          containerNodeIds,
          nodeContainerId
        );

        if (settled.size > 0) {
          await lb.mutateStorage(payload.roomId, ({ root }) => {
            const flow = root.get("flow");
            if (!flow) return;
            const nodes = flow.get("nodes");
            for (const [id, rect] of settled) {
              const n = nodes.get(id) as { set(k: string, v: unknown): void } | undefined;
              if (!n) continue;
              n.set("position", { x: rect.x, y: rect.y });
              if (rect.width !== undefined && rect.height !== undefined) {
                n.set("width", rect.width);
                n.set("height", rect.height);
              }
            }
          });
        }
      }

      await lb
        .broadcastEvent(payload.roomId, {
          type: "ai-status",
          message: summary,
          status: "complete",
        })
        .catch(() => {});

      return { success: true, actionsApplied: appliedCount, summary };
    } catch (error) {
      await lb
        .broadcastEvent(payload.roomId, {
          type: "ai-status",
          message: "Ghost AI encountered an error. Please try again.",
          status: "error",
        })
        .catch(() => {});
      throw error;
    } finally {
      await lb
        .setPresence(payload.roomId, {
          userId: AI_USER_ID,
          data: { cursor: null, thinking: false },
          userInfo: AI_USER_INFO,
          ttl: 3_000,
        })
        .catch(() => {});
    }
  },
});

type LiveNodeLike = { get(k: string): unknown; set(k: string, v: unknown): void };
type LiveMapLike<T> = {
  get(id: string): T | undefined;
  set(id: string, value: T): void;
  delete(id: string): boolean;
};

function applyToolCall(
  call: ToolCall,
  nodes: LiveMapLike<LiveblocksNode<CanvasNode>>,
  edges: LiveMapLike<LiveblocksEdge<CanvasEdge>>
) {
  const input = call.input;

  switch (call.toolName) {
    case "addNode": {
      const { id, label, shape, colorIndex, x, y, containerId } = input as {
        id: string;
        label: string;
        shape: NodeShape;
        colorIndex: number;
        x: number;
        y: number;
        containerId?: string;
      };
      const ci = clampColor(colorIndex);
      const color = NODE_COLORS[ci];
      const size = SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.rectangle;
      nodes.set(
        id,
        LiveObject.from(
          {
            id,
            type: "canvasNode",
            position: { x, y },
            data: {
              label,
              color: color.fill,
              textColor: color.text,
              shape,
              ...(containerId ? { containerId } : {}),
            },
            width: size.width,
            height: size.height,
          },
          NODE_SYNC_CONFIG
        ) as unknown as LiveblocksNode<CanvasNode>
      );
      break;
    }

    case "addContainer": {
      const { id, label, colorIndex } = input as {
        id: string;
        label: string;
        colorIndex: number;
      };
      const ci = clampColor(colorIndex);
      const color = NODE_COLORS[ci];
      nodes.set(
        id,
        LiveObject.from(
          {
            id,
            type: "canvasNode",
            // Placeholder — the settle pass's auto-fit step (phase 2 of
            // computeSettledLayout) overwrites both position and size
            // based on this container's members.
            position: { x: 100, y: 80 },
            data: { label, color: color.fill, textColor: color.text, isContainer: true },
            width: CONTAINER_DEFAULTS.width,
            height: CONTAINER_DEFAULTS.height,
            zIndex: CONTAINER_Z_INDEX,
          },
          NODE_SYNC_CONFIG
        ) as unknown as LiveblocksNode<CanvasNode>
      );
      break;
    }

    case "moveNode": {
      const { id, x, y } = input as { id: string; x: number; y: number };
      const n = nodes.get(id) as LiveNodeLike | undefined;
      if (n) n.set("position", { x, y });
      break;
    }

    case "resizeNode": {
      const { id, width, height } = input as { id: string; width: number; height: number };
      const n = nodes.get(id) as LiveNodeLike | undefined;
      if (n) {
        n.set("width", width);
        n.set("height", height);
      }
      break;
    }

    case "updateNodeData": {
      const { id, label, shape, colorIndex, containerId } = input as {
        id: string;
        label?: string;
        shape?: NodeShape;
        colorIndex?: number;
        containerId?: string;
      };
      const n = nodes.get(id) as LiveNodeLike | undefined;
      if (n) {
        const data = n.get("data") as LiveNodeLike | undefined;
        if (!data) break;
        if (label !== undefined) data.set("label", label);
        if (shape !== undefined) data.set("shape", shape);
        if (colorIndex !== undefined) {
          const ci = clampColor(colorIndex);
          data.set("color", NODE_COLORS[ci].fill);
          data.set("textColor", NODE_COLORS[ci].text);
        }
        if (containerId !== undefined) data.set("containerId", containerId);
      }
      break;
    }

    case "deleteNode": {
      const { id } = input as { id: string };
      nodes.delete(id);
      break;
    }

    case "addEdge": {
      const { id, source, target, label } = input as {
        id: string;
        source: string;
        target: string;
        label?: string;
      };
      edges.set(
        id,
        LiveObject.from(
          {
            id,
            type: "canvasEdge",
            source,
            target,
            sourceHandle: null as string | null,
            targetHandle: null as string | null,
            data: { label: label ?? "" },
            markerEnd: {
              type: "arrowclosed",
              color: "rgba(255,255,255,0.4)",
              width: 16,
              height: 16,
            },
          },
          EDGE_SYNC_CONFIG
        ) as unknown as LiveblocksEdge<CanvasEdge>
      );
      break;
    }

    case "deleteEdge": {
      const { id } = input as { id: string };
      edges.delete(id);
      break;
    }
  }
}