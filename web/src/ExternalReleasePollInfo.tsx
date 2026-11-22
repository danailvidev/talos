import {
  BellRing,
  GitBranch,
  GitCommit,
  ScanSearch,
} from "lucide-react";

import { Button } from "./components/ui/button.tsx";

const STEPS = [
  {
    label: "Poll GitLab",
    detail: "Read new commits from the configured release repository and target branch.",
    Icon: GitBranch,
  },
  {
    label: "Find PROD changes",
    detail: "Inspect manifest diffs for version changes in environments beginning with prod.",
    Icon: ScanSearch,
  },
  {
    label: "Resolve the release",
    detail: "Link a merged MR when one exists, or keep the direct commit as the release.",
    Icon: GitCommit,
  },
  {
    label: "Open the watch",
    detail: "Hand the release to the six-hour Datadog and LogRocket post-deploy watcher.",
    Icon: BellRing,
  },
] as const;

export function ExternalReleasePollInfo() {
  return (
    <section className="mb-5.5 overflow-hidden rounded-[var(--radius-panel)] border border-border bg-[var(--bg-raised)]">
      <div className="border-b border-border px-4 py-3.5">
        <h2 className="m-0 text-base font-semibold text-foreground">
          How external releases become watched
        </h2>
        <p className="mt-1 max-w-190 text-sm leading-relaxed text-muted-foreground">
          This loop discovers production releases made outside Talos. It does not monitor
          errors itself—it identifies the release and hands it to the post-deploy watcher.
          The first run starts from now, so enabling it never backfills old releases.
        </p>
      </div>

      <ol className="grid list-none gap-0 px-4 py-4 md:grid-cols-4">
        {STEPS.map(({ label, detail, Icon }, index) => (
          <li
            key={label}
            className="relative grid grid-cols-[30px_minmax(0,1fr)] gap-2.5 pb-4 last:pb-0 md:block md:px-2 md:pb-0 md:text-center"
          >
            {index < STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-7.5 bottom-0 left-[14px] w-px bg-border md:top-[14px] md:bottom-auto md:left-[calc(50%+15px)] md:h-px md:w-[calc(100%-30px)]"
              />
            ) : null}
            <span className="relative z-1 flex size-7.5 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--primary)_35%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_10%,var(--bg-raised))] text-primary md:mx-auto">
              <Icon size={14} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="min-w-0 md:mt-2.5 md:block">
              <span className="block text-sm font-semibold text-foreground">{label}</span>
              <span className="mt-1 block text-[0.8125rem] leading-relaxed text-muted-foreground">
                {detail}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-[color-mix(in_srgb,var(--bg-hover)_45%,transparent)] px-4 py-3">
        <div className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          Datadog uses a 24-hour baseline and a three-sample threshold. LogRocket contributes
          issues first seen after the release. E2E tests are planned.
        </div>
        <Button asChild variant="outline" size="sm">
          <a href="/releases?tab=watch">View post-deploy watches</a>
        </Button>
      </div>
    </section>
  );
}
