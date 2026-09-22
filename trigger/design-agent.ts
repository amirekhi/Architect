import { task } from "@trigger.dev/sdk/v3";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool } from "ai";
import { z } from "zod";
import { LiveObject } from "@liveblocks/client";
import type { LiveblocksNode, LiveblocksEdge } from "@liveblocks/react-flow";
import { getLiveblocks } from "@/lib/liveblocks";
import { NODE_COLORS, SHAPE_DEFAULTS, NODE_SHAPES } from "@/types/canvas";
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

GENERATION RULES:
- Create 5-12 nodes; do not overcrowd
- Add edges to show data/request flow
- Prefer clear left→right or top→bottom flows
- When the canvas already has nodes, extend or modify instead of replacing unless asked

INSTRUCTIONS:
- Call addNode for each node you want to place on the canvas
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
    }),
  }),
  moveNode: tool({
    description: "Move an existing node to a new position",
    inputSchema: z.object({
      id: z.string().describe("ID of the node to move"),
      x: z.number(),
      y: z.number(),
    }),
  }),
  resizeNode: tool({
    description: "Resize an existing node",
    inputSchema: z.object({
      id: z.string(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  }),
  updateNodeData: tool({
    description: "Update the label, shape, or color of an existing node",
    inputSchema: z.object({
      id: z.string(),
      label: z.string().optional(),
      shape: z.enum(NODE_SHAPES).optional(),
      colorIndex: z.number().int().min(0).max(7).optional(),
    }),
  }),
  deleteNode: tool({
    description: "Delete a node from the canvas",
    inputSchema: z.object({
      id: z.string(),
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
// Earlier version of this pass ran dagre on every AI run and used dagre's
// own computed coordinates as the final layout. That was the wrong tool:
// dagre re-derives an entirely new rank-based arrangement from the edge
// graph alone, with no idea the model already placed nodes in sensible
// rows/columns — so it routinely produced a *worse* layout than what the
// model generated, and its output still needed heavy overlap clean-up
// afterward (which wasn't always enough within a fixed iteration budget).
//
// This version trusts the AI's own relative arrangement completely and
// only does two things to it:
//   1. Translates the whole new group as a single rigid unit into a valid
//      spot on the canvas (next to a connected existing node, or clear of
//      existing content if nothing connects to it). A single translation
//      cannot distort the model's internal layout, unlike per-node dagre
//      repositioning.
//   2. Runs a collision-resolution pass as a hard safety net — it nudges
//      apart any boxes that still overlap after the translation, whether
//      that's because the model's own layout had a rare overlap, or
//      because the translated group ended up too close to existing
//      content. It does not redesign the layout; it only removes overlap.

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SimpleEdge {
  id: string;
  source: string;
  target: string;
}

// Minimum enforced gap between any two node boxes, in canvas pixels.
const OVERLAP_MARGIN = 24;
// Preferred gap when anchoring a new group next to a connected existing
// node, or placing an unconnected group clear of existing content.
const ANCHOR_GAP = 220;
const CLEAR_OF_EXISTING_GAP = 160;

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
 * Settles this run's touched nodes onto the canvas by translating the
 * AI's own relative arrangement as a rigid group, then running a
 * collision safety net. Returns new positions only for nodes that moved.
 */
function computeSettledLayout(
  touchedNodeIds: Set<string>,
  allRects: Map<string, Rect>,
  allEdges: SimpleEdge[]
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (touchedNodeIds.size === 0) return result;

  const movable = new Map<string, Rect>();
  const untouchedRects = new Map<string, Rect>();
  for (const [id, rect] of allRects) {
    if (touchedNodeIds.has(id)) movable.set(id, { ...rect });
    else untouchedRects.set(id, rect);
  }
  if (movable.size === 0) return result;

  let offsetX = 0;
  let offsetY = 0;

  if (untouchedRects.size > 0) {
    // Look for edges connecting a moved/new node to an existing untouched
    // node — these become anchors. For each anchor edge, compute how far
    // the connected node would need to shift so it sits ANCHOR_GAP away
    // from the anchor, in whatever direction it's already roughly facing
    // (so "left of" stays left, "below" stays below). Average across all
    // anchor edges if there's more than one.
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
      // the whole group clear of everything else instead of trusting the
      // model's guessed absolute coordinates (which have no relationship
      // to where a prior run's content actually settled).
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
  // else: canvas had no other content — leave the AI's own placement
  // untouched (offsetX/offsetY stay 0).

  if (offsetX !== 0 || offsetY !== 0) {
    for (const r of movable.values()) {
      r.x += offsetX;
      r.y += offsetY;
    }
  }

  // Hard safety net, independent of everything above: no overlaps against
  // existing nodes, and no overlaps within the new group.
  resolveOverlaps(movable, [...untouchedRects.values()]);

  for (const [id, rect] of movable) {
    const original = allRects.get(id)!;
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    if (x !== original.x || y !== original.y) {
      result.set(id, { x, y });
    }
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
      let canvasContext = "The canvas is currently empty — create a fresh design.";
      try {
        const doc = await lb.getStorageDocument(payload.roomId, "json");
        const flow = (doc as Record<string, unknown>)?.flow as
          | Record<string, unknown>
          | undefined;
        const nodeCount = flow?.nodes ? Object.keys(flow.nodes as object).length : 0;
        if (nodeCount > 0) {
          canvasContext = `Canvas has ${nodeCount} existing node(s). Current state:\n${JSON.stringify(flow, null, 2)}\nExtend or modify based on the request; only clear if explicitly asked.`;
        }
      } catch {
        // No storage yet — treat as empty
      }

      let appliedCount = 0;
      let summary = "Design applied to canvas.";

      // Only tracks WHICH node ids this run touched (added, moved,
      // resized, relabeled/recolored). Their actual positions/sizes are
      // read straight from storage after all tool calls are applied —
      // see the settle pass below — rather than tracked by hand here,
      // which removes a whole class of bugs where our own bookkeeping
      // could drift from what was actually written to storage.
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

            switch (call.toolName) {
              case "addNode":
              case "moveNode":
              case "resizeNode":
              case "updateNodeData": {
                const { id } = call.input as { id: string };
                touchedNodeIds.add(id);
                break;
              }
              case "deleteNode": {
                const { id } = call.input as { id: string };
                touchedNodeIds.delete(id);
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

      // --- Settle pass: translate this run's group into place, then
      // guarantee no overlaps. Reads the whole canvas fresh from storage
      // now that every tool call above has been applied, so positions,
      // sizes, and edges are all ground truth rather than hand-tracked. ---
      if (touchedNodeIds.size > 0) {
        await lb
          .broadcastEvent(payload.roomId, {
            type: "ai-status",
            message: "Arranging layout…",
            status: "thinking",
          })
          .catch(() => {});

        const allRects = new Map<string, Rect>();
        const allEdges: SimpleEdge[] = [];
        try {
          const doc = await lb.getStorageDocument(payload.roomId, "json");
          const flow = (doc as Record<string, unknown>)?.flow as
            | {
                nodes?: Record<
                  string,
                  { position?: { x: number; y: number }; width?: number; height?: number }
                >;
                edges?: Record<string, { id: string; source: string; target: string }>;
              }
            | undefined;

          for (const [id, nd] of Object.entries(flow?.nodes ?? {})) {
            if (!nd?.position) continue;
            allRects.set(id, {
              x: nd.position.x,
              y: nd.position.y,
              width: nd.width ?? SHAPE_DEFAULTS.rectangle.width,
              height: nd.height ?? SHAPE_DEFAULTS.rectangle.height,
            });
          }

          for (const edge of Object.values(flow?.edges ?? {})) {
            if (edge?.source && edge?.target) {
              allEdges.push({ id: edge.id, source: edge.source, target: edge.target });
            }
          }
        } catch {
          // Couldn't read storage back — skip the settle pass rather than
          // risk operating on an incomplete/incorrect picture of the
          // canvas. Nodes keep the positions the model itself chose.
        }

        if (allRects.size > 0) {
          const settled = computeSettledLayout(touchedNodeIds, allRects, allEdges);

          if (settled.size > 0) {
            await lb.mutateStorage(payload.roomId, ({ root }) => {
              const flow = root.get("flow");
              if (!flow) return;
              const nodes = flow.get("nodes");
              for (const [id, position] of settled) {
                const n = nodes.get(id) as { set(k: string, v: unknown): void } | undefined;
                if (n) n.set("position", position);
              }
            });
          }
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
      const { id, label, shape, colorIndex, x, y } = input as {
        id: string;
        label: string;
        shape: NodeShape;
        colorIndex: number;
        x: number;
        y: number;
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
            data: { label, color: color.fill, textColor: color.text, shape },
            width: size.width,
            height: size.height,
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
      const { id, label, shape, colorIndex } = input as {
        id: string;
        label?: string;
        shape?: NodeShape;
        colorIndex?: number;
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