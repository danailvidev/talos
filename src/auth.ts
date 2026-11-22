import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AuthUser as ApiAuthUser } from "../shared/api-contract.ts";
import {
  ADMIN_ROLE_ID,
  QA_ROLE_ID,
  RoleError,
  RoleService,
} from "./roles.ts";

export type AuthUser = ApiAuthUser;

interface BuiltInUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
}

const USERS: readonly BuiltInUser[] = [
  {
    id: "admin",
    email: "admin@talos.local",
    name: "Admin",
    roleId: ADMIN_ROLE_ID,
  },
  {
    id: "operator",
    email: "operator@talos.local",
    name: "Operator",
    roleId: QA_ROLE_ID,
  },
];

const SESSION_COOKIE = "talos_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const RESET_TOKEN_TTL_SECONDS = 60 * 60;
const INVITATION_TOKEN_TTL_SECONDS = 60 * 60 * 24;

/**
 * Every table keyed by `user_id` that holds only that developer's own rows, in
 * the order `deleteAccount` empties them.
 *
 * Listed here rather than reached through each repository because the repositories
 * expose no "delete everything for this user" call and should not grow one for a
 * single caller — this is one statement per table, in the module that owns the
 * account.
 *
 * Deliberately not in the list: `feedback` (messages addressed to whoever runs the
 * instance — deleting an account is not a retraction of a bug report) and
 * `task_runs`/`jobs` (install history, and `actor_id` is a record of what happened,
 * not a link to a living account).
 */
const OWNED_TABLES: readonly string[] = [
  "auth_sessions",
  "auth_reset_tokens",
  "auth_invitation_tokens",
  "auth_user_activity",
  "user_credentials",
  "user_preferences",
  "user_pull_request_repos",
  "user_fix_issue_defaults",
  "agent_accounts",
  "slack_channel_selections",
  "slack_read_cursors",
  "slack_conversation_activity",
  "slack_hidden_conversations",
  "slack_conversations",
  "slack_activity_revisions",
  "slack_oauth_states",
  "slack_connections",
];

interface RegisteredUserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role_id: string;
  account_status: "pending" | "active";
  created_at?: string;
}

/**
 * One account as its owner sees it under My profile. Wider than
 * `AuthUser`, which is what every request handler carries and deliberately stays
 * the identity and authorization data a request needs.
 */
export interface AccountProfile extends AuthUser {
  createdAt: Date | null;
  /** Most recent authenticated activity, retained after sessions end. */
  lastSeenAt: Date | null;
  /** A hardcoded `admin`/`operator` account: not editable, not deletable. */
  builtIn: boolean;
  /** Pending accounts cannot authenticate until their invitation is accepted. */
  accountStatus: "pending" | "active";
}

export interface AccountSession {
  createdAt: Date;
  expiresAt: Date;
}

export class RegistrationError extends Error {}

