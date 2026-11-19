import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

// Compiled alongside the collaboration sidecar so existing Workspace installs
// do not need to resolve npm dependencies at runtime.
export async function handleSelectionMcp(request, response, body, grant, call) {
  // The transport stays stateless. This grant-bound session ID carries only the
  // visible cursor identity, including across concurrent clients of one grant.
  const sessions = (grant.agentSessions ??= new Map());
  const key = request.headers["mcp-session-id"];
  let identity = sessions.get(key);
  if (body?.method === "initialize") {
    const info = body.params?.clientInfo;
    const visible = [info?.title, info?.name].filter(v=>typeof v==="string")
      .map(v=>Array.from(v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()).slice(0,48).join("")).find(Boolean);
    identity = {id:randomUUID(),name:visible || "外部助手",client:typeof info?.name==="string"?info.name.slice(0,80):""};
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
    sessions.set(identity.id,identity);
    response.setHeader("Mcp-Session-Id",identity.id);
  }
  const server = new McpServer({
    name: "officecli-selection",
    version: "1.0.0",
  });
  const register = (name, description, inputSchema, readOnly = false) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, openWorldHint: false },
      },
      async (args) => {
        try {
          const value = await call(grant, name, args, identity);
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: e.status ? e.message : "选区操作暂时不可用。",
              },
            ],
          };
        }
      },
    );
  register(
    "read_selection",
    "Read only the selected text spans or selected canvas objects from this host-issued grant.",
    z.strictObject({}),
    true,
  );
  const requestId = z
    .uuid()
    .describe("Unique patch ID. Reuse only for an exact retry.");
  if (grant.target.kind === "append") {
    register(
      "append_to_file",
      "Append a paragraph or a native canvas note in free space. Existing material is preserved.",
      z.strictObject({
        requestId,
        text: z.string().trim().min(1).max(6000),
        title: z.string().trim().max(90).optional(),
      }),
    );
  } else if (grant.target.kind === "sheet") {
    register(
      "edit_selected_cells",
      "Set literal values at selected worksheet addresses. Formula cells remain protected.",
      z.strictObject({
        requestId,
        edits: z
          .array(
            z.strictObject({
              address: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
              value: z.string().max(8000),
            }),
          )
          .min(1)
          .max(128),
      }),
    );
  } else if (grant.target.kind === "document" || grant.target.kind === "spec") {
    register(
      "replace_selected_text",
      "Replace selected text only. Supply one replacement per span in read_selection order. Surrounding content and paragraph formatting are preserved.",
      z.strictObject({
        requestId,
        replacements: z.array(z.string().max(16000)).min(1).max(64),
      }),
    );
  } else {
    const color = z.string().regex(/^#[0-9a-f]{6}$/i);
    register(
      "edit_canvas_selection",
      "Change text or color, or move selected canvas objects. IDs must come from read_selection. Positions use relative canvas units. For concurrent Spec edits, use specSplice with the block index, zero-based Unicode character offsets and exact text from the granted revision.",
      z.strictObject({
        requestId,
        edits: z
          .array(
            z.strictObject({
              id: z.string().min(1).max(256),
              text: z.string().max(8000).optional(),
              specSplice: z
                .strictObject({
                  block: z.number().int().nonnegative(),
                  start: z.number().int().nonnegative(),
                  end: z.number().int().nonnegative(),
                  expected: z.string().max(16000),
                  insert: z.string().max(8000),
                })
                .optional(),
              strokeColor: color.optional(),
              backgroundColor: color.optional(),
              dx: z.number().min(-10000).max(10000).optional(),
              dy: z.number().min(-10000).max(10000).optional(),
            }),
          )
          .min(1)
          .max(128),
      }),
    );
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once("close", () => {
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
