import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useAbility } from "@casl/react";
import {
  Check,
  ChevronRight,
  Copy,
  Info,
  Link,
  Pencil,
  RefreshCw,
  Search,
  ShieldPlus,
  Trash2,
  UserPlus,
} from "lucide-react";

import {
  api,
  type AdminFeedbackEntryView,
  type AdminLogLineView,
  type AdminRoleView,
  type AdminUserDetailView,
  type AdminUserInvitationView,
  type AdminUserView,
  type AppPermission,
  type OrchestrationView,
  type RoleReference,
} from "./api.ts";
import {
  PERMISSION_DEFINITIONS,
  type AppAbility,
} from "../../shared/authorization.ts";
import type { FeedbackPublicationReason } from "../../shared/api-contract.ts";
import type { AdminTab } from "./router.ts";
import { Button } from "./components/ui/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { useFormat } from "./FormatContext.tsx";
import { cn } from "./lib/utils.ts";
import { Tip } from "./Tip.tsx";
import { PAGE_META_CLASS, PAGE_TITLE_CLASS } from "./typography-styles.ts";

interface UserFields {
  name: string;
  email: string;
  roleId: string;
}

const EMPTY_USER: UserFields = {
  name: "",
  email: "",
  roleId: "qa",
};

export function AdminPage({
  tab,
  currentUserId,
  onSetTab,
}: {
  tab: AdminTab;
  currentUserId: string;
  onSetTab: (tab: AdminTab) => void;
}) {
  const ability = useAbility<AppAbility>();
  const canManageUsers = ability.can("manage", "User");
  const canReadLogs = ability.can("read", "ApplicationLog");
  const canManageOrchestration = ability.can("manage", "InstanceSettings");

  useEffect(() => {
    if (
      (tab === "users" || tab === "roles" || tab === "feedback") &&
      !canManageUsers &&
      (canReadLogs || canManageOrchestration)
    ) {
      onSetTab(canReadLogs ? "logs" : "orchestration");
    }
    if (tab === "logs" && !canReadLogs) {
      if (canManageUsers) onSetTab("users");
      else if (canManageOrchestration) onSetTab("orchestration");
    }
    if (tab === "orchestration" && !canManageOrchestration) {
      if (canManageUsers) onSetTab("users");
      else if (canReadLogs) onSetTab("logs");
    }
  }, [tab, canManageUsers, canReadLogs, canManageOrchestration, onSetTab]);

  return (
    <div className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12">
      <header>
        <h1 className={PAGE_TITLE_CLASS}>Administration</h1>
        <p className={PAGE_META_CLASS}>
          Manage access to this TALOS instance and inspect recent server activity.
        </p>
      </header>
      <Tabs value={tab} onValueChange={(value) => onSetTab(value as AdminTab)}>
        <TabsList variant="line">
          {canManageUsers ? <TabsTrigger value="users">Users</TabsTrigger> : null}
          {canManageUsers ? <TabsTrigger value="roles">Roles & permissions</TabsTrigger> : null}
          {canManageUsers ? <TabsTrigger value="feedback">Feedback</TabsTrigger> : null}
          {canReadLogs ? <TabsTrigger value="logs">Logs</TabsTrigger> : null}
          {canManageOrchestration ? (
            <TabsTrigger value="orchestration">Agent pool</TabsTrigger>
          ) : null}
        </TabsList>
        {canManageUsers ? (
          <TabsContent value="roles" className="tab-panel flex-none text-inherit">
            <RolesPanel />
          </TabsContent>
        ) : null}
        {canManageUsers ? (
          <TabsContent value="users" className="tab-panel flex-none text-inherit">
            <UsersPanel currentUserId={currentUserId} />
          </TabsContent>
        ) : null}
        {canManageUsers ? (
          <TabsContent value="feedback" className="tab-panel flex-none text-inherit">
            <FeedbackPanel />
          </TabsContent>
        ) : null}
        {canReadLogs ? (
          <TabsContent value="logs" className="tab-panel flex-none text-inherit">
            <LogsPanel />
          </TabsContent>
        ) : null}
        {canManageOrchestration ? (
          <TabsContent value="orchestration" className="tab-panel flex-none text-inherit">
            <OrchestrationPanel />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function OrchestrationPanel() {
  const ability = useAbility<AppAbility>();
  const canManageJobs = ability.can("manage", "Task");
  const [view, setView] = useState<OrchestrationView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);
  const [changingJob, setChangingJob] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setView(await api.adminOrchestration());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setDraining = async (draining: boolean) => {
    setChanging(true);
    setError("");
    try {
      if (draining) await api.drainOrchestration();
      else await api.resumeOrchestration();
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setChanging(false);
    }
  };

  const changeJob = async (
    jobId: string,
    action: "hold" | "resume" | "up" | "down" | "cancel",
  ) => {
    const job = view?.jobs.find((item) => item.id === jobId);
    if (!job) return;
    setChangingJob(jobId);
    setError("");
    try {
      if (action === "hold") await api.holdJob(jobId);
      else if (action === "resume") await api.resumeJob(jobId);
      else if (action === "cancel") await api.cancelJob(jobId);
      else await api.setJobPriority(jobId, job.priority + (action === "up" ? 1 : -1));
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setChangingJob("");
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Agent pool</h2>
          <p className="text-sm text-muted-foreground">
            Durable capacity, runtime ownership, and reconciliation status.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw />
            Refresh
          </Button>
          <Button
            variant={view?.capacity.draining ? "default" : "destructive"}
            onClick={() => void setDraining(!view?.capacity.draining)}
            disabled={!view || changing}
          >
            {view?.capacity.draining ? "Resume admissions" : "Drain pool"}
          </Button>
        </div>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {loading && !view ? (
        <div className="py-6 text-sm text-muted-foreground">Loading agent pool…</div>
      ) : view ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Total", view.capacity.total],
              ["Occupied", view.capacity.occupied],
              ["Available", view.capacity.available],
              ["Interactive reserve", view.capacity.interactiveReservation],
              ["Uncertain", view.capacity.uncertain],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-2xl font-semibold">{value}</div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium">Checkpoint suspension</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {view.suspension.supported
                    ? `Provider ${view.suspension.provider} supports protocol ${view.suspension.protocolVersion}.`
                    : view.suspension.reason}
                </p>
              </div>
              <span className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium",
                view.suspension.supported
                  ? "bg-success/15 text-success"
                  : "bg-muted text-muted-foreground",
              )}>
                {view.suspension.supported ? "Available" : "Unavailable"}
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              {([
                ["Cooperative boundary", view.suspension.cooperativeCheckpoint],
                ["Durable workspace", view.suspension.durableWorkspace],
                ["Durable session", view.suspension.durableSession],
                ["Effect fencing", view.suspension.replaySafeEffects],
              ] as const).map(([label, available]) => (
                <div key={String(label)}>
                  {available ? "✓" : "—"} {label}
                </div>
              ))}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Installation {view.installationId}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>Workload</TableHead>
                <TableHead>Lane</TableHead>
                <TableHead>Slot</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.attempts.map((attempt) => (
                <TableRow key={attempt.id}>
                  <TableCell>{attempt.state}</TableCell>
                  <TableCell>{attempt.workloadKind}</TableCell>
                  <TableCell>{attempt.lane}</TableCell>
                  <TableCell>{attempt.slot}</TableCell>
                  <TableCell className="max-w-64 truncate">
                    {attempt.runtimeId ?? attempt.runtimeKind}
                  </TableCell>
                  <TableCell className="max-w-72">{attempt.reason ?? "—"}</TableCell>
                  <TableCell>{new Date(attempt.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {view.attempts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No agent attempts recorded.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          {view.checkpoints.length > 0 ? (
            <>
              <div className="mt-3">
                <h3 className="font-medium">Checkpoints</h3>
                <p className="text-sm text-muted-foreground">
                  Durable suspension artifacts and resume lifecycle.
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Execution</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.checkpoints.map((checkpoint) => (
                    <TableRow key={checkpoint.id}>
                      <TableCell>{checkpoint.status}</TableCell>
                      <TableCell>{checkpoint.provider}</TableCell>
                      <TableCell className="max-w-64 truncate">
                        {checkpoint.executionId}
                      </TableCell>
                      <TableCell>{checkpoint.reason ?? "—"}</TableCell>
                      <TableCell>
                        {new Date(checkpoint.createdAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : null}
          <div className="mt-3">
            <h3 className="font-medium">Recent jobs</h3>
            <p className="text-sm text-muted-foreground">
              Waiting reasons and administrative queue controls.
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Waiting reason</TableHead>
                {canManageJobs ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{job.status}</TableCell>
                  <TableCell>{job.kind}</TableCell>
                  <TableCell>{job.subjectKey ?? job.id}</TableCell>
                  <TableCell>{job.priority}</TableCell>
                  <TableCell>{job.attempts}/{job.maxAttempts}</TableCell>
                  <TableCell className="max-w-80">{job.waitingReason ?? "—"}</TableCell>
                  {canManageJobs ? (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {job.status === "queued" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={changingJob === job.id}
                            onClick={() => void changeJob(job.id, "hold")}
                          >
                            Hold
                          </Button>
                        ) : job.status === "held" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={changingJob === job.id}
                            onClick={() => void changeJob(job.id, "resume")}
                          >
                            Resume
                          </Button>
                        ) : null}
                        {job.status === "queued" || job.status === "held" ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={changingJob === job.id}
                              onClick={() => void changeJob(job.id, "up")}
                            >
                              Priority +
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={changingJob === job.id}
                              onClick={() => void changeJob(job.id, "down")}
                            >
                              Priority −
                            </Button>
                          </>
                        ) : null}
                        {job.status === "queued" || job.status === "held" || job.status === "running" ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={changingJob === job.id}
                            onClick={() => void changeJob(job.id, "cancel")}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {view.jobs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={canManageJobs ? 7 : 6}
                    className="text-center text-muted-foreground"
                  >
                    No jobs recorded.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </>
      ) : null}
    </section>
  );
}

function UsersPanel({ currentUserId }: { currentUserId: string }) {
  const fmt = useFormat();
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [roles, setRoles] = useState<AdminRoleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AdminUserView | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminUserView | null>(null);
  const [invitation, setInvitation] = useState<AdminUserInvitationView | null>(null);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [fields, setFields] = useState<UserFields>(EMPTY_USER);
  const [saving, setSaving] = useState(false);
  const [issuingInvitation, setIssuingInvitation] = useState(false);
  const [detail, setDetail] = useState<AdminUserDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [usersResponse, rolesResponse] = await Promise.all([
        api.adminUsers(),
        api.adminRoles(),
      ]);
      setUsers(usersResponse.users);
      setRoles(rolesResponse.roles);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!editing || editing === "new") {
      setDetail(null);
      setDetailLoading(false);
      setDetailError("");
      return;
    }
    let current = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    void api.adminUser(editing.id).then(
      (value) => {
        if (current) setDetail(value);
      },
      (err) => {
        if (current) setDetailError(messageOf(err));
      },
    ).finally(() => {
      if (current) setDetailLoading(false);
    });
    return () => {
      current = false;
    };
  }, [editing]);

  const openCreate = () => {
    setFields({
      ...EMPTY_USER,
      roleId: roles.find((role) => role.id === "qa")?.id ?? roles[0]?.id ?? "",
    });
    setError("");
    setEditing("new");
  };

  const openEdit = (user: AdminUserView) => {
    setFields({
      name: user.name,
      email: user.email,
      roleId: user.role.id,
    });
    setError("");
    setEditing(user);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      if (editing === "new") {
        const created = await api.createAdminUser(fields);
        setInvitation(created);
        setInvitationCopied(false);
      } else {
        await api.updateAdminUser(editing.id, {
          name: fields.name,
          email: fields.email,
          roleId: fields.roleId,
        });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const issueInvitation = async () => {
    if (!editing || editing === "new") return;
    setIssuingInvitation(true);
    setError("");
    try {
      const created = await api.createAdminUserInvitation(editing.id);
      setInvitation(created);
      setInvitationCopied(false);
      setEditing(null);
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setIssuingInvitation(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setError("");
    try {
      await api.deleteAdminUser(deleting.id);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const editingBuiltIn =
    editing !== null && editing !== "new" && editing.builtIn;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Users</h2>
          <p className="text-sm text-muted-foreground">
            Assign one role to each user. Access changes when the role changes.
          </p>
        </div>
        <Button onClick={openCreate}>
          <UserPlus />
          Add user
        </Button>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {loading ? (
        <div className="py-6 text-sm text-muted-foreground">Loading users…</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Provider access</TableHead>
              <TableHead>Agent accounts</TableHead>
              <TableHead>Private loops</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow
                key={user.id}
                className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                tabIndex={0}
                aria-label={`${user.builtIn ? "View" : "Edit"} ${user.name}`}
                onClick={() => openEdit(user)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openEdit(user);
                  }
                }}
              >
                <TableCell className="font-medium">
                  {user.name}
                  {user.id === currentUserId ? (
                    <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                  ) : null}
                </TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell
                  className="text-muted-foreground"
                  title={user.createdAt ? fmt.stamp(user.createdAt) : undefined}
                >
                  {fmt.date(user.createdAt)}
                </TableCell>
                <TableCell>
                  <AccountStatusBadge user={user} />
                </TableCell>
                <TableCell
                  className="text-muted-foreground"
                  title={user.lastSeenAt ? fmt.stamp(user.lastSeenAt) : undefined}
                >
                  {fmt.stamp(user.lastSeenAt)}
                </TableCell>
                <TableCell>
                  <ServiceConnections connections={user.connections} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {user.agentAccountCount}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {user.ownedLoopCount}
                </TableCell>
                <TableCell><RoleBadge role={user.role} /></TableCell>
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${user.name}`}
                      disabled={user.builtIn}
                      onClick={() => openEdit(user)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${user.name}`}
                      disabled={user.builtIn || user.id === currentUserId}
                      onClick={() => setDeleting(user)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <form onSubmit={save} className="contents">
            <DialogHeader>
              <DialogTitle>
                {editing === "new" ? "Add user" : editingBuiltIn ? "User details" : "Edit user"}
              </DialogTitle>
              <DialogDescription>
                {editing === "new"
                  ? "Create an account and choose its access role. TALOS will generate a one-time invitation link."
                  : editingBuiltIn
                    ? "Built-in accounts are configured outside TALOS and cannot be edited here."
                    : "Update account details or its access role."}
              </DialogDescription>
            </DialogHeader>
            {editing && editing !== "new" ? (
              <UserOperationalDetails
                user={editing}
                detail={detail}
                loading={detailLoading}
                error={detailError}
              />
            ) : null}
            <div className="grid gap-3">
              <Field label="Name">
                <Input
                  required
                  minLength={2}
                  maxLength={80}
                  disabled={editingBuiltIn}
                  value={fields.name}
                  onChange={(event) => setFields({ ...fields, name: event.target.value })}
                />
              </Field>
              <Field label="Email">
                <Input
                  required
                  type="email"
                  disabled={editingBuiltIn}
                  value={fields.email}
                  onChange={(event) => setFields({ ...fields, email: event.target.value })}
                />
              </Field>
              <Field label="Role">
                <Select
                  disabled={editingBuiltIn}
                  value={fields.roleId}
                  onValueChange={(roleId) => setFields({ ...fields, roleId })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Inherited permissions" hint="Manage grants in Roles & permissions.">
                <div className="grid gap-2 rounded-md border border-border p-3">
                  {(roles.find((role) => role.id === fields.roleId)?.permissions ?? []).length > 0
                    ? (roles.find((role) => role.id === fields.roleId)?.permissions ?? []).map(
                        (permission) => (
                          <span key={permission} className="text-sm">
                            {permissionLabel(permission)}
                          </span>
                        ),
                      )
                    : <span className="text-sm text-muted-foreground">No privileged permissions</span>}
                </div>
              </Field>
            </div>
            <DialogFooter>
              {editing !== null &&
              editing !== "new" &&
              !editingBuiltIn &&
              editing.accountStatus === "pending" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={issuingInvitation}
                  onClick={() => void issueInvitation()}
                >
                  <Link />
                  {issuingInvitation ? "Generating…" : "Generate new invite link"}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                {editingBuiltIn ? "Close" : "Cancel"}
              </Button>
              {!editingBuiltIn ? (
                <Button type="submit" disabled={saving}>
                  {saving
                    ? "Saving…"
                    : editing === "new"
                      ? "Create invitation"
                      : "Save"}
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={invitation !== null}
        onOpenChange={(open) => {
          if (!open) setInvitation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invitation link created</DialogTitle>
            <DialogDescription>
              Send this one-time link to {invitation?.user.name}. It expires{" "}
              {invitation ? fmt.stamp(invitation.expiresAt) : ""}.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Invitation URL"
            hint="The URL contains no password. Anyone holding it can set the account password until it expires."
          >
            <div className="flex gap-2">
              <Input
                readOnly
                value={invitation?.invitationUrl ?? ""}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!invitation) return;
                  void navigator.clipboard
                    .writeText(invitation.invitationUrl)
                    .then(() => setInvitationCopied(true))
                    .catch(() => setInvitationCopied(false));
                }}
              >
                {invitationCopied ? <Check /> : <Copy />}
                {invitationCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>
          <DialogFooter>
            <Button type="button" onClick={() => setInvitation(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the account, its private data, sessions, and private loops. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

interface RoleFields {
  name: string;
  description: string;
  permissions: AppPermission[];
}

const EMPTY_ROLE: RoleFields = {
  name: "",
  description: "",
  permissions: [],
};

const PERMISSION_GROUPS = [
  "Loops",
  "Pull requests",
  "Releases",
  "Automation",
  "LogRocket",
  "Datadog",
  "Tickets",
  "Slack",
  "Administrative access",
] as const;

function RolesPanel() {
  const [roles, setRoles] = useState<AdminRoleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AdminRoleView | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminRoleView | null>(null);
  const [fields, setFields] = useState<RoleFields>(EMPTY_ROLE);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRoles((await api.adminRoles()).roles);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setFields(EMPTY_ROLE);
    setError("");
    setEditing("new");
  };

  const openEdit = (role: AdminRoleView) => {
    setFields({
      name: role.name,
      description: role.description,
      permissions: [...role.permissions],
    });
    setError("");
    setEditing(role);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      if (editing === "new") await api.createAdminRole(fields);
      else await api.updateAdminRole(editing.id, fields);
      setEditing(null);
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setError("");
    try {
      await api.deleteAdminRole(deleting.id);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Roles & permissions</h2>
          <p className="text-sm text-muted-foreground">
            Define reusable access roles. Changes apply immediately to every assigned user.
          </p>
        </div>
        <Button onClick={openCreate}>
          <ShieldPlus />
          Add role
        </Button>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {loading ? (
        <div className="py-6 text-sm text-muted-foreground">Loading roles…</div>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">Role</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead className="w-16">Users</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow
                key={role.id}
                className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                tabIndex={0}
                onClick={() => openEdit(role)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openEdit(role);
                  }
                }}
              >
                <TableCell className="overflow-hidden font-medium">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{role.name}</span>
                    {role.system ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Built-in</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="max-w-0 overflow-hidden">
                  <Tip
                    label={
                      role.permissions.length > 0
                        ? permissionsLabel(role.permissions)
                        : undefined
                    }
                  >
                    <span
                      tabIndex={role.permissions.length > 0 ? 0 : undefined}
                      className="block max-w-full truncate"
                    >
                      {permissionsLabel(role.permissions)}
                    </span>
                  </Tip>
                </TableCell>
                <TableCell>{role.userCount}</TableCell>
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${role.name}`}
                      onClick={() => openEdit(role)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${role.name}`}
                      disabled={role.system || role.userCount > 0}
                      onClick={() => setDeleting(role)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={save} className="contents">
            <DialogHeader>
              <DialogTitle>{editing === "new" ? "Add role" : "Edit role"}</DialogTitle>
              <DialogDescription>
                Select the privileged actions inherited by everyone assigned this role.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Field label="Name">
                <Input
                  required
                  minLength={2}
                  maxLength={60}
                  value={fields.name}
                  onChange={(event) => setFields({ ...fields, name: event.target.value })}
                />
              </Field>
              <Field label="Description" hint="Optional, up to 240 characters.">
                <Textarea
                  maxLength={240}
                  value={fields.description}
                  onChange={(event) => setFields({ ...fields, description: event.target.value })}
                />
              </Field>
              <Field label="Permissions">
                <div className="grid gap-4 rounded-md border border-border p-3">
                  {PERMISSION_GROUPS.map((group) => (
                    <div key={group} className="grid gap-2">
                      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        {group}
                      </div>
                      {PERMISSION_DEFINITIONS.filter(
                        (permission) => permission.group === group,
                      ).map((permission) => {
                        const id = `role-permission-${permission.id}`;
                        return (
                          <div
                            key={permission.id}
                            className="flex items-center gap-2.5"
                          >
                            <Checkbox
                              id={id}
                              checked={fields.permissions.includes(permission.id)}
                              onCheckedChange={(checked) =>
                                setFields({
                                  ...fields,
                                  permissions: checked
                                    ? [...fields.permissions, permission.id]
                                    : fields.permissions.filter(
                                        (value) => value !== permission.id,
                                      ),
                                })
                              }
                            />
                            <label
                              htmlFor={id}
                              className="cursor-pointer text-sm font-medium"
                            >
                              {permission.label}
                            </label>
                            <Tip label={permission.description}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="size-5 text-muted-foreground"
                                aria-label={`About ${permission.label}`}
                              >
                                <Info />
                              </Button>
                            </Tip>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This role is unassigned. Deleting it cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function UserOperationalDetails({
  user,
  detail,
  loading,
  error,
}: {
  user: AdminUserView;
  detail: AdminUserDetailView | null;
  loading: boolean;
  error: string;
}) {
  const fmt = useFormat();

  return (
    <div className="grid gap-3">
      <section className="rounded-lg border border-border p-3">
        <h3 className="mb-2 text-sm font-medium">Account</h3>
        <dl className="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <DetailFact label="Source" value={user.builtIn ? "Built in" : "Managed"} />
          <DetailFact label="Created" value={fmt.stamp(user.createdAt)} />
          <DetailFact label="Last seen" value={fmt.stamp(user.lastSeenAt)} />
        </dl>
        <div className="mt-2 min-w-0 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Permissions: </span>
          <EllipsizedPermissions permissions={user.permissions} />
        </div>
      </section>

      {loading ? (
        <div className="py-3 text-sm text-muted-foreground">Loading account activity…</div>
      ) : error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : detail ? (
        <>
          <section className="rounded-lg border border-border p-3">
            <h3 className="mb-2 text-sm font-medium">Provider access</h3>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <ConnectionDetail
                name="GitLab"
                active={detail.connections.gitlab}
                description={
                  detail.providerConnections.gitlab
                    ? `Updated ${fmt.stamp(detail.providerConnections.gitlab.updatedAt)}`
                    : undefined
                }
              />
              <ConnectionDetail
                name="Jira"
                active={detail.connections.jira}
                description={
                  detail.providerConnections.jira
                    ? `Updated ${fmt.stamp(detail.providerConnections.jira.updatedAt)}`
                    : undefined
                }
              />
              <ConnectionDetail
                name="Slack"
                active={detail.connections.slack}
                description={
                  detail.providerConnections.slack
                    ? [
                        detail.providerConnections.slack.workspaceName,
                        detail.providerConnections.slack.userName,
                      ].filter(Boolean).join(" · ") ||
                      (detail.providerConnections.slack.unreadable
                        ? "Needs reconnect"
                        : undefined)
                    : undefined
                }
              />
            </div>
          </section>

          <section className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Agent accounts</h3>
              <span className="text-xs text-muted-foreground">
                {detail.agentAccounts.length} configured
              </span>
            </div>
            {detail.agentAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No personal agent accounts.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {detail.agentAccounts.map((account) => (
                  <div key={account.id} className="rounded-md bg-muted px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{account.label}</span>
                      <span className="capitalize text-muted-foreground">{account.provider}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {account.account ?? account.method}
                      {account.usedForRuns ? " · used for runs" : ""}
                      {account.unreadable ? " · needs reconnect" : ""}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="grid gap-3 sm:grid-cols-2">
            <section className="rounded-lg border border-border p-3">
              <h3 className="mb-2 text-sm font-medium">Sessions</h3>
              {detail.sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active sessions.</p>
              ) : (
                <div className="grid gap-2">
                  {detail.sessions.map((session, index) => (
                    <div key={`${session.createdAt}-${index}`} className="text-sm">
                      <div>Started {fmt.stamp(session.createdAt)}</div>
                      <div className="text-xs text-muted-foreground">
                        Expires {fmt.stamp(session.expiresAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border p-3">
              <h3 className="mb-2 text-sm font-medium">Attributed jobs</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <DetailFact label="Queued" value={String(detail.jobs.queued)} />
                <DetailFact label="Running" value={String(detail.jobs.leased)} />
                <DetailFact label="Completed" value={String(detail.jobs.done)} />
                <DetailFact label="Failed" value={String(detail.jobs.dead)} />
              </dl>
            </section>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <section className="rounded-lg border border-border p-3">
              <h3 className="mb-2 text-sm font-medium">Owned private loops</h3>
              {detail.ownedLoops.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {detail.ownedLoops.map((loop) => (
                    <li key={loop.id} className="flex justify-between gap-3">
                      <span className="truncate">{loop.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fmt.date(loop.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-border p-3">
              <h3 className="mb-2 text-sm font-medium">Defaults</h3>
              <dl className="grid gap-2 text-sm">
                <DetailFact
                  label="Fix destination"
                  value={
                    detail.fixIssueDefaults
                      ? `${detail.fixIssueDefaults.projectId} · ${detail.fixIssueDefaults.targetBranch}`
                      : "Not set"
                  }
                />
                <DetailFact
                  label="Team MR repositories"
                  value={
                    detail.pullRequestRepositories.length > 0
                      ? detail.pullRequestRepositories.join(", ")
                      : "All visible repositories"
                  }
                />
              </dl>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate" title={value}>{value}</dd>
    </div>
  );
}

function ConnectionDetail({
  name,
  active,
  description,
}: {
  name: string;
  active: boolean;
  description?: string;
}) {
  return (
    <div className="rounded-md bg-muted px-3 py-2">
      <div className={cn("font-medium", active ? "text-[var(--success)]" : "text-muted-foreground")}>
        {name} · {active ? "Configured" : "Missing"}
      </div>
      {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function FeedbackPanel() {
  const fmt = useFormat();
  const [feedback, setFeedback] = useState<AdminFeedbackEntryView[]>([]);
  const [gitlabSync, setGitlabSync] = useState<
    Awaited<ReturnType<typeof api.adminFeedback>>["gitlabSync"]
  >();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<AdminFeedbackEntryView | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.adminFeedback();
      setFeedback(response.feedback);
      setGitlabSync(response.gitlabSync);
    } catch (err) {
      setFeedback([]);
      setGitlabSync(undefined);
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const remove = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setError("");
    try {
      await api.deleteAdminFeedback(id);
      setFeedback((current) => current.filter((entry) => entry.id !== id));
      setDeleting(null);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Submitted feedback</h2>
          <p className="text-sm text-muted-foreground">
            Published items are read live from GitLab; unpublished submissions remain local.
          </p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {gitlabSync?.status === "unavailable" ? (
        <ErrorBox>{feedbackSyncMessage(gitlabSync.reason)}</ErrorBox>
      ) : null}
      {loading && feedback.length === 0 ? (
        <div className="py-6 text-sm text-muted-foreground">Loading feedback…</div>
      ) : feedback.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-sm text-muted-foreground">
          No feedback has been submitted.
        </div>
      ) : (
        <div className="grid gap-3">
          {feedback.map((entry) => (
            <article key={entry.id} className="rounded-lg border border-border bg-[var(--bg-raised)] p-4">
              <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">
                    {entry.userName ?? (entry.userId ? "Deleted user" : "GitLab feedback")}
                  </span>
                  {entry.userEmail ? (
                    <span className="ml-2 text-sm text-muted-foreground">{entry.userEmail}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={entry.createdAt}
                    title={fmt.stamp(entry.createdAt)}
                  >
                    {fmt.stamp(entry.createdAt)}
                  </time>
                  {entry.publicationStatus === "pending" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${entry.title}`}
                      onClick={() => setDeleting(entry)}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </header>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{entry.title}</h3>
                {entry.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
                {entry.publicationStatus === "pending" ? (
                  <span className="rounded-full bg-[var(--warn)]/15 px-2 py-0.5 text-xs font-medium text-[var(--warn)]">
                    Pending GitLab · {feedbackPublicationReason(entry.publicationReason)}
                  </span>
                ) : null}
                {entry.issueState ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      entry.issueState === "opened"
                        ? "bg-[var(--success)]/15 text-[var(--success)]"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {entry.issueState === "opened" ? "Open" : "Closed"}
                  </span>
                ) : null}
                {entry.externalIssueUrl ? (
                  <a
                    className="text-xs font-medium text-primary hover:underline"
                    href={entry.externalIssueUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Issue #{entry.externalIssueNumber}
                  </a>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-sm">{entry.description}</p>
            </article>
          ))}
        </div>
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this feedback row?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the unpublished feedback “{deleting?.title}” and
              its retained attachments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Delete feedback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function LogsPanel() {
  const fmt = useFormat();
  const [logs, setLogs] = useState<AdminLogLineView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(500);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setLogs((await api.adminLogs(limit)).logs);
      setLastUpdated(new Date());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const counts = useMemo(() => {
    const result = { errors: 0, warnings: 0, telemetry: 0 };
    for (const log of logs) {
      if (log.level === "error" || log.level === "fatal") result.errors++;
      if (log.level === "warn") result.warnings++;
      if (isRuntimeTelemetry(log)) result.telemetry++;
    }
    return result;
  }, [logs]);

  const availableLevels = useMemo(
    () => [...new Set(logs.map((log) => log.level))].sort(compareLogLevels),
    [logs],
  );
  const latestTelemetry = useMemo(
    () => logs.find(isRuntimeTelemetry),
    [logs],
  );
  const workerCapacity = useMemo(() => {
    const startup = logs.find((log) => log.message === "talos web server started");
    return numberAt(startup?.meta, "workers");
  }, [logs]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return logs.filter((log) => {
      if (!showTelemetry && isRuntimeTelemetry(log)) return false;
      if (level !== "all" && log.level !== level) return false;
      if (!needle) return true;
      return `${log.level} ${log.message} ${log.meta ? JSON.stringify(log.meta) : ""}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [logs, query, level, showTelemetry]);

  const rangeMs =
    logs.length > 1
      ? new Date(logs[0]!.timestamp).getTime() -
        new Date(logs[logs.length - 1]!.timestamp).getTime()
      : 0;

  const toggleExpanded = (id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyLog = (log: AdminLogLineView) => {
    const text = [
      `${log.timestamp} ${log.level.toUpperCase()} ${log.message || "—"}`,
      ...(log.meta ? [JSON.stringify(log.meta, null, 2)] : []),
    ].join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(log.id);
      window.setTimeout(() => setCopiedId((id) => (id === log.id ? null : id)), 1_500);
    });
  };

  return (
    <section className="min-h-0 overflow-hidden rounded-lg border border-border bg-[var(--bg-raised)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="font-medium">Application logs</h2>
          <p className="text-sm text-muted-foreground">
            {logs.length} redacted {logs.length === 1 ? "entry" : "entries"}
            {` · ${counts.errors} error${counts.errors === 1 ? "" : "s"}`}
            {` · ${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`}
            {rangeMs > 0 ? ` · ${fmt.duration(rangeMs)} window` : ""}
            {lastUpdated ? ` · updated ${fmt.time(lastUpdated.toISOString())}` : ""}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>
      {latestTelemetry?.meta ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/25 px-4 py-2 text-xs">
          <span className="font-semibold text-foreground">Runtime now</span>
          <time
            className="text-muted-foreground"
            title={fmt.stamp(latestTelemetry.timestamp)}
          >
            {fmt.time(latestTelemetry.timestamp)}
          </time>
          {telemetrySummary(latestTelemetry.meta, workerCapacity).map((item) => (
            <span key={item} className="text-muted-foreground">
              {item}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <label className="relative min-w-52 flex-1">
          <span className="sr-only">Search application logs</span>
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search messages and metadata"
          />
        </label>
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-32" aria-label="Filter by log level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            {availableLevels.map((value) => (
              <SelectItem key={value} value={value}>
                {value.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={(value) => setLimit(Number(value))}>
          <SelectTrigger className="w-28" aria-label="Number of log entries">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[100, 250, 500, 1_000].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs font-medium">
          <Switch checked={showTelemetry} onCheckedChange={setShowTelemetry} />
          Telemetry
          {!showTelemetry && counts.telemetry > 0 ? (
            <span className="text-muted-foreground">{counts.telemetry}</span>
          ) : null}
        </label>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs font-medium">
          <Switch checked={live} onCheckedChange={setLive} />
          Live
        </label>
      </div>
      {error ? <div className="p-4 pb-0"><ErrorBox>{error}</ErrorBox></div> : null}
      {loading && logs.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">Loading logs…</div>
      ) : logs.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">No log entries yet.</div>
      ) : filtered.length === 0 ? (
        <div className="flex items-center justify-between gap-3 p-6 text-sm text-muted-foreground">
          <span>No entries match these filters.</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setLevel("all");
              setShowTelemetry(true);
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="max-h-[calc(100vh-18rem)] overflow-auto font-mono text-xs">
          <div className="sticky top-0 z-10 hidden grid-cols-[1.75rem_6.5rem_4.5rem_minmax(0,1fr)_2rem] gap-2 border-b border-border bg-[var(--bg-raised)] px-3 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase min-[901px]:grid">
            <span />
            <span>Time</span>
            <span>Level</span>
            <span>Event</span>
            <span />
          </div>
          {filtered.map((log) => {
            const isExpanded = expanded.has(log.id);
            const summary = metadataSummary(log, workerCapacity);
            return (
              <div
                key={log.id}
                className="group grid grid-cols-[1.75rem_4.5rem_3.75rem_minmax(0,1fr)_2rem] items-center gap-2 border-b border-border px-3 py-1.5 last:border-0 min-[901px]:grid-cols-[1.75rem_6.5rem_4.5rem_minmax(0,1fr)_2rem]"
              >
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={cn("text-muted-foreground", !log.meta && "invisible")}
                  aria-label={isExpanded ? "Collapse log metadata" : "Expand log metadata"}
                  aria-expanded={isExpanded}
                  aria-controls={`log-meta-${log.id}`}
                  disabled={!log.meta}
                  onClick={() => toggleExpanded(log.id)}
                >
                  <ChevronRight
                    className={cn("transition-transform", isExpanded && "rotate-90")}
                  />
                </Button>
                <time
                  className="tabular-nums text-muted-foreground"
                  dateTime={log.timestamp}
                  title={fmt.stamp(log.timestamp)}
                >
                  {fmt.time(log.timestamp)}
                </time>
                <span
                  className={cn(
                    "w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold",
                    levelClass(log.level),
                  )}
                >
                  {log.level.toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {log.message || "—"}
                    </span>
                    {summary.map((item) => (
                      <span
                        key={item}
                        className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground xl:inline"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label="Copy log entry"
                  title={copiedId === log.id ? "Copied" : "Copy log entry"}
                  onClick={() => copyLog(log)}
                >
                  {copiedId === log.id ? <Check /> : <Copy />}
                </Button>
                {isExpanded && log.meta ? (
                  <div
                    id={`log-meta-${log.id}`}
                    className="col-span-full ml-8 min-w-0 rounded-md border border-border bg-background p-3 min-[901px]:col-start-4 min-[901px]:ml-0"
                  >
                    <pre className="max-h-80 overflow-auto whitespace-pre text-[11px] leading-5 text-muted-foreground">
                      {JSON.stringify(log.meta, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const LOG_LEVEL_ORDER = ["fatal", "error", "warn", "info", "debug", "trace"];

function compareLogLevels(left: string, right: string): number {
  const leftIndex = LOG_LEVEL_ORDER.indexOf(left);
  const rightIndex = LOG_LEVEL_ORDER.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
}

function isRuntimeTelemetry(log: AdminLogLineView): boolean {
  return log.message === "runtime capacity telemetry";
}

function numberAt(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value[key];
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function telemetrySummary(
  meta: Record<string, unknown>,
  workerCapacity?: number,
): string[] {
  const result: string[] = [];
  const loopP99 = numberAt(meta, "eventLoopDelayP99Ms");
  const activeWorkers = numberAt(meta, "activeWorkers");
  const activeAgents = numberAt(meta, "activeAgents");
  const waitingAgents = recordAt(meta, "waitingAgents");
  const queue = recordAt(meta, "queue");
  const cache = recordAt(meta, "responseCache");
  const logBuffer = recordAt(meta, "logBuffer");

  if (loopP99 !== undefined) result.push(`Loop p99 ${loopP99} ms`);
  if (activeWorkers !== undefined) {
    result.push(
      `Workers ${activeWorkers}${workerCapacity !== undefined ? `/${workerCapacity}` : ""}`,
    );
  }
  if (activeAgents !== undefined) result.push(`Agents ${activeAgents} active`);
  if (waitingAgents) {
    const waiting = Object.values(waitingAgents).reduce<number>(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0,
    );
    if (waiting > 0) result.push(`${waiting} agents waiting`);
  }
  const ready = numberAt(queue, "ready");
  if (ready !== undefined) result.push(`Queue ${ready} ready`);
  if (cache) {
    const hits = numberAt(cache, "hits");
    const misses = numberAt(cache, "misses");
    if (hits !== undefined && misses !== undefined) {
      result.push(`Cache ${hits} hit · ${misses} miss`);
    }
  }
  if (logBuffer) {
    const buffered = numberAt(logBuffer, "buffered");
    const dropped = numberAt(logBuffer, "dropped");
    if ((buffered ?? 0) > 0 || (dropped ?? 0) > 0) {
      result.push(`Logs ${buffered ?? 0} buffered · ${dropped ?? 0} dropped`);
    }
  }
  return result;
}

function metadataSummary(log: AdminLogLineView, workerCapacity?: number): string[] {
  if (!log.meta) return [];
  if (isRuntimeTelemetry(log)) return telemetrySummary(log.meta, workerCapacity);

  return Object.entries(log.meta)
    .slice(0, 4)
    .map(([key, value]) => `${humanizeMetaKey(key)} ${compactMetaValue(value)}`);
}

function humanizeMetaKey(value: string): string {
  const words = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLocaleLowerCase();
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

function compactMetaValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 36 ? `${value.slice(0, 33)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return `{${Object.keys(value).length}}`;
  return String(value);
}

function RoleBadge({ role }: { role: RoleReference }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        role.id === "admin"
          ? "bg-action/15 text-action"
          : "bg-muted text-muted-foreground",
      )}
    >
      {role.name}
    </span>
  );
}

function AccountStatusBadge({
  user,
}: {
  user: AdminUserView;
}) {
  const fmt = useFormat();
  const active = user.accountStatus === "active";
  const invited = !active && user.invitationExpiresAt !== undefined;
  const label = active ? "Active" : invited ? "Invited" : "Invite expired";
  return (
    <span
      title={
        invited
          ? `Invitation expires ${fmt.stamp(user.invitationExpiresAt)}`
          : undefined
      }
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        active
          ? "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]"
          : invited
            ? "bg-action/15 text-action"
            : "bg-[var(--warn)]/15 text-[var(--warn)]",
      )}
    >
      {label}
    </span>
  );
}

function ServiceConnections({
  connections,
}: {
  connections: AdminUserView["connections"];
}) {
  return (
    <div className="flex items-center gap-1">
      {([
        ["gitlab", "GitLab"],
        ["jira", "Jira"],
        ["slack", "Slack"],
      ] as const).map(([id, label]) => {
        const active = connections[id];
        return (
          <span
            key={id}
            title={`${label}: ${active ? "personal access configured" : "personal access missing"}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium",
              active
                ? "border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                active ? "bg-[var(--success)]" : "bg-muted-foreground/45",
              )}
            />
            {label}
          </span>
        );
      })}
    </div>
  );
}

function EllipsizedPermissions({ permissions }: { permissions: AppPermission[] }) {
  const text = permissions.length > 0
    ? permissions.map(permissionLabel).join(", ")
    : "None";
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <Tip label={overflowing ? text : undefined}>
      <span ref={ref} className="block w-72 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
        {text}
      </span>
    </Tip>
  );
}

function permissionLabel(permission: AppPermission): string {
  return PERMISSION_DEFINITIONS.find(({ id }) => id === permission)?.label ?? permission;
}

function permissionsLabel(permissions: readonly AppPermission[]): string {
  return permissions.length > 0 ? permissions.map(permissionLabel).join(", ") : "None";
}

function feedbackPublicationReason(
  reason: AdminFeedbackEntryView["publicationReason"],
): string {
  if (reason === "missing_token") return "token missing";
  if (reason === "invalid_token") return "token invalid";
  if (reason === "insufficient_access") return "access denied";
  if (reason === "temporary_failure") return "temporary failure";
  return "not attempted";
}

function feedbackSyncMessage(reason: FeedbackPublicationReason): string {
  if (reason === "missing_token") {
    return "GitLab sync is unavailable because your personal token is not connected.";
  }
  if (reason === "invalid_token") {
    return "GitLab sync is unavailable because your personal token is invalid or expired.";
  }
  if (reason === "insufficient_access") {
    return "GitLab sync is unavailable because your token cannot read example-org/tools/talos.";
  }
  return "GitLab sync is temporarily unavailable. Published feedback is hidden to avoid showing stale data.";
}

function levelClass(level: string): string {
  if (level === "error" || level === "fatal") {
    return "bg-destructive/10 text-destructive";
  }
  if (level === "warn") return "bg-[var(--warn)]/10 text-[var(--warn)]";
  if (level === "debug" || level === "trace") {
    return "bg-muted text-muted-foreground";
  }
  return "bg-muted text-foreground";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
