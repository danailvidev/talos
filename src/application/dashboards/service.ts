import { z } from "zod";

import {
  createAppAbility,
  PERMISSION_DEFINITIONS,
  type AppPermission,
} from "../../../shared/authorization.ts";
import {
  DashboardSpecSchema,
  type DashboardQuery,
  type DashboardSpec,
  type QueryResult,
  type Widget,
} from "../../../shared/dashboard.ts";
import type { Actor } from "../../core/actor.ts";
import { PermissionError, TransientError, ValidationError } from "../../core/errors.ts";
import { catalogOf, dashboardDatasets, type Dataset, type DatasetSources } from "./datasets.ts";
import { executeQuery } from "./query.ts";
import type { DashboardRepository, StoredDashboard } from "./repository.ts";

const QUERY_TIMEOUT_MS = 20_000;
const MAX_DASHBOARDS = 50;

export interface DashboardActor {
  id: string;
  name: string;
  email: string;
  permissions: readonly AppPermission[];
}

/**
 * Owns dashboard specs and the only path that runs a dashboard query.
 * Dataset visibility is the actor's CASL ability; row visibility is whatever
 * the underlying service already enforces for that actor.
 */
export class DashboardApplicationService {
  private readonly datasets: Dataset[];

  constructor(
    private readonly store: DashboardRepository,
    sources: DatasetSources,
  ) {
    this.datasets = dashboardDatasets(sources);
  }

  catalog(actor: DashboardActor) {
    return catalogOf(this.datasets.filter((dataset) => this.allowed(actor, dataset)));
  }

  list(actor: DashboardActor): StoredDashboard[] {
    return this.store.list(actor.id);
  }

  get(actor: DashboardActor, id: string): StoredDashboard | null {
    return this.store.get(actor.id, id);
  }

  create(actor: DashboardActor, input: unknown): StoredDashboard {
    if (this.store.list(actor.id).length >= MAX_DASHBOARDS) {
      throw new ValidationError(`A dashboard list is limited to ${MAX_DASHBOARDS}.`);
    }
    const spec = parseSpec(input);
    this.assertQueries(actor, spec.widgets);
    return this.store.insert({
      ownerUserId: actor.id,
      name: spec.name,
      ...(spec.description ? { description: spec.description } : {}),
      widgets: spec.widgets,
    });
  }

  update(actor: DashboardActor, id: string, input: unknown): StoredDashboard | null {
    const current = this.store.get(actor.id, id);
    if (!current) return null;
    const patch = DashboardPatchSchema.parse(input);
    const widgets = patch.widgets ?? current.widgets;
    this.assertQueries(actor, widgets);
    const name = patch.name ?? current.name;
    const description = patch.description === undefined ? current.description : patch.description;
    return this.store.update(actor.id, id, {
      name,
      description: description ?? null,
      widgets,
    });
  }

  delete(actor: DashboardActor, id: string): boolean {
    return this.store.delete(actor.id, id);
  }

  async query(
    actor: DashboardActor,
    input: DashboardQuery,
    options: { bypass: boolean; signal?: AbortSignal },
  ): Promise<QueryResult> {
    const dataset = this.datasets.find((candidate) => candidate.id === input.dataset);
    if (!dataset) throw new ValidationError(`Unknown dataset '${input.dataset}'.`);
    if (!this.allowed(actor, dataset)) {
      throw new PermissionError(`Access to ${dataset.label} is not permitted.`);
    }
    let params: unknown = input.params;
    if (dataset.params) {
      const parsed = dataset.params.safeParse(params ?? {});
      if (!parsed.success) {
        throw new ValidationError(`Parameters for ${dataset.label} are invalid.`);
      }
      params = parsed.data;
    } else if (params != null) {
      throw new ValidationError(`${dataset.label} does not take parameters.`);
    }

    const timeout = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let fetched;
    try {
      fetched = await dataset.fetch(toActor(actor), params, { bypass: options.bypass, signal });
    } catch (error) {
      // The connector treats our deadline as a caller abort and rethrows the
      // raw timeout. That is not a TalosError, so the route would otherwise
      // hide it as "internal error".
      if (timeout.aborted && !(error instanceof ValidationError) && !(error instanceof PermissionError)) {
        throw new TransientError("This widget took too long to load. Try again.", { cause: error });
      }
      throw error;
    }
    return executeQuery(fetched.rows, input, dataset.fields, {
      truncated: fetched.truncated,
      fetchedAt: new Date().toISOString(),
    });
  }

  private assertQueries(actor: DashboardActor, widgets: readonly Widget[]): void {
    for (const widget of widgets) {
      const dataset = this.datasets.find((candidate) => candidate.id === widget.query.dataset);
      if (!dataset) throw new ValidationError(`Unknown dataset '${widget.query.dataset}'.`);
      if (!this.allowed(actor, dataset)) {
        throw new PermissionError(`Access to ${dataset.label} is not permitted.`);
      }
      if (dataset.params) {
        const parsed = dataset.params.safeParse(widget.query.params ?? {});
        if (!parsed.success) {
          throw new ValidationError(`Parameters for ${dataset.label} are invalid.`);
        }
      }
      executeQuery([], widget.query, dataset.fields);
    }
  }

  private allowed(actor: DashboardActor, dataset: Dataset): boolean {
    if (!dataset.requires) return true;
    const definition = PERMISSION_DEFINITIONS.find((item) => item.id === dataset.requires);
    if (!definition) return false;
    return createAppAbility([...actor.permissions]).can(definition.action, definition.subject);
  }
}

const DashboardPatchSchema = z.object({
  name: DashboardSpecSchema.shape.name.optional(),
  description: z.string().trim().max(400).nullable().optional(),
  widgets: DashboardSpecSchema.shape.widgets.optional(),
}).strict();

function parseSpec(input: unknown): DashboardSpec {
  const parsed = DashboardSpecSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Dashboard spec is invalid.");
  const ids = new Set<string>();
  for (const widget of parsed.data.widgets) {
    if (ids.has(widget.id)) throw new ValidationError(`Widget id '${widget.id}' is duplicated.`);
    ids.add(widget.id);
  }
  return parsed.data;
}

function toActor(actor: DashboardActor): Actor {
  return { id: actor.id, name: actor.name, email: actor.email };
}
