import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { ecrireCadre, lireCadres } from "@/lib/reglages";

/** Le délai avant d'écrire une position : un glissé produit des dizaines
 *  d'évènements, et le magasin n'a besoin que du dernier. */
const DELAI_ECRITURE = 300;

/**
 * Une fenêtre qui reprend sa place au démarrage.
 *
 * Au montage, elle relit le cadre rangé sous son étiquette et s'y pose ; puis
 * chaque déplacement et chaque redimensionnement s'écrivent, en pixels
 * physiques d'écran. Les éléments et la fiche s'en servent tous : la place
 * d'une fenêtre est à elle, pas à ce qu'elle montre.
 */
export function useCadrePersistant(label: string): void {
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fenetre = getCurrentWindow();
    let parti = false;
    const arrets: (() => void)[] = [];

    void lireCadres()
      .then(async (cadres) => {
        const cadre = cadres[label];
        if (!cadre || parti) return;
        await fenetre.setPosition(new PhysicalPosition(cadre.x, cadre.y));
        await fenetre.setSize(new PhysicalSize(cadre.largeur, cadre.hauteur));
      })
      .catch((erreur) => console.error("le cadre de la fenêtre ne se relit pas", erreur));

    const ranger = () => {
      if (minuterie.current) clearTimeout(minuterie.current);
      minuterie.current = setTimeout(async () => {
        try {
          const [position, taille] = await Promise.all([
            fenetre.outerPosition(),
            fenetre.innerSize(),
          ]);
          await ecrireCadre(label, {
            x: position.x,
            y: position.y,
            largeur: taille.width,
            hauteur: taille.height,
          });
        } catch (erreur) {
          console.error("le cadre de la fenêtre ne se range pas", erreur);
        }
      }, DELAI_ECRITURE);
    };

    void Promise.all([fenetre.onMoved(ranger), fenetre.onResized(ranger)])
      .then((stops) => {
        if (parti) stops.forEach((stop) => stop());
        else arrets.push(...stops);
      })
      .catch((erreur) => console.error("la fenêtre ne se suit pas", erreur));

    return () => {
      parti = true;
      arrets.forEach((stop) => stop());
      if (minuterie.current) clearTimeout(minuterie.current);
    };
  }, [label]);
}
