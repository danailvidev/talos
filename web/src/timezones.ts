/**
 * Real IANA zone names where the browser supports listing them, so "Timezone"
 * is a dropdown of places rather than a field where someone has to already
 * know the string "Europe/Sofia". Falls back to empty on a browser without
 * `Intl.supportedValuesOf`.
 */
export function supportedTimezones(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  try {
    return supportedValuesOf ? supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/** Match "new york" to America/New_York, "sofia" to Europe/Sofia, etc. */
export function matchesTimezoneQuery(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const compact = (value: string) => value.toLowerCase().replace(/[_\s/-]+/g, "");
  return label.toLowerCase().includes(q) || compact(label).includes(compact(q));
}
