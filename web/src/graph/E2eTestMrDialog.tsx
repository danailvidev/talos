import { GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import type { E2eTestResultView } from "../api.ts";
import { Button } from "../components/ui/button.tsx";
import { Field, FormActions } from "../components/ui/field.tsx";
import { Modal } from "../components/ui/modal.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import { DIALOG_BODY_CLASS } from "../typography-styles.ts";

export function E2eTestMrDialog({
  result,
  busy,
  onConfirm,
  onCancel,
}: {
  result: E2eTestResultView;
  busy: boolean;
  onConfirm: (targetBranch: string) => void;
  onCancel: () => void;
}) {
  const [targetBranch, setTargetBranch] = useState("develop");
  useEffect(() => setTargetBranch("develop"), [result.jobId]);
  const sourceBranch = result.sourceBranch;

  return (
    <Modal
      onClose={onCancel}
      className="sm:max-w-160"
      title={
        <>
          <GitPullRequest size={15} strokeWidth={2} />
          Add Playwright coverage
        </>
      }
    >
      <p className={DIALOG_BODY_CLASS}>
        Talos will convert the conclusive exploratory scenarios into TypeScript Playwright tests
        in <code>example-org/webapp</code> and open a separate merge request.
      </p>

      <Field
        className="mt-4"
        label="Merge request target"
        hint={
          targetBranch === "develop"
            ? "Creates an independent coverage MR against develop."
            : "Creates a stacked coverage MR against the tested feature branch."
        }
      >
        <Select value={targetBranch} onValueChange={setTargetBranch} disabled={busy}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="develop">develop · default</SelectItem>
            {sourceBranch && sourceBranch !== "develop" ? (
              <SelectItem value={sourceBranch}>{sourceBranch} · tested source branch</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </Field>

      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Failed exploratory scenarios or a red generated test produce a draft MR. Credentials and
        environment-specific secret values are never written to the repository.
      </p>

      <FormActions>
        <Button type="button" disabled={busy} onClick={() => onConfirm(targetBranch)}>
          {busy ? "Queueing…" : "Create Playwright coverage MR"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
