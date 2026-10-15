import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { WorkbenchProvider } from "./state.js";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <WorkbenchProvider>
      <App />
    </WorkbenchProvider>
  </StrictMode>,
);
