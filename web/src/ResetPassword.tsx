import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";

import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { AUTH_BRAND_CLASS, AUTH_CARD_CLASS, AUTH_PAGE_CLASS } from "./app-styles.ts";
import { Logo } from "./Logo.tsx";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";

export function ResetPassword({
  token,
  onReset,
  onShowLogin,
}: {
  token: string;
  onReset: () => void;
  onShowLogin: () => void;
}) {
  const [password, setPassword] = useState("");
  const send = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void send.run(async () => {
      await api.resetPassword(token, password);
      onReset();
    });
  }

  return (
    <main className={AUTH_PAGE_CLASS}>
      <form className={AUTH_CARD_CLASS} onSubmit={submit}>
        <div className={AUTH_BRAND_CLASS}>
          <Logo size={38} variant="horizontal" />
        </div>
        <div>
          <h1 className={PAGE_TITLE_CLASS}>Choose a new password</h1>
          <p>Set a new password for your account.</p>
        </div>
        <Field label="New password" hint="At least 10 characters">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {send.error ? <ErrorBox>{send.error}</ErrorBox> : null}
        <Button type="submit" disabled={send.busy || password.length < 10}>
          <KeyRound size={15} />
          {send.busy ? "Saving…" : "Set new password"}
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-[0.9375rem] text-action"
          onClick={onShowLogin}
        >
          Back to sign in
        </Button>
      </form>
    </main>
  );
}
