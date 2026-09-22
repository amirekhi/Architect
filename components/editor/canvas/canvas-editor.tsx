"use client"

import { useCallback, useEffect, useRef } from "react"
import { useMyPresence } from "@liveblocks/react"
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ConnectionMode,
  ConnectionLineType,
  MarkerType,
  useNodes,
  useEdges,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useReactFlow } from "@xyflow/react"
import type { Connection } from "@xyflow/react"
import { useLiveblocksFlow } from "@liveblocks/react-flow"
import { useUndo, useRedo, useCanUndo, useCanRedo } from "@liveblocks/react"
import type { CanvasNode, CanvasEdge, NodeShape } from "@/types/canvas"
import { NODE_COLORS } from "@/types/canvas"
import { CanvasNodeComponent } from "@/components/editor/canvas/canvas-node"
import { CanvasEdgeComponent } from "@/components/editor/canvas/canvas-edge"
import { ShapePanel } from "@/components/editor/canvas/shape-panel"
import { CanvasControls } from "@/components/editor/canvas/canvas-controls"
import { PresenceCursors } from "@/components/editor/canvas/presence-cursors"
import { CollaboratorAvatars } from "@/components/editor/canvas/collaborator-avatars"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import { useResolveNodeOverlap } from "@/hooks/use-resolve-node-overlap"
import type { CanvasTemplate } from "@/components/editor/starter-templates"
import { useCanvasAutosave, type SaveStatus } from "@/hooks/use-canvas-autosave"

const nodeTypes = { canvasNode: CanvasNodeComponent }
const edgeTypes = { canvasEdge: CanvasEdgeComponent }

const CONNECTION_LINE_STYLE: React.CSSProperties = {
  stroke: "rgba(255,255,255,0.4)",
  strokeWidth: 1.5,
  strokeLinecap: "round",
}

let nodeCounter = 0
let edgeCounter = 0

function generateNodeId(shape: string): string {
  return `${shape}-${Date.now()}-${++nodeCounter}`
}

function generateEdgeId(): string {
  return `edge-${Date.now()}-${++edgeCounter}`
}

interface CanvasEditorProps {
  projectId: string
  pendingTemplate?: CanvasTemplate | null
  onTemplateImported?: () => void
  onSaveStatusChange?: (status: SaveStatus) => void
  onSaveReady?: (saveFn: () => void) => void
}

