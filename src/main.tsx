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

import { FenetreFiche } from "@/fenetres/fiche";
import { FenetreOverlay } from "@/fenetres/overlay";
import { FenetrePrincipale } from "@/fenetres/principale";
import { elementParAncre, FENETRE_FICHE } from "@/lib/overlays";

/**
 * Toutes les fenêtres chargent la même page ; l'ancre de leur adresse dit
 * laquelle elles sont (`url` dans `tauri.conf.json`). Pas de routeur : une
 * fenêtre ne navigue jamais, elle est ce qu'elle est.
 */
const ancre = window.location.hash;
const element = elementParAncre(ancre);
const fiche = ancre === FENETRE_FICHE.ancre;
document.body.dataset.fenetre = element || fiche ? "overlay" : "principale";

createRoot(document.getElementById("racine") as HTMLElement).render(
  <StrictMode>
    {fiche ? (
      <FenetreFiche />
    ) : element ? (
      <FenetreOverlay element={element} />
    ) : (
      <FenetrePrincipale />
    )}
  </StrictMode>,
);
