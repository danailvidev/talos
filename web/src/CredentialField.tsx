import type { ReactNode } from "react";

import type { IntegrationField } from "../../shared/integrations.ts";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";

/**
 * One credential input, shared by Settings → Integrations and My provider
 * access.
 *
 * The two surfaces edit different scopes of the same catalog — an instance
 * setting and a personal identity — so the field itself has to behave
 * identically on both, and the parts that are easy to get subtly wrong are the
 * parts worth having once: a secret field renders blank whether or not it holds
 * a value, an empty secret input therefore means "leave it alone" rather than
 * "clear it", and the autofill guards below are the difference between a form
 * that works and one a password manager fills with somebody's login.
 *
 * What differs between the surfaces is only the caption on the right — which
 * layer answers, versus whose credential answers — so that comes in as a node
 * rather than being computed here.
 */
export function CredentialFieldRow({
  field,
  /** Blank for a secret; the stored value for a non-secret one. */
  value,
  disabled,
  /** Why the input cannot be typed into, when the reason is not a save in flight. */
  lockedReason,
  /**
   * Whether a value is already in effect under this name, from any layer. Drives
   * the "leave blank to keep" placeholder, which is a statement about the
   * effective value — not about whether *this* surface stored it, which is what
   * `onClear` is about.
   */
  configured,
  /** The right-hand caption: where this value comes from. */
  origin,
  /** Rendered only when there is something stored to clear. */
  onClear,
  onEdit,
}: {
  field: IntegrationField;
  value: string;
  disabled: boolean;
  lockedReason?: string;
  configured: boolean;
  origin: ReactNode;
  onClear?: () => void;
  onEdit: (value: string) => void;
}) {
  return (
    <div className="mt-2.5">
      {/* The caption is a row of its own — label, variable name, and where the
          value came from — so it goes in as markup rather than through `label`,
          which would wrap it in a span and break its `space-between`. */}
      <Field>
        <span className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {field.label} <span className="mono">({field.name})</span>
            {field.optional ? (
              <span className="text-[var(--text-faint)] italic"> optional</span>
            ) : null}
          </span>
          {origin}
        </span>
        <div className="flex items-center gap-2">
          <Input
            className="w-full mono"
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            // `autocomplete="off"` alone doesn't stop Chrome/password managers
            // from filling a URL-then-token or email-then-token pair — it reads
            // as a login form. A field that starts read-only is never a
            // candidate for autofill; dropping read-only on focus hands control
            // back to the user before they can type, so this is invisible
            // unless something tried to autofill it. That's also why GitLab and
            // Jira showed a live Save with nothing typed: their fields are the
            // ones that most resemble a login form.
            readOnly
            onFocus={(e) => e.currentTarget.removeAttribute("readonly")}
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            value={value}
            disabled={disabled}
            placeholder={
              lockedReason
                ? lockedReason
                : field.secret && configured
                  ? "•••••••• — leave blank to keep"
                  : field.placeholder
            }
            onChange={(e) => onEdit(e.target.value)}
          />
          {onClear ? (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs whitespace-nowrap text-muted-foreground underline"
              disabled={disabled}
              onClick={onClear}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </Field>
      {field.hint ? (
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">{field.hint}</div>
      ) : null}
    </div>
  );
}

/**
 * What an edit to a secret field means.
 *
 * Blank is "untouched", not "clear it" — a secret input starts empty whether or
 * not a value is stored, so it cannot mean both, and clearing has its own
 * button. Shared because both surfaces send only what was typed, which is what
 * makes saving one card leave every other credential in place.
 */
export function applyEdit(
  edits: Record<string, string>,
  name: string,
  value: string,
  isSecret: boolean,
): Record<string, string> {
  if (isSecret && value === "") {
    if (!(name in edits)) return edits;
    const next = { ...edits };
    delete next[name];
    return next;
  }
  return { ...edits, [name]: value };
}
