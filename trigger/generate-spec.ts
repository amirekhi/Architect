import { schemaTask, metadata, logger } from "@trigger.dev/sdk/v3"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText } from "ai"
import { z } from "zod"
import { put } from "@vercel/blob"
import { prisma } from "@/lib/prisma"

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
})

const nodeDataSchema = z
  .object({
    label: z.string().optional(),
    shape: z.string().optional(),
    color: z.string().optional(),
  })
  .passthrough()

const nodeSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: nodeDataSchema.optional(),
  })
  .passthrough()

const edgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    data: z.object({ label: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()

const payloadSchema = z.object({
  projectId: z.string(),
  roomId: z.string(),
  chatHistory: z.array(chatMessageSchema),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
})

type Node = z.infer<typeof nodeSchema>
type Edge = z.infer<typeof edgeSchema>
type ChatMessage = z.infer<typeof chatMessageSchema>

function buildContext(nodes: Node[], edges: Edge[], chatHistory: ChatMessage[]): string {
  const nodeLines = nodes
    .map((n) => {
      const label = n.data?.label ?? n.id
      const shape = n.data?.shape ?? "rectangle"
      const pos = n.position ? ` at (${Math.round(n.position.x)}, ${Math.round(n.position.y)})` : ""
      return `- ${label} (id: ${n.id}, shape: ${shape}${pos})`
    })
    .join("\n")

  const edgeLines = edges
    .map((e) => {
      const label = e.data?.label ? ` [${e.data.label}]` : ""
      return `- ${e.source} → ${e.target}${label}`
    })
    .join("\n")

  const chatLines = chatHistory
    .map((m) => `${m.role === "user" ? "User" : "Ghost AI"}: ${m.content}`)
    .join("\n")

  return [
    "## Canvas Nodes",
    nodeLines || "(none)",
    "",
    "## Canvas Connections",
    edgeLines || "(none)",
    "",
    "## Chat History",
    chatLines || "(none)",
  ].join("\n")
}

const SYSTEM_PROMPT = `You are Ghost AI, a senior technical architect. Generate a comprehensive Markdown technical specification document based on the provided architecture canvas and conversation context.

Structure the spec as follows:
1. **Overview** — What the system does and its key goals
2. **Architecture** — High-level architecture description based on the canvas
3. **Components** — Each node/service with its role and responsibilities
4. **Data Flow** — How data and requests move through the system
5. **Technology Choices** — Suggested technologies that fit the architecture
6. **Key Considerations** — Scalability, security, and performance notes

Write in clear, professional technical language. Use Markdown headers, bullet points, and code blocks where appropriate. Be specific and actionable.`

export const generateSpec = schemaTask({
  id: "generate-spec",
  schema: payloadSchema,
  retry: { maxAttempts: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
  run: async (payload) => {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_AI_API_KEY })

    metadata.set("status", "starting")
    logger.info("Generating spec", {
      projectId: payload.projectId,
      nodeCount: payload.nodes.length,
      edgeCount: payload.edges.length,
    })

    metadata.set("status", "generating")

    const context = buildContext(payload.nodes, payload.edges, payload.chatHistory)

    const result = await generateText({
      model: google(process.env.GEMINI_SPEC_MODEL ?? "gemini-3.1-flash-lite"),
      system: SYSTEM_PROMPT,
      prompt: context,
    })

    const spec = result.text

    metadata.set("status", "uploading")

    const blob = await put(
      `specs/${payload.projectId}/${Date.now()}.md`,
      spec,
      {
        access: "private",
        contentType: "text/markdown",
        addRandomSuffix: false,
        allowOverwrite: true,
      }
    )

    const record = await prisma.projectSpec.create({
      data: {
        projectId: payload.projectId,
        filePath: blob.url,
      },
    })

    metadata.set("status", "complete")
    metadata.set("specLength", spec.length)
    metadata.set("specId", record.id)
    logger.info("Spec generated and saved", { length: spec.length, specId: record.id })

    return { spec, specId: record.id }
  },
})
