import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { useTheme } from "./ThemeContext.tsx";
import {
  APPEARANCES,
  APPEARANCE_LABELS,
  type Appearance,
} from "./theme.ts";
import { Button } from "./components/ui/button.tsx";
import { FormActions } from "./components/ui/field.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { cn } from "./lib/utils.ts";
import { SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { SECTION_TITLE_CLASS } from "./typography-styles.ts";

const APPEARANCE_ICONS: Record<Appearance, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** A personal preference applied immediately so the application is its preview. */
export function ThemeDialog({ onClose }: { onClose: () => void }) {
  const { appearance, setAppearance } = useTheme();

  return (
    <Modal onClose={onClose} className="max-w-145" title="Theme">
      <section className={cn(SETTINGS_SECTION_CLASS, "mt-1")}>
        <h3 className={SECTION_TITLE_CLASS}>Appearance</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {APPEARANCES.map((mode) => {
            const Icon = APPEARANCE_ICONS[mode];
            const selected = appearance === mode;
            return (
              <Button
                key={mode}
                type="button"
                variant="outline"
                className={cn(
                  "h-10 flex-row items-center justify-center gap-2 bg-[var(--bg-raised)] px-3 hover:bg-[var(--bg-hover)]",
                  selected &&
                    "border-[var(--action)] bg-[var(--action-wash)] ring-1 ring-[var(--action)]/30",
                )}
                aria-pressed={selected}
                onClick={() => setAppearance(mode)}
              >
                <Icon size={17} strokeWidth={2} />
                <strong className="text-sm text-foreground">
                  {APPEARANCE_LABELS[mode]}
                </strong>
              </Button>
            );
          })}
        </div>
      </section>

      <FormActions>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </FormActions>
    </Modal>
  );
}