export function CanvasEditor({ projectId, pendingTemplate, onTemplateImported, onSaveStatusChange, onSaveReady }: CanvasEditorProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onDelete } =
    useLiveblocksFlow<CanvasNode, CanvasEdge>({ suspense: true })

  const reactFlow = useReactFlow()
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = reactFlow
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Keep stable refs to the latest nodes/edges so the import effect
  // can read current state without being in its dependency array.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)

  useEffect(() => {
    nodesRef.current = nodes
    edgesRef.current = edges
  })

  useEffect(() => {
    if (!pendingTemplate) return
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current

    onNodesChange([
      ...currentNodes.map((nd) => ({ type: "remove" as const, id: nd.id })),
      ...pendingTemplate.nodes.map((nd) => ({ type: "add" as const, item: nd })),
    ])
    onEdgesChange([
      ...currentEdges.map((ed) => ({ type: "remove" as const, id: ed.id })),
      ...pendingTemplate.edges.map((ed) => ({ type: "add" as const, item: ed })),
    ])

    onTemplateImported?.()
    setTimeout(() => fitView({ duration: 300 }), 120)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTemplate])

  // Load saved canvas from Vercel Blob when room is empty on first mount.
  const didLoadRef = useRef(false)
  useEffect(() => {
    if (didLoadRef.current) return
    didLoadRef.current = true

    if (nodesRef.current.length > 0 || edgesRef.current.length > 0) return

    fetch(`/api/projects/${projectId}/canvas`)
      .then((res) => res.json())
      .then(({ canvas }: { canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null }) => {
        if (!canvas) return
        if (canvas.nodes?.length) {
          onNodesChange(canvas.nodes.map((nd) => ({ type: "add" as const, item: nd })))
        }
        if (canvas.edges?.length) {
          onEdgesChange(canvas.edges.map((ed) => ({ type: "add" as const, item: ed })))
        }
        setTimeout(() => fitView({ duration: 300 }), 120)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { status: saveStatus, save } = useCanvasAutosave(projectId, nodes, edges)

  useEffect(() => { onSaveStatusChange?.(saveStatus) }, [saveStatus, onSaveStatusChange])
  useEffect(() => { onSaveReady?.(save) }, [save, onSaveReady])

  // Delete selected nodes/edges on Delete or Backspace via Liveblocks mutation helpers.
  const rfNodes = useNodes<CanvasNode>()
  const rfEdges = useEdges<CanvasEdge>()
  const rfNodesRef = useRef(rfNodes)
  const rfEdgesRef = useRef(rfEdges)
  useEffect(() => {
    rfNodesRef.current = rfNodes
    rfEdgesRef.current = rfEdges
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return
      const target = e.target as HTMLElement
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return
      const selNodes = rfNodesRef.current.filter((n) => n.selected)
      const selEdges = rfEdgesRef.current.filter((ed) => ed.selected)
      if (selNodes.length || selEdges.length) onDelete({ nodes: selNodes, edges: selEdges })
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onDelete])

  const [, updateMyPresence] = useMyPresence()

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      updateMyPresence({ cursor: screenToFlowPosition({ x: event.clientX, y: event.clientY }) })
    },
    [screenToFlowPosition, updateMyPresence]
  )

  const onMouseLeave = useCallback(() => {
    updateMyPresence({ cursor: null })
  }, [updateMyPresence])

  const undo = useUndo()
  const redo = useRedo()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()

  useKeyboardShortcuts({ reactFlow, undo, redo })

  // Client-side collision correction. This is what keeps the canvas
  // overlap-free *between* AI runs — the AI's own settle pass only
  // guarantees no-overlap at the instant it finishes; a manual drag can
  // undo that guarantee with no server involvement, so we re-check here.
  const resolveNodeOverlap = useResolveNodeOverlap()

  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: CanvasNode) => {
      resolveNodeOverlap(node.id)
    },
    [resolveNodeOverlap]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      onEdgesChange([
        {
          type: "add",
          item: {
            id: generateEdgeId(),
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle ?? null,
            targetHandle: connection.targetHandle ?? null,
            type: "canvasEdge",
            data: { label: "" },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "rgba(255,255,255,0.4)",
              width: 16,
              height: 16,
            },
          } as CanvasEdge,
        },
      ])
    },
    [onEdgesChange]
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const raw = event.dataTransfer.getData("application/ghost-shape")
      if (!raw) return

      let payload: { shape: NodeShape; size: { width: number; height: number } }
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }

      const center = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const position = {
        x: center.x - payload.size.width / 2,
        y: center.y - payload.size.height / 2,
      }

      const id = generateNodeId(payload.shape)
      const newNode: CanvasNode = {
        id,
        type: "canvasNode",
        position,
        data: { label: "", color: NODE_COLORS[0].fill, textColor: NODE_COLORS[0].text, shape: payload.shape },
        width: payload.size.width,
        height: payload.size.height,
      }

      onNodesChange([{ type: "add", item: newNode }])
    },
    [screenToFlowPosition, onNodesChange]
  )

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={CONNECTION_LINE_STYLE}
        connectionLineType={ConnectionLineType.SmoothStep}
        className="bg-bg-base"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.5}
          color="var(--color-border-subtle)"
        />
      </ReactFlow>
      <CanvasControls
        onZoomIn={() => zoomIn({ duration: 200 })}
        onZoomOut={() => zoomOut({ duration: 200 })}
        onFitView={() => fitView({ duration: 200 })}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <ShapePanel />
      <PresenceCursors />
      <CollaboratorAvatars />
      <SaveStatusIndicator status={saveStatus} />
    </div>
  )
}

function SaveStatusIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return null
  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2">
      <span
        className={
          "rounded-full px-3 py-1 text-xs font-medium " +
          (status === "saving"
            ? "bg-bg-elevated text-text-faint"
            : status === "saved"
            ? "bg-bg-elevated text-text-secondary"
            : "bg-bg-elevated text-red-400")
        }
      >
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Save failed"}
      </span>
    </div>
  )
}