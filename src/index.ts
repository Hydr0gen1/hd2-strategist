/**
 * Worker entry point. POST / or /mcp speaks MCP (JSON-RPC 2.0 over HTTP).
 * Headless: no UI, no other routes. No auth on the MCP endpoint in this
 * version (single-user, URL-based connection) — noted as a future extension.
 */
import { handleMcpRequest } from "./mcp";
import { runScheduledSample } from "./tools";
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

  /**
   * Cron Trigger entry (schedule in wrangler.toml [triggers]; Cloudflare
   * cron always evaluates in UTC). Drives the SAME sampling path a
   * request-driven poll does, so the accumulation layers (planet history,
   * global statistics, observed signatures) advance on a fixed schedule
   * without user traffic. runScheduledSample never throws — an upstream
   * failure during a tick is swallowed and the next tick retries.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runScheduledSample(env);
  },
} satisfies ExportedHandler<Env>;
