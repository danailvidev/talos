import type { TicketBoardColumnView, TicketBoardView, TicketCluster } from "../api.ts";
import { ticketNodeOf } from "./ticket.ts";

/**
 * Jira columns are configuration, not workflow status names. One column may own
 * several status ids (`New` and `Open` both belong to `Dev Queue` on the current
 * board), so the server sends Jira's mapping and the client preserves it.
 */
export type BoardColumn = TicketBoardColumnView;

export const OTHER_COLUMN: BoardColumn = {
  id: "jira:unmapped",
  name: "Other",
  statusIds: [],
};

/**
 * The columns to draw. A valid Jira board response normally needs no catch-all;
 * it appears only for a degraded/fallback payload whose ticket status was not in
 * the board configuration, and therefore no longer absorbs ordinary Jira cards.
 */
export function boardColumns(
  board: TicketBoardView | undefined,
  clusters: readonly TicketCluster[],
): BoardColumn[] {
  if (board?.columns.length) {
    const unmapped = clusters.filter(
      (cluster) => columnOf(cluster, board.columns) === OTHER_COLUMN.id,
    );
    // A completely unmapped result means Jira's board configuration and issue
    // statuses disagree (common with cross-space boards). Status-name columns
    // are more useful than one giant Other bucket and remain honest about what
    // Jira returned.
    if (clusters.length > 0 && unmapped.length === clusters.length) {
      return statusColumns(clusters);
    }
    return unmapped.length > 0
      ? [...board.columns, OTHER_COLUMN]
      : [...board.columns];
  }

  return statusColumns(clusters);
}

function statusColumns(clusters: readonly TicketCluster[]): BoardColumn[] {
  const byStatus = new Map<string, BoardColumn>();
  for (const cluster of clusters) {
    const facts = ticketNodeOf(cluster)?.ticket;
    const name = facts?.status;
    if (!name) continue;
    const id = `jira:fallback:${facts.statusId ?? name}`;
    if (!byStatus.has(id)) {
      byStatus.set(id, {
        id,
        name,
        statusIds: facts.statusId ? [facts.statusId] : [],
      });
    }
  }
  const columns = [...byStatus.values()];
  return clusters.some((cluster) => !ticketNodeOf(cluster)?.ticket?.status)
    ? [...columns, OTHER_COLUMN]
    : columns;
}

export function columnOf(
  cluster: TicketCluster,
  columns: readonly BoardColumn[],
): string {
  if (cluster.columnId && columns.some((column) => column.id === cluster.columnId)) {
    return cluster.columnId;
  }
  const statusId = ticketNodeOf(cluster)?.ticket?.statusId;
  const mapped = statusId
    ? columns.find((column) => column.statusIds.includes(statusId))
    : undefined;
  if (mapped) return mapped.id;
  const status = ticketNodeOf(cluster)?.ticket?.status;
  const fallback = status
    ? columns.find((column) => column.id === `jira:fallback:${statusId ?? status}`)
    : undefined;
  return fallback?.id ?? OTHER_COLUMN.id;
}
