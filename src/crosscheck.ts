/**
 * Stage 10: raw-source cross-check layer — PURE, zero I/O.
 *
 * Verifies the server's NORMALIZED fields against the RAW ArrowHead payloads
 * they derive from, exposed by the SAME wrapper host this server already
 * authenticates against (api.helldivers2.dev `/raw/...` endpoints — no new
 * provider, no new auth, same cache machinery in client.ts).
 *
 * THE RULE OF THIS MODULE: a disagreement is SURFACED, never RESOLVED. Every
 * checked field presents the normalized value, the raw value, and the
 * difference — never a pick, an average, or an "authoritative" flag favoring
 * one side. The only classification permitted is `expected_transform: true`
 * for fields the invariants DELIBERATELY transform (defense decay force-
 * nulled, liberation % recomputed) — documented invariant behavior, not a
 * trust decision. Choosing which source to believe is the consumer's
 * judgment, in the conversation layer where it is visible and arguable.
 *
 * Raw paths + field mappings VERIFIED against the live API (2026-06-11):
 *   /raw/api/WarSeason/801/Status →
 *     planetStatus[]  {index, owner(1=Humans/2=Terminids/3=Automaton/
 *                      4=Illuminate — all four observed live), health,
 *                      regenPerSecond, players}
 *     campaigns[]     {id, planetIndex, type, race} — id joins the
 *                      normalized campaign id exactly
 *     planetEvents[]  {planetIndex, eventType, health, maxHealth, campaignId}
 *   /raw/api/v2/Assignment/War/801 →
 *     [{id32 (= normalized assignment id), progress[], setting.tasks[]
 *       {type, values, valueTypes} — arrays byte-identical to normalized}]
 *   Raw planetStatus carries NO maxHealth and NO liberation % — those checks
 *   report field_absent_in_raw / expected_transform respectively.
 */
import { decodeObjectiveTarget } from "./enrichment";
import type {
  CrossCheckBlock,
  CrossCheckField,
  CrossCheckSubject,
  RawAssignment,
  RawWarStatus,
  RawWarStatusAssignment,
} from "./types";

/** The current war id, used only to address the wrapper's /raw endpoints.
 * War 801 is the (long-running) current galactic war the v1 endpoints serve;
 * verified live 2026-06-11 (raw warId field echoes 801). */
export const RAW_WAR_ID = 801;
/** Raw ArrowHead war status via the wrapper — verified live 2026-06-11. */
export const RAW_STATUS_PATH = `/raw/api/WarSeason/${RAW_WAR_ID}/Status`;
/** Raw ArrowHead assignments via the wrapper — verified live 2026-06-11. */
export const RAW_ASSIGNMENT_PATH = `/raw/api/v2/Assignment/War/${RAW_WAR_ID}`;

/**
 * Raw owner/race enum → the faction string the normalized API uses.
 * VERIFIED live 2026-06-11 by joining every planet in /api/v1/planets
 * against /raw planetStatus.owner: 1→Humans, 2→Terminids, 3→Automaton,
 * 4→Illuminate, with no other value observed. An unmapped value reports
 * agrees: null (unconfirmed_raw_enum_value) — a name is never fabricated
 * (the EVENT_MODIFIER_NAMES fail-safe).
 */
export const RAW_FACTION_NAMES: ReadonlyMap<number, string> = new Map([
  [1, "Humans"],
  [2, "Terminids"],
  [3, "Automaton"],
  [4, "Illuminate"],
]);

/**
 * Float comparison tolerance: relative 1e-6 (with the same absolute floor
 * near zero). Both sides serialize the SAME upstream numbers, so only
 * JSON-float round-tripping should ever differ — anything beyond this
 * tolerance is a genuine divergence and is reported with its diff. Values
 * sampled in different fetch cycles can legitimately differ (live HP moves);
 * the block's normalized_as_of / raw_as_of expose that skew so the consumer
 * sees WHEN each side is from — the server never nets the two out.
 */
export const CROSS_CHECK_FLOAT_TOLERANCE = 1e-6;

