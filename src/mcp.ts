/**
 * Minimal MCP server over HTTP: JSON-RPC 2.0 handling for initialize,
 * tools/list, and tools/call (plus ping and client notifications).
 * Hand-rolled — no SDK — to stay within the Workers free-tier CPU budget.
 */
import { UpstreamError } from "./client";
import {
  ToolError,
  getCampaigns,
  getDispatches,
  getMajorOrder,
  getPatchNotes,
  getPlanet,
  getPlanetHistory,
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
      "All active campaigns with strategy-ready, invariant-normalized data: raw_hp (primary field), max_hp, signed hp_per_hour, cosmetic liberation_pct_display_only, faction, planet, campaign type/kind, and trajectory flags (direction, stabilizing, hpc). Each campaign also carries per-planet statistics (players, mission wins/losses + derived success rate, kills), biome, hazards, and — on defense campaigns — defense_started_at / defense_ends_at / defense_hours_remaining.",
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
      "Deep dive on one planet by index or name: raw HP, regen/decay (defense decay is always null — it is cosmetic), signed hp_per_hour, hours_to_resolution projection derived from raw HP (never from liberation %), direction flag, per-planet statistics (players, mission wins/losses + derived success rate, kills), biome, environmental hazards, and defense timing (defense_ends_at / defense_hours_remaining) when a defense event is active.",
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
  {
    name: "get_dispatches",
    description:
      "Recent in-fiction war news dispatches, newest first: id, published timestamp, type, and the message exactly as upstream sends it (may contain in-game markup).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max dispatches to return (default 10, cap 25).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_patch_notes",
    description:
      "Recent Helldivers 2 Steam news / patch notes, newest first: title, author, published timestamp, url, and the full announcement content as verbatim Steam BBCode (no server-side summary or formatting).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max entries to return (default 5, cap 10).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_planet_history",
    description:
      "Observed health time-series for one planet (by index or name), sampled by this server: retained data points with per-point delta_health / delta_hours between consecutive samples. Observed values and deterministic deltas only — no forecasts or trend labels. Sparse or empty series (insufficient_history: true) is expected on cold start or for planets without an active campaign.",
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
    case "get_dispatches":
      return toolText(
        await getDispatches(env, {
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      );
    case "get_patch_notes":
      return toolText(
        await getPatchNotes(env, {
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      );
    case "get_planet_history":
      return toolText(
        await getPlanetHistory(env, {
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
