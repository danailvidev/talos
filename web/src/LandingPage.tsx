import { useEffect } from "react";

import sentinelVideoUrl from "../../brand/talos-film.mp4";
import { Button } from "./components/ui/button.tsx";

export function LandingPage({
  onSignIn,
}: {
  onSignIn: () => void;
}) {
  useEffect(() => {
    const previousTitle = document.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = description?.content;

    document.title = "TALOS — Automate. Orchestrate. Deliver.";
    if (description) {
      description.content =
        "TALOS connects your engineering tools and AI agents to turn tickets, signals, and schedules into work that gets done.";
    }

    return () => {
      document.title = previousTitle;
      if (description && previousDescription !== undefined) {
        description.content = previousDescription;
      }
    };
  }, []);

  return (
    <div className="h-dvh overflow-hidden bg-[oklch(0.13_0.02_260)] text-[oklch(0.96_0.01_80)] antialiased">
      <header className="relative h-full w-full overflow-hidden">
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src={sentinelVideoUrl}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[oklch(0.13_0.02_260)] via-transparent to-[oklch(0.13_0.02_260)]/40" />
        <div className="absolute inset-0 bg-gradient-to-r from-[oklch(0.13_0.02_260)]/60 via-transparent to-transparent" />

        <div className="relative z-10 flex h-full flex-col justify-between px-5 py-6 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] md:px-16 md:py-14">
          <div className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[oklch(0.72_0.14_65)] shadow-[0_0_12px_2px_oklch(0.72_0.14_65/0.6)]" />
              <span className="text-sm font-medium tracking-[0.35em] text-[oklch(0.85_0.04_70)] uppercase">
                Talos
              </span>
            </div>
            <nav className="flex items-center gap-2" aria-label="Account">
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full px-4 text-[oklch(0.95_0.03_75)] hover:bg-[oklch(0.22_0.03_260)] hover:text-[oklch(0.98_0.01_80)]"
                onClick={onSignIn}
              >
                Sign in
              </Button>
            </nav>
          </div>

          <div className="max-w-2xl">
            <h1 className="text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-[oklch(0.97_0.01_80)] md:text-6xl">
              <span className="block">Automate.</span>
              <span className="block">Orchestrate.</span>
              <span className="block">Deliver.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-[oklch(0.78_0.03_75)] md:text-lg">
              TALOS connects your engineering tools and AI agents to turn tickets, signals, and
              schedules into work that gets done.
            </p>
          </div>
        </div>
      </header>
    </div>
  );
}