export const CROSS_CHECK_NOTE =
  "Each checked field presents the normalized value, the raw ArrowHead value (via the wrapper's /raw endpoints — same host and auth), and their difference. agrees is exact for discrete fields and within a documented 1e-6 relative tolerance for floats; agrees: null with a reason means one side has no counterpart (not a mismatch). expected_transform: true marks fields the invariants DELIBERATELY transform (defense decay force-nulled, liberation % recomputed) — normalization doing its job, not a divergence. Disagreements are surfaced as data, never resolved: no side is ranked correct, picked, or averaged — interpreting a divergence (including fetch-time skew, visible via normalized_as_of vs raw_as_of) is the consumer's. Both kinds of HP can move between the two cache entries' fetch moments.";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Within-tolerance float equality (relative, absolute floor near zero). */
export function floatsAgree(
  a: number,
  b: number,
  tolerance: number = CROSS_CHECK_FLOAT_TOLERANCE,
): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= tolerance * scale;
}

function diffFields(
  normalized: number,
  raw: number,
): Pick<CrossCheckField, "abs_diff" | "pct_diff"> {
  const absDiff = Math.abs(normalized - raw);
  const scale = Math.max(Math.abs(normalized), Math.abs(raw));
  return {
    abs_diff: absDiff,
    pct_diff: scale > 0 ? (absDiff / scale) * 100 : 0,
  };
}

/** One float comparison: within tolerance → agrees, else the diff rides. */
function checkFloat(
  field: string,
  normalized: number | null,
  raw: number | null,
): CrossCheckField {
  if (normalized == null || raw == null) {
    return {
      field,
      normalized_value: normalized,
      raw_value: raw,
      agrees: null,
      reason:
        raw == null ? "field_absent_in_raw" : "field_absent_in_normalized",
    };
  }
  const agrees = floatsAgree(normalized, raw);
  return {
    field,
    normalized_value: normalized,
    raw_value: raw,
    agrees,
    ...(agrees ? {} : diffFields(normalized, raw)),
  };
}

/** One discrete comparison: exact equality, null sides explained. */
function checkDiscrete(
  field: string,
  normalized: number | string | boolean | null,
  raw: number | string | boolean | null,
): CrossCheckField {
  if (normalized == null || raw == null) {
    return {
      field,
      normalized_value: normalized,
      raw_value: raw,
      agrees: null,
      reason:
        raw == null ? "field_absent_in_raw" : "field_absent_in_normalized",
    };
  }
  return {
    field,
    normalized_value: normalized,
    raw_value: raw,
    agrees: normalized === raw,
  };
}

/**
 * Cross-check one normalized planet/campaign view against the raw war
 * status. Pure: the subject is assembled by the handler from values the
 * payload itself carries, so every check is verifiable in place.
 */
