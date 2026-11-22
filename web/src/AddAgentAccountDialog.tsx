import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Loader2 } from "lucide-react";

import { AgentIcon } from "./AgentIcon.tsx";
import { api, type AgentCatalogEntry, type AgentLoginView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { invalidate } from "./queries.ts";
import { Input } from "./components/ui/input.tsx";
import { useAction } from "./useAction.ts";
import { DIALOG_BODY_CLASS } from "./typography-styles.ts";
import { cn } from "./lib/utils.ts";

const AGENT_FIELD_CLASS =
  "mt-3 text-[0.7812rem] text-[var(--text-dim)] [&_small]:text-[var(--text-faint)]";
const AGENT_NOTE_CLASS =
  "mt-3 flex items-center gap-1.5 text-[0.7812rem] leading-normal text-[var(--text-faint)] [&_a]:inline-flex [&_a]:items-center [&_a]:gap-[3px] [&_a]:text-muted-foreground [&_a:hover]:text-[var(--brand)]";

const inputClass = "w-full";

/** Fast enough that a printed code appears immediately, slow enough to be free. */
const POLL_MS = 1_000;

/**
 * Connecting one account to one agent.
 *
 * Two shapes behind one form, because the vendors give us two and no more: paste a
 * credential, or let TALOS run the vendor's own login on this host. Which one a
 * given option is decides what happens after Continue, and that is the only branch
 * in here — see `shared/api-contract.ts` on `AGENT_AUTH_METHODS` for why there is
 * no "Sign in with ChatGPT" button, however much this dialog looks like it wants
 * one.
 *
 * The delegated path deliberately shows the raw transcript. These CLIs change
 * their prompts between releases, and a flow that only works when we recognise
 * every line breaks silently on the next update; showing what the command actually
 * said, with a box to answer it, works even when we did not anticipate the
 * question.
 */
export function AddAgentAccountDialog({
  entry,
  secretsEnabled,
  onClose,
}: {
  entry: AgentCatalogEntry;
  secretsEnabled: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [optionId, setOptionId] = useState(entry.options[0]?.id ?? "");
  const [label, setLabel] = useState("");
  // Keyed by variable name rather than by option, so switching between the two
  // Bedrock options keeps the region you already typed — they ask for the same
  // thing and differ only in how you prove who you are.
  const [values, setValues] = useState<Record<string, string>>({});
  const connect = useAction();
  const [login, setLogin] = useState<AgentLoginView>();
  const [reply, setReply] = useState("");

  const option = entry.options.find((candidate) => candidate.id === optionId);
  const blocked = option?.method === "key" && !secretsEnabled;
  // Fields with a fixed value are the option's own switches (Bedrock's
  // CLAUDE_CODE_USE_BEDROCK=1) — the server sets those, so asking about them
  // would be a form field with one legal answer.
  const asked = (option?.fields ?? []).filter((field) => field.value === undefined);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!option || blocked) return;
    void connect.run(async () => {
      if (option.method === "key") {
        // Only what this option asked for: the state may still hold a value typed
        // for another option, and posting it would store a variable the chosen
        // option has no use for.
        const body = Object.fromEntries(
          asked.map((field) => [field.env, values[field.env]?.trim() ?? ""]),
        );
        await api.addAgentAccount({ optionId: option.id, label, values: body });
        invalidate.agentAccounts(queryClient);
        onClose();
        return;
      }
      // From here the modal is a viewer: the command owns the pace, and the poll
      // below is what moves the dialog on.
      setLogin(await api.startAgentLogin({ optionId: option.id, label }));
    });
  }

  return (
    <Modal
      onClose={onClose}
      className="max-w-140"
      title={
        <>
          <AgentIcon provider={entry.provider} size={15} />
          Add a {entry.name} account
        </>
      }
    >
      {login ? (
        <DelegatedLogin
          login={login}
          reply={reply}
          onReply={setReply}
          onUpdate={setLogin}
          onClose={onClose}
        />
      ) : (
        <form onSubmit={submit}>
          <p className={DIALOG_BODY_CLASS}>
            Name it something you will recognise in a loop's agent picker — "work ChatGPT",
            "personal Max plan". You can add more than one.
          </p>

          <Field className={AGENT_FIELD_CLASS} label="Account name">
            <Input
              className={inputClass}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="work"
              autoFocus
              required
            />
          </Field>

          <fieldset className="mt-3.5 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 text-[0.7812rem] text-[var(--text-dim)]">
              How should TALOS authenticate?
            </legend>
            {entry.options.map((candidate) => (
              <label
                key={candidate.id}
                className={cn(
                  "flex cursor-pointer items-start gap-[9px] rounded-[var(--radius)] border border-border px-2.5 py-[9px] text-sm leading-[1.45] hover:bg-[var(--bg-hover)] [&_input]:mt-0.5 [&_input]:accent-[var(--brand)] [&_strong]:block [&_strong]:font-medium [&_strong]:text-foreground",
                  candidate.id === optionId &&
                    "border-[color-mix(in_srgb,var(--brand)_45%,var(--border))] bg-[color-mix(in_srgb,var(--brand)_7%,transparent)]",
                )}
              >
                <input
                  type="radio"
                  name="agent-auth-option"
                  value={candidate.id}
                  checked={candidate.id === optionId}
                  onChange={() => setOptionId(candidate.id)}
                />
                <span>
                  <strong>{candidate.label}</strong>
                  <span className="block text-[0.7812rem] text-muted-foreground">
                    {candidate.description}
                  </span>
                  {/* The command is shown before it runs, not after: this starts a
                      process on the host, and "what exactly are you about to
                      execute" is a fair thing to want answered first. */}
                  {candidate.command ? (
                    <span className="mono mt-[5px] block text-[0.7812rem] text-[var(--text-faint)]">
                      $ {candidate.command}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>

          {asked.map((field) => (
            <Field
              className={AGENT_FIELD_CLASS}
              key={field.env}
              label={
                <>
                  {field.label ?? "Credential"}
                  {/* The variable name, because it is the thing a developer already
                      has somewhere: matching AWS_REGION against their own shell
                      profile is easier than matching "Region". */}
                  <small className="mono"> → {field.env}</small>
                  {field.optional ? <small> · optional</small> : null}
                </>
              }
            >
              <Input
                className={`${inputClass} mono`}
                // Non-secret values are shown: a region typed blind is a typo
                // waiting to fail a run an hour later.
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                value={values[field.env] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.env]: event.target.value }))
                }
                placeholder={field.hint ?? (field.secret ? "paste the credential" : "")}
                required={!field.optional}
              />
            </Field>
          ))}

          {blocked ? (
            <p className={cn(AGENT_NOTE_CLASS, "text-[var(--warn)]")}>
              Pasted credentials need an encryption key. Set <span className="mono">
                TALOS_SECRET_KEY
              </span>{" "}
              in <span className="mono">config/.env</span> and restart — or connect through the
              vendor's own login above, which leaves the credential with the vendor.
            </p>
          ) : null}

          {connect.error ? (
            <p className={cn(AGENT_NOTE_CLASS, "text-[var(--warn)]")}>{connect.error}</p>
          ) : null}

          <p className={AGENT_NOTE_CLASS}>
            <a href={entry.docs} target="_blank" rel="noreferrer">
              {entry.name} authentication docs
              <ArrowUpRight size={12} strokeWidth={2} />
            </a>
          </p>

          <FormActions>
            <Button type="submit" disabled={connect.busy || blocked || !option}>
              {connect.busy
                ? "Working…"
                : option?.method === "cli"
                  ? "Start sign-in"
                  : "Add account"}
            </Button>
            <Button type="button" variant="outline" disabled={connect.busy} onClick={onClose}>
              Cancel
            </Button>
          </FormActions>
        </form>
      )}
    </Modal>
  );
}

/**
 * The vendor's login, as it happens.
 *
 * Polls rather than streams: the payload is a whole transcript that grows a line
 * at a time, so re-reading a screenful a second is cheaper than an SSE endpoint to
 * maintain and the modal is its only reader.
 */
function DelegatedLogin({
  login,
  reply,
  onReply,
  onUpdate,
  onClose,
}: {
  login: AgentLoginView;
  reply: string;
  onReply: (value: string) => void;
  onUpdate: (view: AgentLoginView) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const answer = useAction();
  const transcript = useRef<HTMLPreElement>(null);
  const running = login.state === "running";

  useEffect(() => {
    if (!running) return;
    let live = true;
    const tick = async () => {
      try {
        const next = await api.agentLogin(login.id);
        if (live) onUpdate(next);
      } catch {
        // A finished session is forgotten a minute later, and a 404 here means the
        // poll outlived it rather than that anything went wrong. Stopping quietly
        // is the honest response: whatever the result was, it is already on screen.
        live = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [login.id, running, onUpdate]);

  // The interesting line is always the last one — a prompt, or the error that
  // ended it.
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [login.output]);

  // Connected: the catalog behind this dialog is now wrong, and so is the list of
  // agents this host is signed in to.
  useEffect(() => {
    if (login.state === "done") invalidate.agentAccounts(queryClient);
  }, [login.state, queryClient]);

  function send(event: React.FormEvent) {
    event.preventDefault();
    if (!reply.trim()) return;
    void answer.run(async () => {
      onUpdate(await api.respondAgentLogin(login.id, reply.trim()));
      onReply("");
    });
  }

  if (login.state === "done" && login.account) {
    return (
      <>
        <p className={cn(AGENT_NOTE_CLASS, "text-[var(--success)]")}>
          <Check size={13} strokeWidth={2} />
          Connected <strong>{login.account.label}</strong>
          {login.account.account ? ` as ${login.account.account}` : null}. The credential stayed
          with {login.provider} — TALOS recorded the account, not the token.
        </p>
        <FormActions>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </FormActions>
      </>
    );
  }

  return (
    <>
      <p className={DIALOG_BODY_CLASS}>
        Running <span className="mono">{login.command}</span> on this host.
      </p>

      {login.url ? (
        <p className="mt-3 flex flex-wrap items-center gap-2.5 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--brand)_40%,var(--border))] bg-[color-mix(in_srgb,var(--brand)_8%,transparent)] px-[11px] py-[9px] text-sm">
          <a
            className="inline-flex items-center gap-1 break-all text-[var(--brand)]"
            href={login.url}
            target="_blank"
            rel="noreferrer"
          >
            {login.url}
            <ArrowUpRight size={12} strokeWidth={2} />
          </a>
          {login.code ? (
            <span className="mono rounded-[var(--radius)] bg-[var(--bg-hover)] px-[7px] py-0.5 text-[0.9375rem] tracking-[0.08em] text-foreground">
              {login.code}
            </span>
          ) : null}
        </p>
      ) : running ? (
        <p className={AGENT_NOTE_CLASS}>
          <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          Waiting for it to print a sign-in link…
        </p>
      ) : null}

      <pre
        className="mono mt-2.5 max-h-47.5 overflow-y-auto rounded-[var(--radius)] border border-border bg-background px-2.5 py-[9px] text-[0.7812rem] leading-normal whitespace-pre-wrap text-[var(--text-dim)] break-words"
        ref={transcript}
      >
        {login.output || "…"}
      </pre>

      {login.error ? (
        <p className={cn(AGENT_NOTE_CLASS, "text-[var(--warn)]")}>{login.error}</p>
      ) : null}
      {answer.error ? (
        <p className={cn(AGENT_NOTE_CLASS, "text-[var(--warn)]")}>{answer.error}</p>
      ) : null}

      {running ? (
        <form onSubmit={send} className="mt-2.5 flex items-center gap-2">
          {/* Present whether or not we spotted a prompt. We cannot reliably tell
              when one of these commands is waiting on input, and a box that is
              there when it turns out to be needed beats a flow that dead-ends. */}
          <Input
            className={`${inputClass} mono`}
            value={reply}
            onChange={(event) => onReply(event.target.value)}
            placeholder="type an answer, if it asked for one"
            autoComplete="off"
          />
          <Button type="submit" variant="outline" disabled={answer.busy || !reply.trim()}>
            Send
          </Button>
        </form>
      ) : null}

      <FormActions>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (running) void api.cancelAgentLogin(login.id).catch(() => {});
            onClose();
          }}
        >
          {running ? "Cancel sign-in" : "Close"}
        </Button>
      </FormActions>
    </>
  );
}
