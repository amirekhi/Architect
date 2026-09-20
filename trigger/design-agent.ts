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
- Edge IDs must be unique, e.g. "edge-api-auth", "edge-1"
- Node IDs must be unique short slugs, e.g. "api-gateway", "user-db", "auth-service"

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

export const designAgent = task({
  id: "design-agent",
  retry: { maxAttempts: 2 },
  run: async (payload: { prompt: string; roomId: string; userId: string }) => {
    const lb = getLiveblocks();
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_AI_API_KEY });

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

      const result = await generateText({
        model: google(process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite"),
        system: buildSystemPrompt(),
        prompt: `User request: ${payload.prompt}\n\n${canvasContext}`,
        tools: canvasTools,
        toolChoice: "required",
      });

      const toolCalls = result.steps.flatMap((s) => s.toolCalls) as ToolCall[];
      const actionCalls = toolCalls.filter((c) => c.toolName !== "finalizeDesign");
      const finalizeCall = toolCalls.find((c) => c.toolName === "finalizeDesign");
      const summary =
        (finalizeCall?.input as { summary?: string } | undefined)?.summary ??
        "Design applied to canvas.";

      const addCount = actionCalls.filter((c) => c.toolName === "addNode").length;
      await lb
        .broadcastEvent(payload.roomId, {
          type: "ai-status",
          message: `Placing ${addCount} node${addCount !== 1 ? "s" : ""} on the canvas…`,
          status: "thinking",
        })
        .catch(() => {});

      await lb.mutateStorage(payload.roomId, ({ root }) => {
        const flow = root.get("flow");
        if (!flow) return;
        const nodes = flow.get("nodes");
        const edges = flow.get("edges");

        for (const call of actionCalls) {
          applyToolCall(call, nodes, edges);
        }
      });

      await lb
        .broadcastEvent(payload.roomId, {
          type: "ai-status",
          message: summary,
          status: "complete",
        })
        .catch(() => {});

      return { success: true, actionsApplied: actionCalls.length, summary };
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
