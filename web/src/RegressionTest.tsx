/**
 * "Write a regression test" — the button, and what came back last time.
 *
 * Shared by the Datadog and LogRocket pages because the answer is the same object
 * on both, and the three verdicts are the whole reason the feature is worth having:
 * a row that says `not-reachable` is telling you the agent could not tie the error
 * to a code path, which is information. Rendering that as a silent no-op would make
 * the feature look broken exactly when it is being honest.
 */
import { ExternalLink, FlaskConical } from "lucide-react";

import type { RegressionTestView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { OBSERVABILITY_LINK_CLASS } from "./observability-styles.ts";

const VERDICT_CLASS =
  "cursor-help whitespace-nowrap rounded-full border border-transparent px-1.5 py-px text-xs font-semibold tracking-[0.04em] uppercase";

/** What each verdict means to a person looking at a row, in one line. */
const VERDICT: Record<
  RegressionTestView["verdict"],
  { label: string; hint: string; className: string }
> = {
  reproduced: {
    label: "test reproduces",
    hint: "The new test fails against HEAD. The merge request is a draft on purpose — do not merge it until the bug is fixed.",
    className:
      "border-[color-mix(in_srgb,var(--failure)_40%,transparent)] bg-[color-mix(in_srgb,var(--failure)_10%,transparent)] text-[var(--failure)]",
  },
  "already-fixed": {
    label: "already fixed",
    hint: "The new test passes against HEAD: the bug is gone, and the test is a guard against it coming back.",
    className:
      "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]",
  },
  "not-reachable": {
    label: "not reachable",
    hint: "The agent could not tie this error to a code path, so it wrote nothing. Usually means there is no stack trace to work from.",
    className:
      "border-[color-mix(in_srgb,var(--muted-foreground)_35%,transparent)] bg-[color-mix(in_srgb,var(--muted-foreground)_8%,transparent)] text-muted-foreground",
  },
};

export function RegressionTestBadge({ test }: { test: RegressionTestView }) {
  const verdict = VERDICT[test.verdict];
  return (
    <span className={cn(VERDICT_CLASS, verdict.className)} title={test.summary ?? verdict.hint}>
      {verdict.label}
    </span>
  );
}

/** The merge request the attempt opened, when it opened one. */
export function RegressionTestLink({ test }: { test: RegressionTestView }) {
  if (!test.mrUrl || test.mrIid == null) return null;
  return (
    <a
      className={cn(OBSERVABILITY_LINK_CLASS, "mono")}
      href={test.mrUrl}
      target="_blank"
      rel="noreferrer"
      title={
        test.testFile
          ? `${test.testFile}${test.verdict === "reproduced" ? " — draft, fails on purpose" : ""}`
          : undefined
      }
    >
      !{test.mrIid}
      <ExternalLink size={12} strokeWidth={2} />
    </a>
  );
}

/**
 * The button.
 *
 * Enabled again after an attempt finishes, whatever the verdict, and deliberately:
 * a `not-reachable` from three weeks ago says nothing about a codebase that has
 * moved since, and re-running is cheap next to the error going untested. Only an
 * attempt actually in flight disables it — the server refuses a duplicate anyway,
 * via the queue's dedupe key.
 */
export function RegressionTestButton({
  test,
  inFlight,
  disabled,
  disabledReason,
  busy,
  onClick,
}: {
  test: RegressionTestView | null;
  inFlight: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  busy: boolean;
  onClick: () => void;
}) {
  const title = inFlight
    ? "An agent is already writing a test for this error"
    : (disabled ? disabledReason : test?.summary) || undefined;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy || disabled || inFlight}
      title={title ?? undefined}
      onClick={onClick}
    >
      <FlaskConical size={13} strokeWidth={2} />
      {inFlight ? "Writing test…" : test ? "Write test again" : "Write a test"}
    </Button>
  );
}
