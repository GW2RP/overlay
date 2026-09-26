import { useMemo } from "react";

import { enTyrie, projeter, unitesParPixel, type Point } from "@/lib/carte";
import { useCarte, type CarteGw2 } from "@/lib/gw2";
import { useMumble, type LienMumble } from "@/lib/mumble";

/**
 * Où le personnage se tient, dans le repère du hub.
 *
 * Cinq états, et l'écran nomme chacun :
 * - `sans-jeu` : rien n'écrit le lien, ou plus depuis la dernière lecture —
 *   le jeu est fermé, ou figé sur un chargement ;
 * - `sans-carte` : le jeu tourne mais aucune carte n'est chargée — l'écran de
 *   sélection du personnage ;
 * - `carte-inconnue` : l'API du jeu n'a pas encore décrit cette carte ;
 * - `hors-tyrie` : le personnage est sur un autre continent (les Brumes) ;
 * - `pret` : la position est projetée en pixels de continent.
 */
export type Position =
  | { etat: "sans-jeu"; lien: LienMumble | null }
  | { etat: "sans-carte"; lien: LienMumble }
  | { etat: "carte-inconnue"; lien: LienMumble }
  | { etat: "hors-tyrie"; lien: LienMumble; carte: CarteGw2 }
  | { etat: "pret"; lien: LienMumble; carte: CarteGw2; point: Point; unitesParPixel: number };

export function usePosition(): Position {
  const lien = useMumble();
  const mapId = lien && lien.actif ? lien.map_id : null;
  const carte = useCarte(mapId);

  return useMemo<Position>(() => {
    if (!lien || !lien.actif) return { etat: "sans-jeu", lien: lien ?? null };
    if (!lien.map_id) return { etat: "sans-carte", lien };
    if (!carte) return { etat: "carte-inconnue", lien };
    if (!enTyrie(carte)) return { etat: "hors-tyrie", lien, carte };
    return {
      etat: "pret",
      lien,
      carte,
      point: projeter(lien, carte),
      unitesParPixel: unitesParPixel(carte),
    };
  }, [lien, carte]);
}
