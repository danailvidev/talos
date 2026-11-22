import type { GraphNode, TicketCluster } from "../api.ts";

/** The ticket root a cluster is named after — the server always emits one. */
export function ticketNodeOf(cluster: TicketCluster): GraphNode | undefined {
  return cluster.nodes.find((node) => node.kind === "ticket");
}
