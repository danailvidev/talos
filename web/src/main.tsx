import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { queryClient } from "./query-client.ts";
import { bootstrapTheme } from "./theme.ts";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

// Set the cached appearance before React renders to prevent a full-page flash.
bootstrapTheme();

createRoot(root).render(
  <StrictMode>
    {/*
      Outermost, above the auth gate in `App`: the 401 handler and logout both
      need to clear this cache while the app stays mounted, and the providers
      that survive navigation (job queue, timezone) read from it.
    */}
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
