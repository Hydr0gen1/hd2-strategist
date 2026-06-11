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
  getGlobalHistory,
  getMajorOrder,
  getMajorOrderHistory,
  getObservedSignatures,
  getPatchNotes,
  getPlanet,
  getPlanetHistory,
  getPlanetWiki,
  getWarBrief,
  getWarStatus,
  resolvePlanetTool,
} from "./tools";
import { WikiError } from "./wikiClient";
import type { Env } from "./types";

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const TOOL_DEFINITIONS = [
  {
    name: "get_war_brief",
    description:
      "Single-call war digest: the current Major Order joined with the live trajectory of exactly its target planets (raw_hp, signed hp_per_hour, direction, stabilizing, hpc, decay_per_hour, player_count), per-faction front rollups, any active special events, and global totals — a pre-joined assembly of the same normalized facts get_war_status / get_campaigns / get_major_order return, with freshness metadata. Pure assembly: no recommended target, no ranking, no verdict. Use this first for \"what's the state of the war?\".",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_war_status",
    description:
      "Overall Galactic War state: active fronts grouped by enemy faction, total planets in play, war timing, global statistics, plus deterministic faction and sector rollups (planets owned, active campaigns, the same per-front net hp_per_hour aggregate, known player-count sums, per-sector owner tallies) — counts and sums over fetched data, never a verdict.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_campaigns",
    description:
      "All active campaigns with strategy-ready, invariant-normalized data: raw_hp (primary field), max_hp, signed hp_per_hour, cosmetic liberation_pct_display_only, faction, planet, campaign type/kind, and trajectory flags (direction, stabilizing, hpc). Each campaign also carries per-planet statistics (players, mission wins/losses + derived success rate, kills), biome, hazards, Major Order membership (is_major_order_target / major_order_id — a pure join, not a priority score), and — on defense campaigns — defense_started_at / defense_ends_at / defense_hours_remaining. Optional AND-combined filters narrow the returned subset (filtered_count vs total_count states coverage); no args returns all campaigns.",
    inputSchema: {
      type: "object",
      properties: {
        faction: {
          type: "string",
          description:
            'Only campaigns on this faction\'s front (e.g. "Terminids", "Automaton", "Illuminate"); matched case-insensitively against the campaign faction.',
        },
        major_order_only: {
          type: "boolean",
          description: "Only campaigns whose planet is a current Major Order target.",
        },
        has_rate: {
          type: "boolean",
          description:
            "Only campaigns with a non-null hp_per_hour (excludes cold-start/unsampled planets).",
        },
        hpc_only: {
          type: "boolean",
          description: "Only High Priority Campaigns (hpc: true).",
        },
      },
      additionalProperties: false,
    },
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
      "Deep dive on one planet by index or name: raw HP, regen/decay (defense decay is always null — it is cosmetic), signed hp_per_hour, hours_to_resolution projection derived from raw HP (never from liberation %), direction flag, per-planet statistics (players, mission wins/losses + derived success rate, kills), biome, environmental hazards, defense timing (defense_ends_at / defense_hours_remaining) when a defense event is active, and waypoint neighbor context: neighbors (joined name/owner/campaign per upstream waypoint), neighbor_summary counts, and the frontline adjacency fact (borders territory of a different owner).",
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
      "Observed health time-series for one planet (by index or name), sampled by this server: retained data points with per-point delta_health / delta_hours between consecutive samples, plus observed-only aggregates (rate_min / rate_max / rate_mean / latest_rate over per-interval rates, samples_span_hours). Observed values and deterministic deltas only — no forecasts or trend labels. Sparse or empty series (insufficient_history: true) is expected on cold start or for planets without an active campaign.",
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
    name: "get_planet_wiki",
    description:
      "Community wiki LORE entry (helldivers.wiki.gg) for a planet or topic — what something means, not what is happening. Returns the plain-text lead extract, canonical page URL, and mandatory attribution (CC BY-NC-SA 4.0). A separate, non-authoritative source: community-authored background only; the live tools (get_planet, get_campaigns, get_war_status) remain authoritative for current war state. Also serves enemy/subfaction lookups like \"Jet Brigade\", \"Predator Strain\", or \"Hive Lord\" via the title argument.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Planet name as the live tools return it (case-insensitive; resolved to the wiki's title casing).",
        },
        title: {
          type: "string",
          description:
            'Explicit wiki page title, tried verbatim (e.g. "Jet Brigade", "Hive Lord"). Takes precedence over name.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "resolve_planet",
    description:
      "Resolve a loose planet name to the canonical upstream planet: exact case-insensitive match first, then punctuation/space-normalized, then fuzzy. Returns matched: true with the planet only for an exact/normalized match; a near-miss or tie returns ranked candidates (score = edit distance, lower is closer) with matched: false — never a silent substitution. Names come back in verbatim upstream casing.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Loose planet name to resolve (e.g. "gacrux", "mort epsilon").',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_observed_signatures",
    description:
      "Accumulated record of every distinct campaign signature tuple {campaign_type, event_type, has_event, faction} this server has observed while polling, newest last_seen first, with first/last seen timestamps and a 60s-deduplicated sample_count. Passive raw observation only — it captures rare states (special-faction event types, defense campaign types) with timestamps; no interpretation. Empty on cold start.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_global_history",
    description:
      "Global war statistics time-series sampled by this server (player count, missions won/lost, deaths, per-faction kills): retained points with raw observed deltas between consecutive samples. Observed values and deterministic differences only — never a forecast or trend verdict. Samples accrue on get_war_status polls; empty series (insufficient_history: true) is expected on cold start.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_major_order_history",
    description:
      "Observed Major Order objective-progress time-series sampled by this server: one bounded series per objective (keyed by major_order_id + objective_index) with per-point delta_progress / delta_hours between consecutive observations, latest progress/target, and deterministic progress_pct. Observed samples and raw deltas only — never a forecast, completion estimate, required pace, or on-track/behind verdict (pace judgment belongs to the consumer). No args → all series for the currently active Major Order(s); a recently ended MO's series stays queryable by major_order_id until it ages out. Empty/sparse series (insufficient_history: true) is expected on cold start.",
    inputSchema: {
      type: "object",
      properties: {
        major_order_id: {
          type: "number",
          description:
            "Specific Major Order id — including a recently ended MO whose series is still retained. Default: the currently active MO(s).",
        },
        objective_index: {
          type: "number",
          description:
            "Narrow to one objective index within the Major Order (an MO can have several objectives, each with its own series).",
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
    case "get_war_brief":
      return toolText(await getWarBrief(env));
    case "get_war_status":
      return toolText(await getWarStatus(env));
    case "get_campaigns":
      return toolText(
        await getCampaigns(env, {
          faction: typeof args.faction === "string" ? args.faction : undefined,
          major_order_only:
            typeof args.major_order_only === "boolean"
              ? args.major_order_only
              : undefined,
          has_rate:
            typeof args.has_rate === "boolean" ? args.has_rate : undefined,
          hpc_only:
            typeof args.hpc_only === "boolean" ? args.hpc_only : undefined,
        }),
      );
    case "resolve_planet":
      return toolText(
        await resolvePlanetTool(env, {
          query: typeof args.query === "string" ? args.query : undefined,
        }),
      );
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
    case "get_planet_wiki":
      return toolText(
        await getPlanetWiki(env, {
          name: typeof args.name === "string" ? args.name : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
        }),
      );
    case "get_observed_signatures":
      return toolText(await getObservedSignatures(env));
    case "get_global_history":
      return toolText(await getGlobalHistory(env));
    case "get_major_order_history":
      return toolText(
        await getMajorOrderHistory(env, {
          major_order_id:
            typeof args.major_order_id === "number"
              ? args.major_order_id
              : undefined,
          objective_index:
            typeof args.objective_index === "number"
              ? args.objective_index
              : undefined,
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
        if (
          err instanceof ToolError ||
          err instanceof UpstreamError ||
          err instanceof WikiError
        ) {
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