export function crossCheckSubject(
  subject: CrossCheckSubject,
  raw: RawWarStatus,
): CrossCheckField[] {
  const checks: CrossCheckField[] = [];
  const status = (raw.planetStatus ?? []).find(
    (p) => p.index === subject.planet_index,
  );
  const event = (raw.planetEvents ?? []).find(
    (e) => e.planetIndex === subject.planet_index,
  );
  const isDefense = subject.campaign_kind === "defense";

  // Owner: raw numeric enum decoded via the live-verified map; an unmapped
  // value is visible-but-unnamed, never guessed.
  if (status == null) {
    checks.push({
      field: "current_owner",
      normalized_value: subject.current_owner,
      raw_value: null,
      agrees: null,
      reason: "planet_absent_in_raw",
    });
  } else {
    const ownerName = isFiniteNumber(status.owner)
      ? (RAW_FACTION_NAMES.get(status.owner) ?? null)
      : null;
    checks.push(
      ownerName == null
        ? {
            field: "current_owner",
            normalized_value: subject.current_owner,
            raw_value: status.owner ?? null,
            agrees: null,
            reason: "unconfirmed_raw_enum_value",
          }
        : checkDiscrete("current_owner", subject.current_owner, ownerName),
    );
  }

  // raw_hp: the tracked health — event health on a defense (the invariant-1
  // path samples it), planet health otherwise. Float-tolerant; a real diff
  // (including fetch-moment skew) rides with abs/pct, never netted out.
  const rawHealth = isDefense
    ? (isFiniteNumber(event?.health) ? event!.health : null)
    : isFiniteNumber(status?.health)
      ? status!.health
      : null;
  checks.push(checkFloat("raw_hp", subject.raw_hp, rawHealth));

  // max_hp: the raw status carries an event maxHealth but NO per-planet
  // maxHealth (that lives in WarInfo, not fetched here) — absent, not wrong.
  const rawMaxHealth = isDefense
    ? isFiniteNumber(event?.maxHealth)
      ? event!.maxHealth
      : null
    : null;
  checks.push(checkFloat("max_hp", subject.max_hp, rawMaxHealth));

  // regen_per_second: invariant 1 FORCE-NULLS defense decay — on a defense
  // the raw value is shown beside the deliberate null as expected_transform
  // (normalization did its job); on a liberation the values must agree.
  const rawRegen = isFiniteNumber(status?.regenPerSecond)
    ? status!.regenPerSecond
    : null;
  if (isDefense) {
    checks.push({
      field: "regen_per_second",
      normalized_value: subject.regen_per_second,
      raw_value: rawRegen,
      agrees: null,
      expected_transform: true,
      reason:
        "invariant_1_defense_decay_force_nulled: upstream defense regen is cosmetic by design; the normalized field is deliberately null while the raw value is shown here untouched.",
    });
  } else {
    checks.push(
      checkFloat("regen_per_second", subject.regen_per_second, rawRegen),
    );
  }

  // liberation_pct_display_only: a derived display field RECOMPUTED from raw
  // HP by the documented formula — the raw payload has no such field at all.
  checks.push({
    field: "liberation_pct_display_only",
    normalized_value: subject.liberation_pct_display_only,
    raw_value: null,
    agrees: null,
    expected_transform: true,
    reason:
      "invariant_2_recomputed_display_field: (max_hp − raw_hp) / max_hp × 100, derived from raw HP by the server; no raw counterpart exists upstream.",
  });

  // campaign_type: joined by campaign id against the raw campaigns list —
  // only when a real campaign exists (a get_planet probe of a quiet planet
  // makes no campaign_type claim to check).
  if (subject.campaign_id != null && subject.campaign_id >= 0) {
    const rawCampaign = (raw.campaigns ?? []).find(
      (c) => c.id === subject.campaign_id,
    );
    checks.push(
      rawCampaign == null
        ? {
            field: "campaign_type",
            normalized_value: subject.campaign_type,
            raw_value: null,
            agrees: null,
            reason: "campaign_absent_in_raw",
          }
        : checkDiscrete(
            "campaign_type",
            subject.campaign_type,
            isFiniteNumber(rawCampaign.type) ? rawCampaign.type : null,
          ),
    );
  }

  // Event presence + identity: has_event is the defense discriminator the
  // whole invariant layer pivots on, so its raw agreement matters most.
  checks.push(
    checkDiscrete("has_event", subject.event_type != null, event != null),
  );
  if (subject.event_type != null || event != null) {
    checks.push(
      checkDiscrete(
        "event_type",
        subject.event_type,
        isFiniteNumber(event?.eventType) ? event!.eventType : null,
      ),
    );
  }

  // player_count: raw planetStatus.players ↔ normalized statistics subset.
  checks.push(
    checkDiscrete(
      "player_count",
      subject.player_count,
      isFiniteNumber(status?.players) ? status!.players : null,
    ),
  );

  return checks;
}

/** Wrap field checks into the block get_planet carries, with both sides'
 * retrieval timestamps so fetch-moment skew is visible, never hidden. */
export function buildCrossCheckBlock(
  subject: CrossCheckSubject,
  raw: RawWarStatus,
  meta: {
    normalizedFetchedAtMs: number;
    rawFetchedAtMs: number;
    rawStale: boolean;
  },
): CrossCheckBlock {
  const checked = crossCheckSubject(subject, raw);
  return {
    available: true,
    raw_source: RAW_STATUS_PATH,
    checked,
    ...summarizeChecks(checked),
    normalized_as_of: new Date(meta.normalizedFetchedAtMs).toISOString(),
    raw_as_of: new Date(meta.rawFetchedAtMs).toISOString(),
    ...(meta.rawStale ? { raw_stale: true } : {}),
    note: CROSS_CHECK_NOTE,
  };
}

/** The degraded block when /raw cannot be served: a reasoned null, never a
 * blocked primary response and never a guessed comparison. */
