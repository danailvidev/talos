import type { Database } from "bun:sqlite";
import type {
  DatadogArea,
  DatadogRoutingRepository,
  DatadogRoutingRule,
  DatadogRoutingRuleInput,
  DatadogRoutingRulePatch,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  priority: number;
  facet: string;
  pattern: string;
  action: string;
  team: string | null;
  area: string | null;
  jira_project: string | null;
  note: string | null;
  updated_at: string;
}

const SELECT = `SELECT id, priority, facet, pattern, action, team, area, jira_project,
                       note, updated_at
                  FROM datadog_routing_rules`;

/** A rule's own fields are short by nature; a pasted essay is not a pattern. */
const MAX_TEXT = 300;

const FACETS: readonly DatadogRoutingRule["facet"][] = [
  "service",
  "source",
  "kube_namespace",
  "env",
  "host",
  "signature",
];

const AREAS: readonly DatadogArea[] = [
  "frontend",
  "backend",
  "infrastructure",
  "data",
  "unknown",
];

/**
 * The rules that give a Datadog issue an owner, or drop it.
 *
 * Ordinary CRUD, with the validation deliberately here rather than only at the
 * API edge: the scan runs unattended at 04:00 and a rule with a facet SQLite
 * would reject, or an `ignore` rule with an empty pattern that silently matches
 * everything, is a table that comes back empty in the morning with nothing in the
 * logs to explain it.
 */
export class SqliteDatadogRoutingStore implements DatadogRoutingRepository {
  constructor(private readonly db: Database) {}

  list(): DatadogRoutingRule[] {
    return this.db
      .query<Row, []>(`${SELECT} ORDER BY priority, pattern`)
      .all()
      .map(toRule);
  }

  get(id: string): DatadogRoutingRule | undefined {
    const row = this.db.query<Row, [string]>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toRule(row) : undefined;
  }

  create(input: DatadogRoutingRuleInput): DatadogRoutingRule {
    const clean = validate(input);
    const id = newId();
    // Appended to the end by default: a new rule that silently outranked the
    // seeded ignores would change what the scan sees for reasons nobody asked for.
    const priority = clean.priority ?? this.nextPriority();
    this.db.run(
      `INSERT INTO datadog_routing_rules
         (id, priority, facet, pattern, action, team, area, jira_project, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        priority,
        clean.facet,
        clean.pattern,
        clean.action,
        clean.team ?? null,
        clean.area ?? null,
        clean.jiraProject ?? null,
        clean.note ?? null,
        toIso(new Date()),
      ],
    );
    return this.get(id)!;
  }

  update(id: string, input: DatadogRoutingRulePatch): DatadogRoutingRule | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    // Validated as the merged rule rather than field by field, so that clearing
    // `area` on a `route` rule that has no team is refused — the fields are only
    // valid or invalid together.
    const merged = validate({
      facet: input.facet ?? existing.facet,
      pattern: input.pattern ?? existing.pattern,
      action: input.action ?? existing.action,
      priority: input.priority ?? existing.priority,
      // `area` goes through `pick` too, so a patch clearing it on a route rule
      // with no team is refused by `validate` rather than silently accepted.
      ...pick("team", input, existing),
      ...pick("area", input, existing),
      ...pick("jiraProject", input, existing),
      ...pick("note", input, existing),
    });

    this.db.run(
      `UPDATE datadog_routing_rules
          SET priority = ?, facet = ?, pattern = ?, action = ?, team = ?, area = ?,
              jira_project = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      [
        merged.priority ?? existing.priority,
        merged.facet,
        merged.pattern,
        merged.action,
        merged.team ?? null,
        merged.area ?? null,
        merged.jiraProject ?? null,
        merged.note ?? null,
        toIso(new Date()),
        id,
      ],
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM datadog_routing_rules WHERE id = ?", [id]).changes > 0;
  }

  private nextPriority(): number {
    const row = this.db
      .query<{ max: number | null }, []>(
        "SELECT MAX(priority) AS max FROM datadog_routing_rules",
      )
      .get();
    return (row?.max ?? 0) + 10;
  }
}

/**
 * A rule that will do what it says, or a ConfigError naming what is wrong.
 *
 * The empty-pattern check is the one that matters: `*` is a legitimate catch-all
 * a person may well want as a last rule, but an *empty* pattern is a slip, and as
 * an `ignore` rule it would quietly empty the whole triage list.
 */
function validate(input: DatadogRoutingRuleInput): DatadogRoutingRuleInput {
  if (!FACETS.includes(input.facet)) {
    throw new ConfigError(
      `'${input.facet}' is not a routable facet. One of: ${FACETS.join(", ")}.`,
    );
  }
  if (input.action !== "route" && input.action !== "ignore") {
    throw new ConfigError(`'${input.action}' is not a rule action. Use 'route' or 'ignore'.`);
  }
  const pattern = input.pattern?.trim();
  if (!pattern) {
    throw new ConfigError(
      "A routing rule needs a pattern. Use `*` if you really mean 'everything'.",
    );
  }
  if (input.area != null && !AREAS.includes(input.area)) {
    throw new ConfigError(`'${input.area}' is not an area. One of: ${AREAS.join(", ")}.`);
  }
  const team = input.team?.trim() || undefined;
  const area = input.area;
  if (input.action === "route" && !team && !area) {
    throw new ConfigError("A route rule has to set a team, an area, or both.");
  }

  return {
    facet: input.facet,
    pattern: cap(pattern)!,
    action: input.action,
    ...(input.priority != null ? { priority: input.priority } : {}),
    ...(team ? { team: cap(team)! } : {}),
    ...(area ? { area } : {}),
    ...(input.jiraProject?.trim()
      ? { jiraProject: cap(input.jiraProject.trim().toUpperCase())! }
      : {}),
    ...(input.note?.trim() ? { note: cap(input.note.trim())! } : {}),
  };
}

/**
 * Merges one optional field, distinguishing "not mentioned" from "cleared".
 *
 * A patch that omits `team` leaves it alone; a patch that sends `null` or an
 * empty string clears it. Collapsing the two would make a team impossible to
 * remove once set.
 */
function pick<K extends "team" | "area" | "jiraProject" | "note">(
  key: K,
  patch: DatadogRoutingRulePatch,
  existing: DatadogRoutingRule,
): Partial<DatadogRoutingRuleInput> {
  if (!(key in patch)) {
    return existing[key] === undefined ? {} : ({ [key]: existing[key] } as Partial<DatadogRoutingRuleInput>);
  }
  const value = patch[key];
  return value === undefined || value === null || value === ""
    ? {}
    : ({ [key]: value } as Partial<DatadogRoutingRuleInput>);
}

function cap(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function toRule(row: Row): DatadogRoutingRule {
  return {
    id: row.id,
    priority: row.priority,
    facet: row.facet as DatadogRoutingRule["facet"],
    pattern: row.pattern,
    action: row.action as DatadogRoutingRule["action"],
    ...(row.team ? { team: row.team } : {}),
    ...(row.area ? { area: row.area as DatadogArea } : {}),
    ...(row.jira_project ? { jiraProject: row.jira_project } : {}),
    ...(row.note ? { note: row.note } : {}),
    updatedAt: fromIso(row.updated_at)!,
  };
}
