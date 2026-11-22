import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";

import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { AUTH_BRAND_CLASS, AUTH_CARD_CLASS, AUTH_PAGE_CLASS } from "./app-styles.ts";
import { Logo } from "./Logo.tsx";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";
import { SUCCESS_BOX_CLASS } from "./state-styles.ts";

export function ForgotPassword({ onShowLogin }: { onShowLogin: () => void }) {
  const [email, setEmail] = useState("");
  const send = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void send.run(async () => {
      await api.forgotPassword(email);
    });
  }

  return (
    <main className={AUTH_PAGE_CLASS}>
      <form className={AUTH_CARD_CLASS} onSubmit={submit}>
        <div className={AUTH_BRAND_CLASS}>
          <Logo size={38} variant="horizontal" />
        </div>
        <div>
          <h1 className={PAGE_TITLE_CLASS}>Reset your password</h1>
          <p>Enter your account email and we'll generate a reset link.</p>
        </div>
        {send.done ? (
          <div className={SUCCESS_BOX_CLASS}>
            If that email is registered, a reset link has been generated. Ask
            whoever runs this TALOS instance to check the server log for it.
          </div>
        ) : (
          <>
            <Field label="Email">
              <Input
                name="email"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            {send.error ? <ErrorBox>{send.error}</ErrorBox> : null}
            <Button type="submit" disabled={send.busy || !email}>
              <Mail size={15} />
              {send.busy ? "Sending…" : "Send reset link"}
            </Button>
          </>
        )}
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
