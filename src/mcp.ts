/**
 * Minimal MCP server over HTTP: JSON-RPC 2.0 handling for initialize,
 * tools/list, and tools/call (plus ping and client notifications).
 * Hand-rolled — no SDK — to stay within the Workers free-tier CPU budget.
 */
import { UpstreamError } from "./client";
import {
  ToolError,
  getCampaigns,
  getMajorOrder,
  getPlanet,
  getWarStatus,
} from "./tools";
import type { Env } from "./types";

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const TOOL_DEFINITIONS = [
  {
    name: "get_war_status",
    description:
      "Overall Galactic War state: active fronts grouped by enemy faction, total planets in play, war timing, and global statistics.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_campaigns",
    description:
      "All active campaigns with strategy-ready, invariant-normalized data: raw_hp (primary field), max_hp, signed hp_per_hour, cosmetic liberation_pct_display_only, faction, planet, campaign type/kind, and trajectory flags (direction, stabilizing, hpc).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_major_order",
    description:
      "Current Major Order: objectives with per-objective progress, rewards, and time remaining (seconds + human-readable).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_planet",
    description:
      "Deep dive on one planet by index or name: raw HP, regen/decay (defense decay is always null — it is cosmetic), signed hp_per_hour, hours_to_resolution projection derived from raw HP (never from liberation %), and direction flag.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number", description: "Planet index (e.g. 175)" },
        name: {
          type: "string",
          description: "Planet name, case-insensitive (e.g. \"Grand Errant\")",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function dispatchTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_war_status":
      return toolText(await getWarStatus(env));
    case "get_campaigns":
      return toolText(await getCampaigns(env));
    case "get_major_order":
      return toolText(await getMajorOrder(env));
    case "get_planet":
      return toolText(
        await getPlanet(env, {
          index: typeof args.index === "number" ? args.index : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
        }),
      );
    default:
      return null;
  }
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  let rpc: JsonRpcRequest;
  try {
    rpc = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error: request body is not valid JSON.");
  }

  const id = rpc.id ?? null;
  const method = rpc.method ?? "";
  const params = rpc.params ?? {};

  // Notifications (no id) get an empty 202 per the MCP HTTP transport.
  if (rpc.id === undefined && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: "hd2-strategist",
          version: "0.1.0",
          title: "Strategist — Helldivers 2 Galactic War correctness layer",
        },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFINITIONS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await dispatchTool(env, name, args);
        if (result === null) {
          return rpcError(id, -32602, `Unknown tool: "${name}".`);
        }
        return rpcResult(id, result);
      } catch (err) {
        if (err instanceof ToolError || err instanceof UpstreamError) {
          return rpcResult(id, toolText({ error: err.message }, true));
        }
        return rpcResult(
          id,
          toolText({ error: "Internal error while executing the tool." }, true),
        );
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: "${method}".`);
  }
}