export function unavailableCrossCheck(
  reason: "raw_unavailable" | "normalized_unavailable",
  detail?: string,
): CrossCheckBlock {
  return {
    available: false,
    raw_source: RAW_STATUS_PATH,
    reason,
    ...(detail ? { detail } : {}),
    note: "Cross-check skipped: one side could not be fetched. The primary response is unaffected; no value was guessed for the missing side.",
  };
}

/** Deterministic tallies over a set of field checks. expected_transform
 * fields are counted apart — they are documented invariant behavior, not
 * divergence — and agrees: null fields are 'uncheckable', not mismatches. */
export function summarizeChecks(checked: ReadonlyArray<CrossCheckField>): {
  fields_checked: number;
  agreements: number;
  unexpected_disagreements: number;
  expected_transforms: number;
  uncheckable: number;
} {
  let agreements = 0;
  let disagreements = 0;
  let transforms = 0;
  let uncheckable = 0;
  for (const c of checked) {
    if (c.expected_transform) transforms++;
    else if (c.agrees === true) agreements++;
    else if (c.agrees === false) disagreements++;
    else uncheckable++;
  }
  return {
    fields_checked: checked.length,
    agreements,
    unexpected_disagreements: disagreements,
    expected_transforms: transforms,
    uncheckable,
  };
}

/**
 * Cross-check the normalized Major Order objectives against the raw
 * assignment payload, joined by id (raw id32 === normalized id — verified
 * live). progress is compared per objective slot; target reuses the ONE
 * Stage 7 goal decode on both sides' identical positional arrays.
 */
export function crossCheckAssignments(
  normalized: RawAssignment[],
  raw: RawWarStatusAssignment[],
): {
  major_order_id: number;
  checked: CrossCheckField[];
  matched_in_raw: boolean;
}[] {
  return normalized.map((assignment) => {
    const rawSide = raw.find((r) => r.id32 === assignment.id);
    if (rawSide == null) {
      return {
        major_order_id: assignment.id,
        matched_in_raw: false,
        checked: [
          {
            field: "assignment",
            normalized_value: assignment.id,
            raw_value: null,
            agrees: null,
            reason: "assignment_absent_in_raw",
          },
        ],
      };
    }
    const checked: CrossCheckField[] = [];
    const tasks = assignment.tasks ?? [];
    const rawTasks = rawSide.setting?.tasks ?? [];
    checked.push(
      checkDiscrete("objective_count", tasks.length, rawTasks.length),
    );
    tasks.forEach((task, i) => {
      const rawTask = rawTasks[i];
      checked.push(
        checkDiscrete(
          `objectives[${i}].progress`,
          isFiniteNumber(assignment.progress?.[i])
            ? assignment.progress![i]!
            : null,
          isFiniteNumber(rawSide.progress?.[i])
            ? rawSide.progress![i]!
            : null,
        ),
        checkDiscrete(
          `objectives[${i}].task_type`,
          isFiniteNumber(task.type) ? task.type : null,
          rawTask && isFiniteNumber(rawTask.type) ? rawTask.type : null,
        ),
        checkDiscrete(
          `objectives[${i}].target`,
          decodeObjectiveTarget(task),
          rawTask ? decodeObjectiveTarget(rawTask) : null,
        ),
      );
    });
    return { major_order_id: assignment.id, matched_in_raw: true, checked };
  });
}

/**
 * Planets/campaigns present on one side only — reported, never dropped
 * silently. Indices are sorted for stable output.
 */
export function unmatchedCampaigns(
  normalizedIndices: ReadonlyArray<number>,
  raw: RawWarStatus,
): {
  in_normalized_only: number[];
  in_raw_only: number[];
} {
  const normalizedSet = new Set(normalizedIndices);
  const rawSet = new Set(
    (raw.campaigns ?? [])
      .map((c) => c.planetIndex)
      .filter((i): i is number => isFiniteNumber(i)),
  );
  return {
    in_normalized_only: [...normalizedSet]
      .filter((i) => !rawSet.has(i))
      .sort((a, b) => a - b),
    in_raw_only: [...rawSet]
      .filter((i) => !normalizedSet.has(i))
      .sort((a, b) => a - b),
  };
}
