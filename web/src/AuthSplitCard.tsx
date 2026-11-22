import type { FormEvent, ReactNode } from "react";

import primaryLogoUrl from "../../rebranding/TALOS_Brand_Assets/TALOS_Brand_Kit/assets/logos/talos-logo-primary.png";
import { Logo } from "./Logo.tsx";
import { Card, CardContent } from "./components/ui/card.tsx";
import {
  AUTH_BRAND_CLASS,
  AUTH_PAGE_CLASS,
  BRAND_MARK_CLASS,
} from "./app-styles.ts";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";

/**
 * The split-card shell for sign-in: the form sits beside a brand panel that
 * drops out below `md`, where the card narrows to the same 380px column used by
 * the other authentication pages.
 */
export function AuthSplitCard({
  onSubmit,
  title,
  description,
  children,
}: {
  onSubmit: (event: FormEvent) => void;
  title: ReactNode;
  /** Said under the title, centred — what the form is for. */
  description: ReactNode;
  /** The fields, the error, the submit, the way to the other auth page. */
  children: ReactNode;
}) {
  return (
    <main className={AUTH_PAGE_CLASS}>
      <div className="w-full max-w-[380px] md:max-w-4xl">
        <Card className="border-[color-mix(in_srgb,var(--border)_72%,var(--action))] bg-[color-mix(in_srgb,var(--bg-raised)_94%,transparent)] p-0 shadow-[var(--shadow-auth)] backdrop-blur-xl">
          <CardContent className="grid p-0 md:grid-cols-2">
            <form className="flex flex-col gap-[18px] p-8" onSubmit={onSubmit}>
              <div className="flex flex-col items-center gap-1 text-center">
                {/* The panel carries the wordmark on desktop. */}
                <div className={`${AUTH_BRAND_CLASS} md:hidden`}>
                  <Logo size={34} variant="horizontal" className={BRAND_MARK_CLASS} />
                </div>
                <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
              {children}
            </form>
            <BrandPanel />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

/** The right half of the card, carrying the primary TALOS artwork. */
function BrandPanel() {
  return (
    <div className="relative hidden min-h-full overflow-hidden bg-[radial-gradient(circle_at_62%_42%,color-mix(in_srgb,var(--brand-artwork)_13%,transparent),transparent_38%),var(--brand-surface)] md:grid md:place-items-center">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--brand-artwork)_8%,transparent),transparent_42%)]"
      />
      <img
        src={primaryLogoUrl}
        alt="TALOS — Automate. Orchestrate. Deliver."
        className="relative h-full max-h-[520px] w-full object-contain p-5"
      />
    </div>
  );
}
