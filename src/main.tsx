import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/500.css";
import "@fontsource/eb-garamond/600.css";
import "@/styles/globals.css";

import { FenetreOverlay } from "@/fenetres/overlay";
import { FenetrePrincipale } from "@/fenetres/principale";
import { elementParAncre } from "@/lib/overlays";

/**
 * Toutes les fenêtres chargent la même page ; l'ancre de leur adresse dit
 * laquelle elles sont (`url` dans `tauri.conf.json`). Pas de routeur : une
 * fenêtre ne navigue jamais, elle est ce qu'elle est.
 */
const element = elementParAncre(window.location.hash);
document.body.dataset.fenetre = element ? "overlay" : "principale";

createRoot(document.getElementById("racine") as HTMLElement).render(
  <StrictMode>
    {element ? <FenetreOverlay element={element} /> : <FenetrePrincipale />}
  </StrictMode>,
);
