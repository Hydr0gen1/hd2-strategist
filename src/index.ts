/**
 * Worker entry point. POST / or /mcp speaks MCP (JSON-RPC 2.0 over HTTP).
 * Headless: no UI, no other routes. No auth on the MCP endpoint in this
 * version (single-user, URL-based connection) — noted as a future extension.
 */
import { handleMcpRequest } from "./mcp";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isMcpPath = url.pathname === "/" || url.pathname === "/mcp";

    if (isMcpPath && request.method === "POST") {
      return handleMcpRequest(request, env);
    }
    if (isMcpPath && request.method === "GET") {
      return new Response(
        "hd2-strategist: Helldivers 2 Galactic War MCP server. POST JSON-RPC to this URL (MCP Streamable HTTP).",
        { headers: { "content-type": "text/plain" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
