// Self-hosted IBM Plex (latin subsets) — bundled from local packages; no external font requests.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./design-system/tokens.css";
import "./design-system/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
