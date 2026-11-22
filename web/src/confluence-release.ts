import type {
  ConfluenceReleaseView,
  EnvironmentVersionView,
} from "../../shared/api-contract.ts";
import { serviceVersionKey } from "./release-comparison.ts";

/** Production is one exact environment, not every environment prefixed with prod. */
export function isProdEnvironment(name: string): boolean {
  return name.trim().toLocaleLowerCase() === "prod";
}

export interface AppliedConfluenceRelease {
  versions: Record<string, string>;
  applied: number;
  changed: number;
  missing: string[];
}

/**
 * Apply only concrete Suggested values to services already present in the
 * target environment.
 * The parser removes `unchanged`; the second check keeps this safe for any other
 * API caller that constructs the view directly.
 */
export function applyConfluenceRelease(
  environment: EnvironmentVersionView,
  current: Record<string, string>,
  release: ConfluenceReleaseView,
): AppliedConfluenceRelease {
  const byName = new Map<string, EnvironmentVersionView["services"]>();
  for (const service of environment.services) {
    const key = normalise(service.name);
    byName.set(key, [...(byName.get(key) ?? []), service]);
  }
  const versions = { ...current };
  const missing: string[] = [];
  let applied = 0;
  let changed = 0;

  for (const suggestion of release.suggestions) {
    const version = suggestion.version.trim();
    if (!version || normalise(version) === "unchanged") continue;

    const services = byName.get(normalise(suggestion.service));
    if (!services || services.length === 0) {
      missing.push(suggestion.service);
      continue;
    }
    for (const service of services) {
      const key = serviceVersionKey(service);
      versions[key] = version;
      applied += 1;
      if ((current[key] ?? "").trim() !== version) changed += 1;
    }
  }

  return { versions, applied, changed, missing };
}

function normalise(value: string): string {
  return value.trim().toLocaleLowerCase();
}
