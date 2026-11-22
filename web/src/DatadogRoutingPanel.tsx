import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  api,
  type DatadogAreaView,
  type DatadogRoutingRulePatch,
  type DatadogRoutingRuleView,
} from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { cn } from "./lib/utils.ts";

const RULE_GRID_CLASS =
  "grid grid-cols-[72px_130px_minmax(140px,1fr)_96px_130px_130px_90px_auto] items-center gap-1.5";

/**
 * The rules that decide who owns a Datadog issue, and which noise is dropped.
 *
 * This panel exists because the ownership data does not. Nothing in this org's logs
 * carries a team tag, so "whose problem is this" cannot be read from Datadog — it
 * has to be declared, and declared somewhere an operator can change without a
 * deploy. The seeded rules are a starting point (the CSI drivers and the CI runner
 * ignored, `argocd*` and `aws-*` to infrastructure, `source:browser` to frontend),
 * not an answer.
 *
 * `ignore` deserves its own mention: it is not cosmetic. The scan asks Datadog for
 * the twenty loudest services, and with the infrastructure chatter still in the
 * data those twenty *are* the chatter — the product bugs never make the list at
 * all. Ignore rules are pushed into the query itself, so they change what is
 * measured rather than what is displayed.
 */
export function DatadogRoutingPanel({
  onToast,
  onChanged,
}: {
  onToast: (text: string) => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const rules = useApi(queries.datadogRouting());

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: keys.datadogRouting() });
    // The issue list too, via the page above: a rule decides which team owns a
    // row, so the rows on screen were routed by the rule that just changed.
    onChanged();
  };

  const remove = async (rule: DatadogRoutingRuleView) => {
    setBusyId(rule.id);
    try {
      // The delete answers with the whole remaining rule list, unlike create and
      // update which answer with the single rule — so this one row disappearing
      // costs no read at all. The issue list still has to be refetched: it was
      // routed by the rule that just went away.
      queryClient.setQueryData(keys.datadogRouting(), await api.deleteDatadogRule(rule.id));
      onChanged();
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyId(undefined);
    }
  };

  const create = async (patch: DatadogRoutingRulePatch) => {
    try {
      await api.createDatadogRule(patch);
      setAdding(false);
      reload();
    } catch (err) {
      onToast(toMessage(err));
    }
  };

  const update = async (id: string, patch: DatadogRoutingRulePatch) => {
    setBusyId(id);
    try {
      await api.updateDatadogRule(id, patch);
      reload();
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <section className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-4 py-3.5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-[0.9375rem] font-semibold text-foreground">Routing rules</h2>
          <p className="mt-0.5 max-w-[78ch] text-sm text-muted-foreground">
            Matched in priority order, first match wins. Changes take effect on the
            next scan — <span className="mono">ignore</span> rules are part of the
            Datadog query, so they change what is counted rather than what is shown.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={2} /> Add rule
        </Button>
      </header>

      {rules.error ? <ErrorBox>{rules.error}</ErrorBox> : null}

      <div className="flex flex-col gap-1">
        <div
          className={cn(
            RULE_GRID_CLASS,
            "px-0.5 pb-0.5 text-xs font-semibold tracking-[0.04em] text-[var(--text-faint)] uppercase",
          )}
        >
          <span>Priority</span>
          <span>Facet</span>
          <span>Pattern</span>
          <span>Action</span>
          <span>Team</span>
          <span>Area</span>
          <span>Jira</span>
          <span />
        </div>

        {adding ? (
          <RuleForm onCancel={() => setAdding(false)} onSave={(patch) => void create(patch)} />
        ) : null}

        {(rules.data?.rules ?? []).map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            busy={busyId === rule.id}
            onSave={(patch) => void update(rule.id, patch)}
            onDelete={() => void remove(rule)}
          />
        ))}
      </div>
    </section>
  );
}

const FACETS: DatadogRoutingRuleView["facet"][] = [
  "service",
  "source",
  "kube_namespace",
  "env",
  "host",
  "signature",
];

const AREAS: DatadogAreaView[] = [
  "frontend",
  "backend",
  "infrastructure",
  "data",
  "unknown",
];

const inputClass = "w-full";

/**
 * One rule, editable in place.
 *
 * Saved on blur rather than behind a save button: a rule is seven short fields, and
 * a row of inputs with its own button per row reads as a form rather than a table.
 * An empty team or Jira project is sent as `null`, which is how the server tells
 * "leave it alone" from "clear it".
 */
