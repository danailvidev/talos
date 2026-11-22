import { useState, type FormEvent } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";

import { api, type AuthUser } from "./api.ts";
import { AuthSplitCard } from "./AuthSplitCard.tsx";
import { Button } from "./components/ui/button.tsx";
import { FIELD_CLASS, Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./components/ui/input-group.tsx";
import { restoreReturnTo } from "./route-state.ts";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";

/** The sign-in page, laid out as shadcn's `login-04` block. */
export function Login({
  onLogin,
  onShowForgotPassword,
}: {
  onLogin: (user: AuthUser) => void;
  onShowForgotPassword: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const send = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void send.run(async () => {
      const session = await api.login(email, password);
      restoreReturnTo();
      onLogin(session.user);
    });
  }

  return (
    <AuthSplitCard
      onSubmit={submit}
      title="Welcome back"
      description="Sign in to manage your tasks and private loops."
    >
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
      {/* Not a `Field`: the caption row holds a button, which does not belong
          inside the `<label>` that `Field` renders. */}
      <div className={FIELD_CLASS}>
        <div className="flex items-center gap-2">
          <label htmlFor="login-password">Password</label>
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto p-0 text-[0.9375rem] text-action"
            onClick={onShowForgotPassword}
          >
            Forgot your password?
          </Button>
        </div>
        <InputGroup>
          <InputGroupInput
            id="login-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
      {send.error ? <ErrorBox>{send.error}</ErrorBox> : null}
      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={send.busy || !email || !password}
      >
        <LogIn size={15} />
        {send.busy ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-[13px] text-muted-foreground">
        Need access? Ask a TALOS administrator to create your account.
      </p>
    </AuthSplitCard>
  );
}
