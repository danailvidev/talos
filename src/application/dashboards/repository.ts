import type { Widget } from "../../../shared/dashboard.ts";

/** One saved dashboard. Query results are never stored. */
export interface StoredDashboard {
  id: string;
  ownerUserId: string;
  name: string;
  description?: string;
  widgets: Widget[];
  createdAt: string;
  updatedAt: string;
}

export interface NewDashboard {
  ownerUserId: string;
  name: string;
  description?: string;
  widgets: Widget[];
}

export interface DashboardRepository {
  list(ownerUserId: string): StoredDashboard[];
  get(ownerUserId: string, id: string): StoredDashboard | null;
  insert(row: NewDashboard): StoredDashboard;
  update(
    ownerUserId: string,
    id: string,
    patch: { name?: string; description?: string | null; widgets?: Widget[] },
  ): StoredDashboard | null;
  delete(ownerUserId: string, id: string): boolean;
}
