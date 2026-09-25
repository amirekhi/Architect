"use client"

import { useState } from "react"
import { RectangleHorizontal, Diamond, Circle, Pill, Cylinder, Hexagon, Frame } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { NODE_SHAPES, SHAPE_DEFAULTS, NODE_COLORS, CONTAINER_DEFAULTS, type NodeShape } from "@/types/canvas"

const SHAPE_ICONS: Record<NodeShape, LucideIcon> = {
  rectangle: RectangleHorizontal,
  diamond: Diamond,
  circle: Circle,
  pill: Pill,
  cylinder: Cylinder,
  hexagon: Hexagon,
}

const PREVIEW_FILL = NODE_COLORS[0].fill
const PREVIEW_TEXT = NODE_COLORS[0].text
const PREVIEW_STROKE = "rgba(255,255,255,0.3)"

// Distinct drag payload key from "application/ghost-shape" so onDrop in
// canvas-editor.tsx can tell a container apart from a regular shape
// without needing to fold "container" into the NodeShape enum (which
// would ripple into SHAPE_DEFAULTS, the SVG shape components, templates,
// and the AI's addNode tool schema — none of which should know about
// containers as a "shape").
const CONTAINER_DRAG_TYPE = "application/ghost-container"

function PreviewDiamond() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polygon points="50,0 100,50 50,100 0,50" fill={PREVIEW_FILL} stroke={PREVIEW_STROKE} strokeWidth="2" />
    </svg>
  )
}

function PreviewHexagon() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polygon points="25,0 75,0 100,50 75,100 25,100 0,50" fill={PREVIEW_FILL} stroke={PREVIEW_STROKE} strokeWidth="2" />
    </svg>
  )
}

function PreviewCylinder() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      <rect x="0" y="15" width="100" height="70" fill={PREVIEW_FILL} />
      <line x1="0" y1="15" x2="0" y2="85" stroke={PREVIEW_STROKE} strokeWidth="2" />
      <line x1="100" y1="15" x2="100" y2="85" stroke={PREVIEW_STROKE} strokeWidth="2" />
      <ellipse cx="50" cy="85" rx="50" ry="15" fill={PREVIEW_FILL} stroke={PREVIEW_STROKE} strokeWidth="2" />
      <ellipse cx="50" cy="15" rx="50" ry="15" fill={PREVIEW_FILL} stroke={PREVIEW_STROKE} strokeWidth="2" />
    </svg>
  )
}

function previewBorderRadius(shape: NodeShape): string {
  if (shape === "pill") return "9999px"
  if (shape === "circle") return "50%"
  return "12px"
}

function ShapePreview({ shape }: { shape: NodeShape }) {
  const { width, height } = SHAPE_DEFAULTS[shape]
  const isSvg = shape === "diamond" || shape === "hexagon" || shape === "cylinder"

  return (
    <div style={{ width, height, pointerEvents: "none" }}>
      {isSvg ? (
        <>
          {shape === "diamond" && <PreviewDiamond />}
          {shape === "hexagon" && <PreviewHexagon />}
          {shape === "cylinder" && <PreviewCylinder />}
        </>
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: PREVIEW_FILL,
            border: `1px solid ${PREVIEW_STROKE}`,
            borderRadius: previewBorderRadius(shape),
          }}
        />
      )}
    </div>
  )
}

function ContainerPreview() {
  const { width, height } = CONTAINER_DEFAULTS
  // Scaled down so the drag preview doesn't dwarf the cursor — the real
  // container is much larger once dropped.
  const scale = 0.45
  return (
    <div style={{ width: width * scale, height: height * scale, pointerEvents: "none" }}>
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 14,
          border: `1.5px dashed ${PREVIEW_TEXT}99`,
          background: `${PREVIEW_TEXT}14`,
        }}
      />
    </div>
  )
}

interface DragState {
  kind: "shape" | "container"
  shape?: NodeShape
  x: number
  y: number
}

export function ShapePanel() {
  const [drag, setDrag] = useState<DragState | null>(null)

  function handleShapeDragStart(event: React.DragEvent, shape: NodeShape) {
    const payload = JSON.stringify({ shape, size: SHAPE_DEFAULTS[shape] })
    event.dataTransfer.setData("application/ghost-shape", payload)
    event.dataTransfer.effectAllowed = "copy"
    setGhostDragImage(event)
    setDrag({ kind: "shape", shape, x: event.clientX, y: event.clientY })
  }

  function handleContainerDragStart(event: React.DragEvent) {
    const payload = JSON.stringify({ size: CONTAINER_DEFAULTS })
    event.dataTransfer.setData(CONTAINER_DRAG_TYPE, payload)
    event.dataTransfer.effectAllowed = "copy"
    setGhostDragImage(event)
    setDrag({ kind: "container", x: event.clientX, y: event.clientY })
  }

  function setGhostDragImage(event: React.DragEvent) {
    // Replace the default browser drag image with a transparent pixel —
    // we render our own preview below, following the cursor manually.
    const ghost = document.createElement("div")
    ghost.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;"
    document.body.appendChild(ghost)
    event.dataTransfer.setDragImage(ghost, 0, 0)
    setTimeout(() => document.body.removeChild(ghost), 0)
  }

  function handleDrag(event: React.DragEvent, kind: DragState["kind"], shape?: NodeShape) {
    // clientX/clientY are 0,0 on the final drag event before dragend — skip it
    if (event.clientX === 0 && event.clientY === 0) return
    setDrag({ kind, shape, x: event.clientX, y: event.clientY })
  }

  function handleDragEnd() {
    setDrag(null)
  }

  const previewSize =
    drag?.kind === "shape" && drag.shape ? SHAPE_DEFAULTS[drag.shape] : drag?.kind === "container" ? CONTAINER_DEFAULTS : null
  const previewScale = drag?.kind === "container" ? 0.45 : 1

  return (
    <>
      {drag && previewSize && (
        <div
          style={{
            position: "fixed",
            left: drag.x - (previewSize.width * previewScale) / 2,
            top: drag.y - (previewSize.height * previewScale) / 2,
            opacity: 0.65,
            pointerEvents: "none",
            zIndex: 9999,
          }}
        >
          {drag.kind === "container" ? <ContainerPreview /> : drag.shape ? <ShapePreview shape={drag.shape} /> : null}
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border-default bg-bg-surface/95 px-3 py-2 shadow-xl backdrop-blur-xl">
          {NODE_SHAPES.map((shape) => {
            const Icon = SHAPE_ICONS[shape]
            return (
              <button
                key={shape}
                draggable
                onDragStart={(e) => handleShapeDragStart(e, shape)}
                onDrag={(e) => handleDrag(e, "shape", shape)}
                onDragEnd={handleDragEnd}
                title={shape}
                className="flex h-8 w-8 cursor-grab items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary active:cursor-grabbing"
              >
                <Icon className="h-4 w-4" />
              </button>
            )
          })}

          <div className="mx-1 h-4 w-px bg-border-default" />

          <button
            draggable
            onDragStart={handleContainerDragStart}
            onDrag={(e) => handleDrag(e, "container")}
            onDragEnd={handleDragEnd}
            title="Container (VPC, subnet, boundary…)"
            className="flex h-8 w-8 cursor-grab items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary active:cursor-grabbing"
          >
            <Frame className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  )
}