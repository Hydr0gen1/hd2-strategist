/**
 * Minimal MCP server over HTTP: JSON-RPC 2.0 handling for initialize,
 * tools/list, and tools/call (plus ping and client notifications).
 * Hand-rolled — no SDK — to stay within the Workers free-tier CPU budget.
 */
import { ArchiveError } from "./archive";
import { UpstreamError } from "./client";
import {
  ExportParamError,
  collectArchiveCsv,
  exportArchive,
  parseExportResourceUri,
} from "./export";
import {
  ToolError,
  getCampaigns,
  getDispatches,
  getGambits,
  getGlobalArchive,
  getGlobalHistory,
  getMajorOrder,
  getMajorOrderArchive,
  getMajorOrderHistory,
  getMoPace,
  getObservedSignatures,
  getPatchNotes,
  getPlanet,
  getPlanetArchive,
  getPlanetHistory,
  getSourceCrossCheck,
  getSupplyGraph,
  getWarBrief,
  getWarDiff,
  getWarStatus,
  getWikiPage,
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
    name: "get_mo_pace",
    description:
      "Major Order pace: per objective, the OBSERVED progress rate (latest and mean per-interval deltas over this server's retained progress samples) and the REQUIRED rate (remaining ÷ time_left_hours — the pace that would exactly reach the target at expiry) side by side, plus remaining, time_left_hours, progress/target. Two numbers, NO on-track/behind verdict — the reader compares them. State-at-expiry objective kinds (hold_planet) null both rates with a reason (progress is a state, not a cumulative counter). Read-only; observed rates need two samples >60s apart (insufficient_history on a cold start is expected).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_gambits",
    description:
      "The gambit board: every active defense campaign with its attack-origin planet(s) — resolved by inverting the observed source→target attack pairs — each origin joined with its live liberation state (raw_hp, max_hp, liberation_pct_display_only, signed hp_per_hour) and is_major_order_target (a pure membership join). Facts only: NO gambit-viability score or clear-the-origin-in-time verdict, by design. Read-only (records nothing). Under a campaign outage the defense set is UNKNOWN — defenses is null, never an asserted-empty board.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_war_diff",
    description:
      "What changed since N hours ago, as deterministic D1-archive arithmetic: each planet's / MO objective's / global counter's FIRST vs LAST archived observation inside the window, with raw before/after values and subtractions — tracked-faction changes, campaigns opened/closed (campaign_id turnover), per-planet delta_health, net health delta grouped by last-observed faction, MO progress deltas, and global counter deltas. Pure archive facts: no significance ranking, no cause attribution, no went-well/badly verdict. insufficient_history when the window predates the archive. Optional until_hours closes the window's upper edge (diff an older band).",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: {
          type: "number",
          description:
            "Window START in hours-back-from-now (default 24). The diff compares first vs last archived observation inside the window.",
        },
        until_hours: {
          type: "number",
          description:
            "Optional window END in hours-back-from-now (omit for 'up to now'). Must be SMALLER than since_hours.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_planet",
    description:
      "Deep dive on one planet by index or name: raw HP, regen/decay (defense decay is always null — it is cosmetic), signed hp_per_hour, hours_to_resolution projection derived from raw HP (never from liberation %), direction flag, per-planet statistics (players, mission wins/losses + derived success rate, kills), biome, environmental hazards, defense timing (defense_ends_at / defense_hours_remaining) when a defense event is active, and waypoint neighbor context: neighbors (joined name/owner/campaign per upstream waypoint), neighbor_summary counts, and the frontline adjacency fact (borders territory of a different owner). Also carries a cross_check block verifying the normalized fields against the raw ArrowHead status (/raw) — both values surfaced on any disagreement, never resolved; degrades to a reasoned null when /raw is unavailable.",
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
    name: "get_supply_graph",
    description:
      "Supply-line graph over observed waypoint edges. Default (no args): the active-campaign subgraph — every active-campaign planet plus its one-hop inbound+outbound neighbors. full: true returns the whole galaxy; root (index or name) + depth (default 1, cap 3) walks outward from one planet; active_only narrows nodes to active-campaign planets. Returns compact nodes (index, name, owner, has_active_campaign, campaign_kind, campaign_state_known, borders_super_earth) and directed edges (from, to, observed: true — only edges upstream actually lists; implied reverse edges are never synthesized), plus node_count/edge_count. READ-ONLY: records nothing. Staleness names its source via a structured `provenance` block (planet_source 'live'|'snapshot' governs topology; campaigns 'ok'|'stale'|'unavailable' governs the campaign overlay) and `active_campaign_overlay` ('complete'|'degraded'|'unavailable'). Top-level stale: true is a rollup — see provenance for which input degraded. Under a campaign outage the topology stays complete while nodes carry campaign_state_known:false (has_active_campaign null), so an empty active subgraph reads as UNKNOWN, never 'no active campaigns'.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: ["number", "string"],
          description:
            "Optional root planet (index number or name) to walk outward from. Omit for the active-campaign subgraph.",
        },
        depth: {
          type: "number",
          description: "Hops to expand from the seed set (default 1, cap 3).",
        },
        active_only: {
          type: "boolean",
          description: "Narrow nodes to active-campaign planets only.",
        },
        full: {
          type: "boolean",
          description: "Return the whole galaxy instead of a subgraph.",
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
    name: "get_wiki_page",
    description:
      'Fetch a community wiki entry from helldivers.wiki.gg for any game topic: weapons, warbonds, stratagems, enemies, subfactions (e.g. "Jet Brigade"), boosters, passives, missions, biomes, or planets. Returns a plain-text lead extract by default; pass full:true for the complete page. Attribution is included in the response (CC BY-NC-SA 4.0). Non-authoritative for live war state — use get_planet / get_campaigns for current war data.',
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            'The wiki page title to look up, e.g. "Eruptor", "Democratic Detonation", "Jet Brigade", "Scorcher Biome". Case-insensitive on the first letter (MediaWiki handles it).',
        },
        full: {
          type: "boolean",
          description:
            "If true, return the full page text (raw wikitext) instead of just the intro extract. Default: false.",
        },
      },
      required: ["title"],
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
  {
    name: "get_source_crosscheck",
    description:
      "Normalization-faithfulness health check: every active campaign and Major Order objective cross-checked against the raw ArrowHead payloads (the same upstream wrapper's /raw endpoints — same host, auth, and cache; not a second provider). Returns deterministic tallies (agreements, unexpected disagreements, expected invariant transforms, uncheckable fields) plus the specific divergent fields with BOTH values and the difference. Pure observation: a disagreement is surfaced, never resolved — no side is ranked correct. Expected transforms (defense decay force-nulled, liberation % recomputed) are classified as documented invariant behavior, never mismatches. Degrades to a reasoned unavailable section when /raw cannot be fetched.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_planet_archive",
    description:
      "Long-range observed health time-series for one planet (by index or name) from the UNBOUNDED D1 archive — the durable, multi-day/week counterpart to get_planet_history's recent in-memory window. Returns archived data points with per-point delta_health / delta_hours between consecutive samples, plus the signed hp_per_hour and campaign context stored at each tick. Observed values and deterministic deltas only — no forecasts or trend labels. Defaults to the last 7 days, capped at 1000 rows. Empty/sparse series (insufficient_history: true) is expected on a cold archive or for an out-of-window planet. For live rate/ETA/projection, use the live tools — this is history, not current state.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number", description: "Planet index (e.g. 175)" },
        name: {
          type: "string",
          description: "Planet name, case-insensitive (e.g. \"Grand Errant\")",
        },
        since_hours: {
          type: "number",
          description:
            "Look-back window START in hours-back-from-now (default 168 = 7 days). Only samples newer than this are returned.",
        },
        until_hours: {
          type: "number",
          description:
            "Optional window END in hours-back-from-now (omit for 'up to now'). Must be SMALLER than since_hours. Lets you page backward through older history in slices (e.g. since_hours: 400, until_hours: 200).",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default and cap 1000), oldest-first within the window.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_global_archive",
    description:
      "Long-range global war-statistics time-series from the UNBOUNDED D1 archive (player count, impact_multiplier, active_campaign_count, missions won/lost, deaths, per-faction kills): the durable counterpart to get_global_history, the view that answers impact-multiplier-vs-population and the daily population cycle over days/weeks rather than hours. Returns archived points with raw observed deltas between consecutive samples. Observed values and deterministic differences only — never a forecast, correlation, or trend verdict. Defaults to the last 7 days, capped at 1000 rows. Empty series (insufficient_history: true) is expected on a cold archive.",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: {
          type: "number",
          description: "Look-back window START in hours-back-from-now (default 168 = 7 days).",
        },
        until_hours: {
          type: "number",
          description:
            "Optional window END in hours-back-from-now (omit for 'up to now'). Must be SMALLER than since_hours. Pages backward through older history in slices.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default and cap 1000), oldest-first within the window.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_major_order_archive",
    description:
      "Long-range Major Order objective-progress time-series from the UNBOUNDED D1 archive: the durable counterpart to get_major_order_history, grounding MO pace across a whole order rather than the recent window. One series per objective (keyed by major_order_id + objective_index) with per-point delta_progress / delta_hours, latest progress/target, and deterministic progress_pct. Observed samples and raw deltas only — never a forecast, completion estimate, required pace, or on-track/behind verdict. Optional major_order_id / objective_index narrow the query. Defaults to the last 7 days, capped at 1000 rows. objective_kind is null here (the raw task type is not archived); use get_major_order_history for the decoded label.",
    inputSchema: {
      type: "object",
      properties: {
        major_order_id: {
          type: "number",
          description: "Narrow to one Major Order id (any MO ever sampled into the archive).",
        },
        objective_index: {
          type: "number",
          description: "Narrow to one objective index within the Major Order.",
        },
        since_hours: {
          type: "number",
          description: "Look-back window START in hours-back-from-now (default 168 = 7 days).",
        },
        until_hours: {
          type: "number",
          description:
            "Optional window END in hours-back-from-now (omit for 'up to now'). Must be SMALLER than since_hours. Pages backward through older history in slices.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default and cap 1000), oldest-first within the window.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "export_archive",
    description:
      "Bulk CSV export of the UNBOUNDED D1 archive, bypassing the 1000-row cap on the get_*_archive tools so the WHOLE history (or an arbitrary window) can be pulled off-context for trend analysis. Returns metadata — { url, table, bucket, row_count, byte_size_estimate, range, columns, format, generated_at } — plus a resource_link content item for the same snapshot: read the link (resources/read) to receive the full CSV through the MCP connector, or fetch `url` over plain HTTP; the rows are NEVER inlined in this result. Pick table (global | planet | mo). Optional since/until (ISO-8601) or since_hours/until_hours bound an arbitrary window (both edges, which the JSON tools lack); planet_index filters the planet table to one planet; bucket (raw | hourly | daily) server-side rolls up long ranges (mean of rates/multiplier, last value of counts) into one row per bucket. A faithful verbatim dump of stored rows — no derived/trend columns; trend synthesis stays in the conversation layer. For live rate/ETA/projection use the live tools; this is history.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: ["global", "planet", "mo"],
          description:
            "Which archive table to export: global (war statistics), planet (per-planet health), or mo (Major Order objective progress).",
        },
        planet_index: {
          type: "number",
          description:
            "Planet table only: filter to one planet by index (e.g. 185).",
        },
        since: {
          type: "string",
          description:
            "Window start as an ISO-8601 datetime (e.g. 2026-06-18T00:00:00Z). Omit for open-ended. Mutually exclusive with since_hours.",
        },
        until: {
          type: "string",
          description:
            "Window end as an ISO-8601 datetime. Omit for open-ended (up to now). Mutually exclusive with until_hours.",
        },
        since_hours: {
          type: "number",
          description: "Window start expressed as hours-back-from-now (alternative to since).",
        },
        until_hours: {
          type: "number",
          description: "Window end expressed as hours-back-from-now (alternative to until).",
        },
        bucket: {
          type: "string",
          enum: ["raw", "hourly", "daily"],
          description:
            "raw (default) = every stored row; hourly/daily = server-side rollup to one row per bucket (mean of rates/multiplier, last value of counts) for long ranges.",
        },
      },
      required: ["table"],
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
  origin: string,
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
    case "get_mo_pace":
      return toolText(await getMoPace(env));
    case "get_gambits":
      return toolText(await getGambits(env));
    case "get_war_diff":
      return toolText(
        await getWarDiff(env, {
          since_hours:
            typeof args.since_hours === "number" ? args.since_hours : undefined,
          until_hours:
            typeof args.until_hours === "number" ? args.until_hours : undefined,
        }),
      );
    case "get_planet":
      return toolText(
        await getPlanet(env, {
          index: typeof args.index === "number" ? args.index : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
        }),
      );
    case "get_supply_graph":
      return toolText(
        await getSupplyGraph(env, {
          root:
            typeof args.root === "number" || typeof args.root === "string"
              ? args.root
              : undefined,
          depth: typeof args.depth === "number" ? args.depth : undefined,
          active_only:
            typeof args.active_only === "boolean"
              ? args.active_only
              : undefined,
          full: typeof args.full === "boolean" ? args.full : undefined,
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
    case "get_wiki_page":
      return toolText(
        await getWikiPage(env, {
          title: typeof args.title === "string" ? args.title : undefined,
          full: typeof args.full === "boolean" ? args.full : undefined,
        }),
      );
    case "get_observed_signatures":
      return toolText(await getObservedSignatures(env));
    case "get_global_history":
      return toolText(await getGlobalHistory(env));
    case "get_source_crosscheck":
      return toolText(await getSourceCrossCheck(env));
    case "get_planet_archive":
      return toolText(
        await getPlanetArchive(env, {
          index: typeof args.index === "number" ? args.index : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
          since_hours:
            typeof args.since_hours === "number" ? args.since_hours : undefined,
          until_hours:
            typeof args.until_hours === "number" ? args.until_hours : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      );
    case "get_global_archive":
      return toolText(
        await getGlobalArchive(env, {
          since_hours:
            typeof args.since_hours === "number" ? args.since_hours : undefined,
          until_hours:
            typeof args.until_hours === "number" ? args.until_hours : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      );
    case "get_major_order_archive":
      return toolText(
        await getMajorOrderArchive(env, {
          major_order_id:
            typeof args.major_order_id === "number"
              ? args.major_order_id
              : undefined,
          objective_index:
            typeof args.objective_index === "number"
              ? args.objective_index
              : undefined,
          since_hours:
            typeof args.since_hours === "number" ? args.since_hours : undefined,
          until_hours:
            typeof args.until_hours === "number" ? args.until_hours : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      );
    case "export_archive": {
      // Accept number OR string for the numeric fields: a model may serialize
      // them as strings, and exportArchive's shared parser coerces + validates,
      // so a string-encoded value is honored (and a bad one errors) instead of
      // being silently dropped — which for planet_index would widen a
      // single-planet export to every planet.
      const numOrStr = (v: unknown): number | string | undefined =>
        typeof v === "number" || typeof v === "string" ? v : undefined;
      const meta = await exportArchive(env, origin, {
        table: typeof args.table === "string" ? args.table : undefined,
        planet_index: numOrStr(args.planet_index),
        since: typeof args.since === "string" ? args.since : undefined,
        until: typeof args.until === "string" ? args.until : undefined,
        since_hours: numOrStr(args.since_hours),
        until_hours: numOrStr(args.until_hours),
        bucket: typeof args.bucket === "string" ? args.bucket : undefined,
      });
      // Item 1: the metadata pointer AND an MCP resource_link for the same
      // frozen snapshot. An in-connector agent (blocked from fetching a
      // workers.dev URL directly) reads the link via resources/read and the
      // bytes route through the connector; the plain `url` stays for
      // browser/CLI use. The rows are still never inlined in this result.
      return {
        content: [
          { type: "text", text: JSON.stringify(meta, null, 2) },
          {
            type: "resource_link",
            uri: meta.url,
            name: `${meta.table}-archive-${meta.bucket}.csv`,
            description: `Streamed CSV of the ${meta.table} archive window (${meta.row_count} raw rows${meta.bucket !== "raw" ? `, ${meta.bucket} rollup` : ""}). Read this resource to receive the full file through the MCP connector — not capped at the JSON tools' 1000 rows.`,
            mimeType: "text/csv",
          },
        ],
      };
    }
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
        capabilities: { tools: {}, resources: {} },
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
    // Item 1: export resources. The server mints resource URIs dynamically —
    // one per export_archive call (the tool result's resource_link) — so the
    // static list is empty; resources/read serves any minted export URI.
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      let exportParams;
      try {
        exportParams = parseExportResourceUri(uri, Date.now());
      } catch (err) {
        if (err instanceof ExportParamError) {
          return rpcError(id, -32602, err.message);
        }
        throw err;
      }
      if (exportParams === null) {
        return rpcError(
          id,
          -32002,
          `Resource not found: "${uri}". This server only serves archive-export resources minted by the export_archive tool (path /export/archive).`,
        );
      }
      try {
        // The SAME keyset-paginated read path as the HTTP route, buffered into
        // one contents item (resources/read is a single JSON-RPC response).
        // The URI carries the frozen window + max_id watermark, so the bytes
        // match the metadata the tool returned.
        const text = await collectArchiveCsv(env, exportParams);
        return rpcResult(id, {
          contents: [{ uri, mimeType: "text/csv", text }],
        });
      } catch (err) {
        if (err instanceof ArchiveError || err instanceof ExportParamError) {
          return rpcError(id, -32603, err.message);
        }
        return rpcError(
          id,
          -32603,
          "Internal error while reading the export resource.",
        );
      }
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const origin = new URL(request.url).origin;
        const result = await dispatchTool(env, name, args, origin);
        if (result === null) {
          return rpcError(id, -32602, `Unknown tool: "${name}".`);
        }
        return rpcResult(id, result);
      } catch (err) {
        if (
          err instanceof ToolError ||
          err instanceof UpstreamError ||
          err instanceof WikiError ||
          err instanceof ArchiveError ||
          err instanceof ExportParamError
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
