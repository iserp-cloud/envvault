import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import "./index.css";
import { TooltipProvider } from "./components/ui/tooltip";
import { ConfirmProvider } from "./components/ConfirmDialog";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </TooltipProvider>
  </StrictMode>,
);
