import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";

import { api, type AuthUser } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { AUTH_BRAND_CLASS, AUTH_CARD_CLASS, AUTH_PAGE_CLASS } from "./app-styles.ts";
import { Logo } from "./Logo.tsx";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";

export function AcceptInvitation({
  token,
  onAccepted,
}: {
  token: string;
  onAccepted: (user: AuthUser) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const accept = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void accept.run(async () => {
      if (password !== confirmation) throw new Error("Passwords do not match.");
      const session = await api.acceptInvitation(token, password);
      onAccepted(session.user);
    });
  }

  return (
    <main className={AUTH_PAGE_CLASS}>
      <form className={AUTH_CARD_CLASS} onSubmit={submit}>
        <div className={AUTH_BRAND_CLASS}>
          <Logo size={38} variant="horizontal" />
        </div>
        <div>
          <h1 className={PAGE_TITLE_CLASS}>Set up your TALOS account</h1>
          <p>Choose a password to accept your invitation and sign in.</p>
        </div>
        <Field label="Password" hint="At least 10 characters">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            minLength={10}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="Confirm password">
          <Input
            name="password-confirmation"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
        {accept.error ? <ErrorBox>{accept.error}</ErrorBox> : null}
        <Button
          type="submit"
          disabled={
            accept.busy ||
            password.length < 10 ||
            confirmation.length < 10
          }
        >
          <KeyRound size={15} />
          {accept.busy ? "Creating account…" : "Set password and sign in"}
        </Button>
      </form>
    </main>
  );
}
