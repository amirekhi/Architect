import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
import { tasks } from "@trigger.dev/sdk/v3"
import type { designAgent } from "@/trigger/design-agent"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })

  const body: unknown = await request.json().catch(() => ({}))
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""
  const roomId = typeof b.roomId === "string" ? b.roomId.trim() : ""
  const projectId = typeof b.projectId === "string" ? b.projectId.trim() : ""

  if (!prompt || !roomId || !projectId) {
    return Response.json({ error: "Missing required fields" }, { status: 400 })
  }

  // concurrencyKey serializes design-agent runs that target the same
  // room. Without it, two prompts fired close together (two users, or one
  // user firing a second prompt before the first finishes) can both read
  // the canvas snapshot before either has written back, so each computes
  // a layout with no knowledge of the other's new nodes — the two results
  // can land on top of each other. Check this option's exact shape
  // against the installed @trigger.dev/sdk version if you upgrade; the
  // concurrency API has moved around between SDK versions.
  const handle = await tasks.trigger<typeof designAgent>(
    "design-agent",
    { prompt, roomId, userId },
    { concurrencyKey: roomId }
  )

  await prisma.taskRun.create({
    data: { runId: handle.id, projectId, userId },
  })

  return Response.json({ runId: handle.id }, { status: 201 })
}