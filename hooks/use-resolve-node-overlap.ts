"use client"

import { useMutation } from "@liveblocks/react"

// Must match the margin used server-side in trigger/design-agent.ts so the
// AI settle pass and manual drag/resize enforce the same minimum gap.
const OVERLAP_MARGIN = 24

/**
 * Returns a Liveblocks mutation that nudges a single node away from any
 * other node it currently overlaps, using its live position/size in
 * storage. Call this after a drag or resize ends.
 *
 * This exists because the AI settle pass (trigger/design-agent.ts) only
 * guarantees no-overlap at the moment it runs — nothing else on the canvas
 * enforces that invariant afterward. A manual drag or resize by any
 * collaborator can reintroduce overlap with zero layout code involved,
 * which is the most common source of "why is there still overlap"
 * reported after the AI-side fix.
 *
 * This is intentionally a simple greedy resolver (one moved node against
 * many fixed ones), not the accumulated-delta solver used server-side —
 * for a single node reacting to a single user action, greedy converges in
 * one pass and stays cheap enough to run on every drag/resize end.
 */
// `node` here is the raw storage LiveObject for a node — NOT the plain
// CanvasNode object React Flow hands you elsewhere. Its "data" field is
// itself a nested LiveObject (the same pattern canvas-node.tsx's own
// label/color mutations rely on: `.get("data").set("label", ...)`), so
// reading a field off it means `.get("isContainer")`, not a direct
// property access — `data.isContainer` on a LiveObject is always
// `undefined` since LiveObjects don't expose their fields as plain
// properties. Reading it as a plain object silently made this check
// always return false, which meant containers were still being treated
// as solid obstacles: any node dragged near or into one got pushed back
// out, and the container itself got pushed by anything overlapping it.
function isContainerNode(node: { get(k: string): unknown }): boolean {
  const data = node.get("data") as { get(k: string): unknown } | undefined
  if (!data) return false
  return Boolean(data.get("isContainer"))
}

export function useResolveNodeOverlap() {
  return useMutation(({ storage }, nodeId: string) => {
    const nodesMap = storage.get("flow").get("nodes")
    const moved = nodesMap.get(nodeId)
    if (!moved) return

    // Containers are a visual grouping, not an obstacle — a container is
    // *meant* to overlap the nodes placed inside it, so it never
    // participates in collision correction in either direction: dragging
    // or resizing a container should never trigger a push, and other
    // nodes should never be pushed away by a container either.
    if (isContainerNode(moved)) return

    const pos = moved.get("position") as { x: number; y: number } | undefined
    if (!pos) return

    const w = (moved.get("width") as number | undefined) ?? 160
    const h = (moved.get("height") as number | undefined) ?? 80
    let mx = pos.x
    let my = pos.y

    for (const [id, other] of nodesMap.entries()) {
      if (id === nodeId) continue
      if (isContainerNode(other)) continue

      const op = other.get("position") as { x: number; y: number } | undefined
      if (!op) continue

      const ow = (other.get("width") as number | undefined) ?? 160
      const oh = (other.get("height") as number | undefined) ?? 80

      const overlaps =
        mx < op.x + ow + OVERLAP_MARGIN &&
        mx + w + OVERLAP_MARGIN > op.x &&
        my < op.y + oh + OVERLAP_MARGIN &&
        my + h + OVERLAP_MARGIN > op.y

      if (!overlaps) continue

      const pushRight = op.x + ow + OVERLAP_MARGIN - mx
      const pushLeft = mx + w + OVERLAP_MARGIN - op.x
      const pushDown = op.y + oh + OVERLAP_MARGIN - my
      const pushUp = my + h + OVERLAP_MARGIN - op.y
      const minX = Math.min(pushRight, pushLeft)
      const minY = Math.min(pushDown, pushUp)

      if (minX < minY) {
        mx += pushRight < pushLeft ? pushRight : -pushLeft
      } else {
        my += pushDown < pushUp ? pushDown : -pushUp
      }
    }

    if (mx !== pos.x || my !== pos.y) {
      moved.set("position", { x: mx, y: my })
    }
  }, [])
}