/**
 * Local-account authentication for a self-hosted instance. Accounts, password
 * hashes and sessions all persist in SQLite, so a restart — a deploy, or
 * `bun --watch` reloading on a file save — does not log everyone out. Sessions
 * expire seven days after they are issued.
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly roles: RoleService = new RoleService(db),
    private readonly secureCookies = false,
  ) {
    this.pruneExpired();
  }

  /**
   * Drops sessions and reset tokens that are past their expiry. Called at
   * startup rather than on a timer: an expired row is already rejected on
   * lookup, so this is housekeeping, not enforcement.
   */
  private pruneExpired(): void {
    const now = new Date().toISOString();
    this.db.run("DELETE FROM auth_sessions WHERE expires_at <= ?", [now]);
    this.db.run("DELETE FROM auth_reset_tokens WHERE expires_at <= ?", [now]);
    this.db.run("DELETE FROM auth_invitation_tokens WHERE expires_at <= ?", [now]);
  }

  async login(email: string, password: string): Promise<{
    user: AuthUser;
    cookie: string;
  } | null> {
    const normalized = email.trim().toLowerCase();
    const registered = this.db
      .query<RegisteredUserRow, [string]>(
        `SELECT id, email, name, password_hash, role_id, account_status
         FROM auth_users
         WHERE email = ?`,
      )
      .get(normalized);
    if (
      registered?.account_status === "active" &&
      registered.password_hash &&
      (await Bun.password.verify(password, registered.password_hash))
    ) {
      return this.startSession(this.toRegisteredUser(registered));
    }

    const hardcoded = USERS.find((user) => user.email === normalized);
    const builtInPassword = hardcoded ? passwordForBuiltIn(hardcoded.id) : undefined;
    return hardcoded && builtInPassword && sameString(builtInPassword, password)
      ? this.startSession(this.toBuiltInUser(hardcoded))
      : null;
  }

  /**
   * Starts a password reset for a registered account. Hardcoded accounts
   * (admin/operator) have no stored hash to replace, so they are not
   * resettable this way. Returns null both when the email is unregistered
   * and when it's hardcoded — the caller must respond identically either
   * way, so as not to reveal which accounts exist.
   */
  requestPasswordReset(email: string): string | null {
    const normalized = email.trim().toLowerCase();
    const registered = this.db
      .query<{ id: string }, [string]>("SELECT id FROM auth_users WHERE email = ?")
      .get(normalized);
    if (!registered) return null;
    const active = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM auth_users WHERE id = ? AND account_status = 'active'",
      )
      .get(registered.id);
    if (!active) return null;

    const token = crypto.randomUUID();
    const now = Date.now();
    this.db.run(
      "INSERT INTO auth_reset_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [
        token,
        registered.id,
        new Date(now).toISOString(),
        new Date(now + RESET_TOKEN_TTL_SECONDS * 1000).toISOString(),
      ],
    );
    return token;
  }

  /** Consumes a reset token and sets the new password. False if the token is missing, used, or expired. */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    // Delete first so a token is single-use even if two requests race: only the
    // statement that actually removed the row may go on to change the password.
    const entry = this.db
      .query<{ user_id: string; expires_at: string }, [string]>(
        "DELETE FROM auth_reset_tokens WHERE token = ? RETURNING user_id, expires_at",
      )
      .get(token);
    if (!entry) return false;
    if (Date.parse(entry.expires_at) <= Date.now()) return false;
    if (newPassword.length < 10) throw new RegistrationError("Password must be at least 10 characters.");

    const passwordHash = await Bun.password.hash(newPassword);
    this.db.run("UPDATE auth_users SET password_hash = ? WHERE id = ?", [
      passwordHash,
      entry.user_id,
    ]);
    this.db.run("DELETE FROM auth_sessions WHERE user_id = ?", [entry.user_id]);
    return true;
  }

  /**
   * One account as its owner sees it. Null when the id is neither built-in nor a
   * row — a session whose user was deleted, which `userFor` has already rejected.
   */
  profile(id: string): AccountProfile | null {
    const hardcoded = USERS.find((candidate) => candidate.id === id);
    if (hardcoded) {
      return {
        ...this.toBuiltInUser(hardcoded),
        createdAt: null,
        lastSeenAt: this.lastSeenAt(id),
        builtIn: true,
        accountStatus: "active",
      };
    }
    const row = this.db
      .query<RegisteredUserRow, [string]>(
        `SELECT id, email, name, password_hash, role_id, account_status,
                created_at
         FROM auth_users WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    return {
      ...this.toRegisteredUser(row),
      createdAt: row.created_at ? new Date(row.created_at) : null,
      lastSeenAt: this.lastSeenAt(id),
      builtIn: false,
      accountStatus: row.account_status,
    };
  }

  /** Every account, for the administrator's user directory. */
  users(): AccountProfile[] {
    const activity = new Map(
      this.db
        .query<{ user_id: string; last_seen_at: string }, []>(
          "SELECT user_id, last_seen_at FROM auth_user_activity",
        )
        .all()
        .map((row) => [row.user_id, new Date(row.last_seen_at)] as const),
    );
    const builtIn = USERS.map((user) => ({
      ...this.toBuiltInUser(user),
      createdAt: null,
      lastSeenAt: activity.get(user.id) ?? null,
      builtIn: true as const,
      accountStatus: "active" as const,
    }));
    const registered = this.db
      .query<RegisteredUserRow, []>(
        `SELECT id, email, name, password_hash, role_id, account_status,
                created_at
         FROM auth_users
         ORDER BY name COLLATE NOCASE, email COLLATE NOCASE`,
      )
      .all()
      .map((row) => ({
        ...this.toRegisteredUser(row),
        createdAt: row.created_at ? new Date(row.created_at) : null,
        lastSeenAt: activity.get(row.id) ?? null,
        builtIn: false as const,
        accountStatus: row.account_status,
      }));
    return [...builtIn, ...registered];
  }

  /** Active sessions for an administrator's account detail view. Tokens never leave this class. */
  sessions(id: string): AccountSession[] {
    const now = new Date().toISOString();
    return this.db
      .query<{ created_at: string; expires_at: string }, [string, string]>(
        `SELECT created_at, expires_at
           FROM auth_sessions
          WHERE user_id = ? AND expires_at > ?
          ORDER BY created_at DESC`,
      )
      .all(id, now)
      .map((row) => ({
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
      }));
  }

  /**
   * Creates a non-authenticating account and its first invitation. The plaintext
   * token exists only in the return value; SQLite receives its digest.
   */
  createInvitedUser(input: {
    name: string;
    email: string;
    roleId: string;
  }): { user: AccountProfile; token: string; expiresAt: Date } {
    const name = validName(input.name);
    const email = validEmail(input.email);
    this.validRole(input.roleId);
    this.assertEmailAvailable(email);

    const id = crypto.randomUUID();
    const createdAt = new Date();
    const invitation = newInvitation(id);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO auth_users (
           id, email, name, password_hash, role_id, created_at, account_status
         ) VALUES (?, ?, ?, NULL, ?, ?, 'pending')`,
        [id, email, name, input.roleId, createdAt.toISOString()],
      );
      this.insertInvitation(invitation);
    })();
    return { user: this.profile(id)!, token: invitation.token, expiresAt: invitation.expiresAt };
  }

  /** Revokes any previous link and issues a fresh invitation for a pending account. */
  createInvitation(id: string): { token: string; expiresAt: Date } {
    const profile = this.profile(id);
    if (!profile || profile.builtIn) {
      throw new RegistrationError("This account cannot be invited.");
    }
    if (profile.accountStatus !== "pending") {
      throw new RegistrationError("This account has already accepted its invitation.");
    }

    const invitation = newInvitation(id);
    this.db.transaction(() => {
      this.db.run("DELETE FROM auth_invitation_tokens WHERE user_id = ?", [id]);
      this.insertInvitation(invitation);
    })();
    return { token: invitation.token, expiresAt: invitation.expiresAt };
  }

  /** Expiry shown to administrators without exposing the invitation token. */
  invitationExpiresAt(id: string): Date | null {
    const now = new Date().toISOString();
    const row = this.db
      .query<{ expires_at: string }, [string, string]>(
        `SELECT expires_at FROM auth_invitation_tokens
          WHERE user_id = ? AND expires_at > ?`,
      )
      .get(id, now);
    return row ? new Date(row.expires_at) : null;
  }

  /**
   * Consumes an invitation, activates the account and starts its first session.
   * Hashing happens before token consumption so a weak password does not burn a
   * valid invitation.
   */
  async acceptInvitation(token: string, password: string): Promise<{
    user: AuthUser;
    cookie: string;
  } | null> {
    validPassword(password);
    const tokenHash = hashToken(token);
    const candidate = this.db
      .query<{ expires_at: string }, [string]>(
        "SELECT expires_at FROM auth_invitation_tokens WHERE token_hash = ?",
      )
      .get(tokenHash);
    if (!candidate) return null;
    if (Date.parse(candidate.expires_at) <= Date.now()) {
      this.db.run("DELETE FROM auth_invitation_tokens WHERE token_hash = ?", [tokenHash]);
      return null;
    }

    const passwordHash = await Bun.password.hash(password);
    const user = this.db.transaction(() => {
      const entry = this.db
        .query<{ user_id: string; expires_at: string }, [string]>(
          `DELETE FROM auth_invitation_tokens
            WHERE token_hash = ?
            RETURNING user_id, expires_at`,
        )
        .get(tokenHash);
      if (!entry || Date.parse(entry.expires_at) <= Date.now()) return null;

      const activated = this.db.run(
        `UPDATE auth_users
            SET password_hash = ?, account_status = 'active'
          WHERE id = ? AND account_status = 'pending'`,
        [passwordHash, entry.user_id],
      );
      if (activated.changes === 0) return null;
      return this.byId(entry.user_id);
    })();
    return user ? this.startSession(user) : null;
  }

  /** Updates a database-backed account. Built-in identities stay source-controlled. */
  async updateUser(
    id: string,
    input: {
      name: string;
      email: string;
      roleId: string;
    },
  ): Promise<AccountProfile> {
    if (USERS.some((candidate) => candidate.id === id)) {
      throw new RegistrationError("A built-in account cannot be edited.");
    }
    if (!this.profile(id)) throw new RegistrationError("This account no longer exists.");

    const name = validName(input.name);
    const email = validEmail(input.email);
    this.validRole(input.roleId);
    this.assertEmailAvailable(email, id);

    this.db.run("UPDATE auth_users SET name = ?, email = ?, role_id = ? WHERE id = ?", [
      name,
      email,
      input.roleId,
      id,
    ]);
    return this.profile(id)!;
  }

  /**
   * Changes the display name. The email address is not editable here on purpose:
   * it is the login, so changing it is a re-registration — and with verification
   * going through the server log there is no way to prove the new address is the
   * same person's.
   */
  rename(id: string, name: string): AccountProfile {
    if (USERS.some((candidate) => candidate.id === id)) {
      throw new RegistrationError("A built-in account's name cannot be changed.");
    }
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new RegistrationError("Name must be at least 2 characters.");
    if (trimmed.length > 80) throw new RegistrationError("Name must be 80 characters or fewer.");
    const changed = this.db.run("UPDATE auth_users SET name = ? WHERE id = ?", [trimmed, id]);
    if (changed.changes === 0) throw new RegistrationError("This account no longer exists.");
    return this.profile(id)!;
  }

  /**
   * Whether this password is the account's own — the re-entry that guards deleting
   * it. Separate from `login` because it must not mint a session: proving who you
   * are for one destructive action is not signing in again.
   */
  async verifyPassword(id: string, password: string): Promise<boolean> {
    const hardcoded = USERS.find((candidate) => candidate.id === id);
    if (hardcoded) {
      const configured = passwordForBuiltIn(hardcoded.id);
      return configured ? sameString(configured, password) : false;
    }
    const row = this.db
      .query<{ password_hash: string | null }, [string]>(
        "SELECT password_hash FROM auth_users WHERE id = ?",
      )
      .get(id);
    return row?.password_hash ? await Bun.password.verify(password, row.password_hash) : false;
  }

  /**
   * Removes the account and every row that is only its own — see `OWNED_TABLES`
   * for what that includes and what it deliberately leaves behind.
   *
   * One transaction, so a failure halfway does not leave an account whose sessions
   * are gone but whose credentials are not. Loops the developer owns are *not*
   * handled here: deleting one has to unregister it from the scheduler as well as
   * drop its row, which is the task service's job — the caller does that first and
   * this is the last step.
   *
   * Built-in accounts refuse: they come from the source, so a delete would be
   * undone by the next restart.
   */
  deleteAccount(id: string): void {
    if (USERS.some((candidate) => candidate.id === id)) {
      throw new RegistrationError("A built-in account cannot be deleted.");
    }
    this.db.transaction(() => {
      for (const table of OWNED_TABLES) {
        this.db.run(`DELETE FROM ${table} WHERE user_id = ?`, [id]);
      }
      const removed = this.db.run("DELETE FROM auth_users WHERE id = ?", [id]);
      if (removed.changes === 0) throw new RegistrationError("This account no longer exists.");
    })();
  }

  userFor(request: Request): AuthUser | null {
    const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    if (!token) return null;
    const session = this.db
      .query<{ user_id: string; expires_at: string }, [string]>(
        "SELECT user_id, expires_at FROM auth_sessions WHERE token = ?",
      )
      .get(token);
    if (!session) return null;
    if (Date.parse(session.expires_at) <= Date.now()) {
      this.db.run("DELETE FROM auth_sessions WHERE token = ?", [token]);
      return null;
    }
    const user = this.byId(session.user_id);
    if (user) this.markSeen(user.id);
    return user;
  }

  /**
   * An account by id, with no session involved.
   *
   * This is how a job resolves the `actor_id` it stored hours ago, and how a
   * scheduled tick resolves the owner of the loop it is firing — neither has a
   * request to read a cookie from.
   */
  byId(id: string): AuthUser | null {
    const hardcoded = USERS.find((candidate) => candidate.id === id);
    if (hardcoded) return this.toBuiltInUser(hardcoded);
    const registered = this.db
      .query<RegisteredUserRow, [string]>(
        `SELECT id, email, name, password_hash, role_id, account_status
           FROM auth_users WHERE id = ?`,
      )
      .get(id);
    return registered ? this.toRegisteredUser(registered) : null;
  }

  logout(request: Request): string {
    const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    if (token) this.db.run("DELETE FROM auth_sessions WHERE token = ?", [token]);
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookies ? "; Secure" : ""}`;
  }

  private startSession(user: AuthUser): { user: AuthUser; cookie: string } {
    const token = crypto.randomUUID();
    const now = Date.now();
    this.db.run(
      "INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [
        token,
        user.id,
        new Date(now).toISOString(),
        new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
      ],
    );
    this.markSeen(user.id);
    return {
      user,
      cookie:
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; ` +
        `Max-Age=${SESSION_TTL_SECONDS}${this.secureCookies ? "; Secure" : ""}`,
    };
  }

  private toRegisteredUser(user: RegisteredUserRow): AuthUser {
    const role = this.roles.get(user.role_id);
    if (!role) throw new Error(`User '${user.id}' references missing role '${user.role_id}'.`);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: { id: role.id, name: role.name },
      permissions: [...role.permissions],
    };
  }

  private toBuiltInUser(user: BuiltInUser): AuthUser {
    const role = this.roles.get(user.roleId);
    if (!role) throw new Error(`Built-in user '${user.id}' references missing role '${user.roleId}'.`);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: { id: role.id, name: role.name },
      permissions: [...role.permissions],
    };
  }

  private lastSeenAt(id: string): Date | null {
    const row = this.db
      .query<{ last_seen_at: string }, [string]>(
        "SELECT last_seen_at FROM auth_user_activity WHERE user_id = ?",
      )
      .get(id);
    return row ? new Date(row.last_seen_at) : null;
  }

  /**
   * Records authenticated use at minute precision. Requests can poll every
   * second, so rewriting the same SQLite row on every read would turn presence
   * tracking into needless write contention.
   */
  private markSeen(id: string): void {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60_000).toISOString();
    this.db.run(
      `INSERT INTO auth_user_activity (user_id, last_seen_at) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
       WHERE auth_user_activity.last_seen_at <= ?`,
      [id, now.toISOString(), cutoff],
    );
  }

  private assertEmailAvailable(email: string, exceptId?: string): void {
    if (USERS.some((user) => user.email.toLowerCase() === email && user.id !== exceptId)) {
      throw new RegistrationError("That email address is already registered.");
    }
    const duplicate = this.db
      .query<{ id: string }, [string]>("SELECT id FROM auth_users WHERE email = ?")
      .get(email);
    if (duplicate && duplicate.id !== exceptId) {
      throw new RegistrationError("That email address is already registered.");
    }
  }

  private validRole(id: string): void {
    try {
      if (!this.roles.get(id)) throw new RoleError("This role no longer exists.");
    } catch (error) {
      if (error instanceof RoleError) throw new RegistrationError(error.message);
      throw error;
    }
  }

  private insertInvitation(invitation: Invitation): void {
    this.db.run(
      `INSERT INTO auth_invitation_tokens (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [
        hashToken(invitation.token),
        invitation.userId,
        invitation.createdAt.toISOString(),
        invitation.expiresAt.toISOString(),
      ],
    );
  }
}

interface Invitation {
  token: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

function newInvitation(userId: string): Invitation {
  const createdAt = new Date();
  return {
    token: randomBytes(32).toString("base64url"),
    userId,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + INVITATION_TOKEN_TTL_SECONDS * 1000),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validName(value: string): string {
  const name = value.trim();
  if (name.length < 2) throw new RegistrationError("Name must be at least 2 characters.");
  if (name.length > 80) throw new RegistrationError("Name must be 80 characters or fewer.");
  return name;
}

function validEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RegistrationError("Enter a valid email address.");
  }
  return email;
}

function validPassword(value: string): void {
  if (value.length < 10) {
    throw new RegistrationError("Password must be at least 10 characters.");
  }
}

/**
 * Built-in accounts are recovery identities, not published default passwords.
 * A process must explicitly set the password in its environment/config/.env or
 * the account cannot log in.
 */
function passwordForBuiltIn(id: string): string | undefined {
  if (id === "admin") return process.env.TALOS_ADMIN_PASSWORD;
  if (id === "operator") return process.env.TALOS_OPERATOR_PASSWORD;
  return undefined;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function sameString(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
