import type {
  EnvironmentVersionView,
  ManifestSection,
  ReleaseHistoryEntryView,
  ServiceVersionView,
} from "./api.ts";
import { calendarDateInTimeZone } from "./zoned-time.ts";

/** A service name is unique only within its manifest section. */
export function serviceVersionKey(
  service: Pick<ServiceVersionView, "name" | "section">,
): string {
  return `${service.section}:${service.name}`;
}

/**
 * Finds services whose versions differ between two environments, including a
 * service that exists in only one of them.
 */
export function differingServiceKeys(
  left: EnvironmentVersionView,
  right: EnvironmentVersionView,
): Set<string> {
  const leftVersions = new Map(
    left.services.map((service) => [serviceVersionKey(service), service.version]),
  );
  const rightVersions = new Map(
    right.services.map((service) => [serviceVersionKey(service), service.version]),
  );
  const keys = new Set([...leftVersions.keys(), ...rightVersions.keys()]);

  return new Set(
    [...keys].filter((key) => leftVersions.get(key) !== rightVersions.get(key)),
  );
}

interface SemanticVersion {
  core: [string, string, string];
  prerelease: string[];
}

/**
 * Parses SemVer and the manifest's legacy dotted prerelease spelling
 * (`1.2.3.dev1`, equivalent here to `1.2.3-dev1`).
 */
function parseSemanticVersion(version: string): SemanticVersion | undefined {
  const match =
    /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:(?:-|\.)([^+]+))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim(),
    );
  if (!match) return undefined;

  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        !/^[0-9A-Za-z-]+$/.test(identifier) ||
        (/^\d+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith("0")),
    )
  ) {
    return undefined;
  }

  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Compares two semantic versions. Build metadata does not affect precedence.
 * Returns undefined when either value is not a supported semantic version.
 */
export function compareSemanticVersions(
  leftVersion: string,
  rightVersion: string,
): number | undefined {
  const left = parseSemanticVersion(leftVersion);
  const right = parseSemanticVersion(rightVersion);
  if (!left || !right) return undefined;

  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifier(
      left.core[index]!,
      right.core[index]!,
    );
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const identifierCount = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

/**
 * Returns the service keys whose version is lower on each side. Services that
 * are absent on one side or have non-semantic versions are not ordered.
 */
export function lowerServiceVersionKeys(
  left: EnvironmentVersionView,
  right: EnvironmentVersionView,
): [Set<string>, Set<string>] {
  const rightVersions = new Map(
    right.services.map((service) => [serviceVersionKey(service), service.version]),
  );
  const lowerLeft = new Set<string>();
  const lowerRight = new Set<string>();

  for (const service of left.services) {
    const key = serviceVersionKey(service);
    const rightVersion = rightVersions.get(key);
    if (rightVersion === undefined) continue;

    const comparison = compareSemanticVersions(service.version, rightVersion);
    if (comparison === -1) lowerLeft.add(key);
    if (comparison === 1) lowerRight.add(key);
  }

  return [lowerLeft, lowerRight];
}

export interface PendingReleaseVersionChange {
  service: string;
  section: ManifestSection;
  previousVersion: string;
  version: string;
}

export interface SameDayDeploymentWarning {
  service: string;
  section: ManifestSection;
  previousVersion: string;
  version: string;
  authorName: string;
  authorEmail: string | null;
  committedAt: string;
  webUrl: string | null;
}

/**
 * Attributes each pending version replacement to the newest merged deployment
 * that set its current value earlier in the instance's calendar day.
 */
export function sameDayDeploymentWarnings({
  environment,
  changes,
  entries,
  now,
  timeZone,
}: {
  environment: string;
  changes: readonly PendingReleaseVersionChange[];
  entries: readonly ReleaseHistoryEntryView[];
  now: Date;
  timeZone: string;
}): SameDayDeploymentWarning[] {
  const today = calendarDateInTimeZone(now, timeZone);

  return changes.flatMap((change) => {
    if (change.version === change.previousVersion) return [];

    for (const entry of entries) {
      if (
        entry.environment !== environment ||
        calendarDateInTimeZone(entry.committedAt, timeZone) !== today
      ) {
        continue;
      }

      const deployed = entry.changes.find(
        (candidate) =>
          candidate.service === change.service &&
          (candidate.section == null || candidate.section === change.section) &&
          candidate.to === change.previousVersion,
      );
      if (!deployed) continue;

      return [
        {
          service: change.service,
          section: change.section,
          previousVersion: change.previousVersion,
          version: change.version,
          authorName: entry.authorName,
          authorEmail: entry.authorEmail,
          committedAt: entry.committedAt,
          webUrl: entry.webUrl,
        },
      ];
    }

    return [];
  });
}
