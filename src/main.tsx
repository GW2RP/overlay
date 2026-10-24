import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/500.css";
import "@fontsource/eb-garamond/600.css";
import "@/styles/globals.css";

import { FenetreFiche } from "@/fenetres/fiche";
import { FenetreOverlay } from "@/fenetres/overlay";
import { FenetrePrincipale } from "@/fenetres/principale";
import { elementParAncre, FENETRE_FICHE, FENETRE_PAVILLON } from "@/lib/overlays";

// L'éditeur de pavillon emporte three.js : chargé à part, pour que les
// fenêtres posées sur le jeu — toutes chargent cette page — ne le parsent pas.
const FenetrePavillon = lazy(() =>
  import("@/fenetres/pavillon").then((module) => ({ default: module.FenetrePavillon })),
);

/**
 * Toutes les fenêtres chargent la même page ; l'ancre de leur adresse dit
 * laquelle elles sont (`url` dans `tauri.conf.json`). Pas de routeur : une
 * fenêtre ne navigue jamais, elle est ce qu'elle est.
 */
const ancre = window.location.hash;
const element = elementParAncre(ancre);
const fiche = ancre === FENETRE_FICHE.ancre;
const pavillon = ancre === FENETRE_PAVILLON.ancre;
// L'éditeur de pavillon est une fenêtre à chrome, posée sur le parchemin comme
// la principale.
document.body.dataset.fenetre = element || fiche ? "overlay" : "principale";

createRoot(document.getElementById("racine") as HTMLElement).render(
  <StrictMode>
    {pavillon ? (
      <Suspense fallback={null}>
        <FenetrePavillon />
      </Suspense>
    ) : fiche ? (
      <FenetreFiche />
    ) : element ? (
      <FenetreOverlay element={element} />
    ) : (
      <FenetrePrincipale />
    )}
  </StrictMode>,
);
