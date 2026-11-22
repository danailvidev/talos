/**
 * Who a run acts as.
 *
 * Until now every loop authenticated as one shared bot token, which makes a
 * fifteen-person team indistinguishable in GitLab and Jira: every MR comment,
 * every filed ticket, every branch push carries the same name, and a developer
 * cannot tell what talos did *for them* from what it did for someone else.
 * Worse, the bot needs write access to everything anyone might automate, so the
 * blast radius of a leaked token is the whole organisation.
 *
 * An actor fixes both. It is the developer a run belongs to — the person who
 * clicked Run, who owns the loop that ticked, or who owned the loop that
 * enqueued the job a handler is now working. Their own GitLab and Jira tokens
 * are what the run authenticates with (see `secrets/actor-secrets.ts`), so
 * permissions are theirs, attribution is theirs, and revoking one person's
 * token stops exactly one person's automation.
 *
 * Optional throughout: a run with no actor falls back to the shared environment
 * credentials, which is what a single-operator install and every existing
 * schedule already do.
 */
export interface Actor {
  /** Matches `auth_users.id` (or a hardcoded account id). */
  id: string;
  name: string;
  email: string;
}