function RuleRow({
  rule,
  busy,
  onSave,
  onDelete,
}: {
  rule: DatadogRoutingRuleView;
  busy: boolean;
  onSave: (patch: DatadogRoutingRulePatch) => void;
  onDelete: () => void;
}) {
  return (
    <div className={cn(RULE_GRID_CLASS, rule.action === "ignore" && "opacity-72")}>
      <Input
        className={`${inputClass} mono`}
        type="number"
        defaultValue={rule.priority}
        onBlur={(e) => {
          const priority = Number(e.target.value);
          if (Number.isFinite(priority) && priority !== rule.priority) onSave({ priority });
        }}
        disabled={busy}
      />
      <select
        className={inputClass}
        defaultValue={rule.facet}
        onChange={(e) => onSave({ facet: e.target.value as DatadogRoutingRuleView["facet"] })}
        disabled={busy}
      >
        {FACETS.map((facet) => (
          <option key={facet} value={facet}>
            {facet}
          </option>
        ))}
      </select>
      <Input
        className={`${inputClass} mono`}
        defaultValue={rule.pattern}
        onBlur={(e) => {
          const pattern = e.target.value.trim();
          if (pattern && pattern !== rule.pattern) onSave({ pattern });
        }}
        disabled={busy}
      />
      <select
        className={inputClass}
        defaultValue={rule.action}
        onChange={(e) => onSave({ action: e.target.value as "route" | "ignore" })}
        disabled={busy}
      >
        <option value="route">route</option>
        <option value="ignore">ignore</option>
      </select>
      <Input
        className={inputClass}
        defaultValue={rule.team ?? ""}
        placeholder={rule.action === "ignore" ? "—" : "team"}
        onBlur={(e) => {
          const team = e.target.value.trim();
          if (team !== (rule.team ?? "")) onSave({ team: team || null });
        }}
        disabled={busy || rule.action === "ignore"}
      />
      <select
        className={inputClass}
        defaultValue={rule.area ?? ""}
        onChange={(e) => onSave({ area: (e.target.value as DatadogAreaView) || null })}
        disabled={busy || rule.action === "ignore"}
      >
        <option value="">—</option>
        {AREAS.map((area) => (
          <option key={area} value={area}>
            {area}
          </option>
        ))}
      </select>
      <Input
        className={`${inputClass} mono`}
        defaultValue={rule.jiraProject ?? ""}
        placeholder={rule.action === "ignore" ? "—" : "default"}
        onBlur={(e) => {
          const jiraProject = e.target.value.trim().toUpperCase();
          if (jiraProject !== (rule.jiraProject ?? "")) {
            onSave({ jiraProject: jiraProject || null });
          }
        }}
        disabled={busy || rule.action === "ignore"}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Delete rule"
        onClick={onDelete}
      >
        <Trash2 size={13} strokeWidth={2} />
      </Button>
    </div>
  );
}

/** The new-rule row. Same columns, so adding one looks like editing one. */
function RuleForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (patch: DatadogRoutingRulePatch) => void;
}) {
  const [facet, setFacet] = useState<DatadogRoutingRuleView["facet"]>("service");
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<"route" | "ignore">("route");
  const [team, setTeam] = useState("");
  const [area, setArea] = useState<DatadogAreaView | "">("");
  const [jiraProject, setJiraProject] = useState("");

  // A route rule that names neither a team nor an area would decide nothing, and
  // an empty pattern as an `ignore` rule would empty the whole triage list.
  const valid = pattern.trim() !== "" && (action === "ignore" || team.trim() !== "" || area !== "");

  return (
    <div className={cn(RULE_GRID_CLASS, "border-y border-border py-1")}>
      <span className="text-xs font-semibold tracking-[0.04em] text-primary uppercase">new</span>
      <select
        className={inputClass}
        value={facet}
        onChange={(e) => setFacet(e.target.value as DatadogRoutingRuleView["facet"])}
      >
        {FACETS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <Input
        className={`${inputClass} mono`}
        value={pattern}
        placeholder="csi-* · argocd* · exact-name"
        onChange={(e) => setPattern(e.target.value)}
      />
      <select
        className={inputClass}
        value={action}
        onChange={(e) => setAction(e.target.value as "route" | "ignore")}
      >
        <option value="route">route</option>
        <option value="ignore">ignore</option>
      </select>
      <Input
        className={inputClass}
        value={team}
        placeholder="team"
        disabled={action === "ignore"}
        onChange={(e) => setTeam(e.target.value)}
      />
      <select
        className={inputClass}
        value={area}
        disabled={action === "ignore"}
        onChange={(e) => setArea(e.target.value as DatadogAreaView | "")}
      >
        <option value="">—</option>
        {AREAS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <Input
        className={`${inputClass} mono`}
        value={jiraProject}
        placeholder="default"
        disabled={action === "ignore"}
        onChange={(e) => setJiraProject(e.target.value)}
      />
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          disabled={!valid}
          onClick={() =>
            onSave({
              facet,
              pattern: pattern.trim(),
              action,
              ...(team.trim() ? { team: team.trim() } : {}),
              ...(area ? { area } : {}),
              ...(jiraProject.trim() ? { jiraProject: jiraProject.trim().toUpperCase() } : {}),
            })
          }
        >
          Add
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
