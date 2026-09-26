import { useEffect, useRef, useState } from "react";

import type { Point } from "@/lib/carte";

export type Lecture<T> = { etat: "en-cours" } | { etat: "en-panne" } | { etat: "lu"; valeur: T };

/**
 * Une lecture du hub qui se refait quand son point change et toutes les
 * `periodeMs` — **seulement tant que la fenêtre est à l'écran et que le point
 * existe**. Cachée, la fenêtre garde sa dernière lecture et ne demande rien ;
 * remontrée dans la période, elle attend le reste de la période avant de
 * relire ; sans jeu, le point disparaît et la minuterie avec lui.
 *
 * La lecture d'avant reste affichée pendant que la suivante arrive : on voit
 * ce qu'on quitte, pas un panneau vide.
 *
 * `lire` doit être une fonction de module : elle entre dans les dépendances de
 * l'effet, et un fléchage écrit dans le composant relancerait la lecture à
 * chaque rendu.
 */
export function useLecturePeriodique<T>(
  point: Point | null,
  actif: boolean,
  periodeMs: number,
  lire: (point: Point) => Promise<T>,
): Lecture<T> {
  const x = point?.x ?? null;
  const y = point?.y ?? null;
  const [lecture, setLecture] = useState<Lecture<T>>({ etat: "en-cours" });
  // Quand la dernière lecture a abouti, et pour quel point : de quoi ne pas
  // relire une fenêtre qu'on vient de remontrer. Écrite dans l'effet seulement.
  const derniere = useRef<{ cle: string; quand: number } | null>(null);

  useEffect(() => {
    if (!actif || x === null || y === null) return;
    const cle = `${x}:${y}`;
    let parti = false;
    let minuterie: ReturnType<typeof setTimeout>;

    const tour = async () => {
      try {
        const valeur = await lire({ x, y });
        if (parti) return;
        derniere.current = { cle, quand: Date.now() };
        setLecture({ etat: "lu", valeur });
      } catch {
        if (!parti) setLecture({ etat: "en-panne" });
      }
      if (!parti) minuterie = setTimeout(tour, periodeMs);
    };

    const age = derniere.current?.cle === cle ? Date.now() - derniere.current.quand : Infinity;
    minuterie = setTimeout(tour, Math.max(periodeMs - age, 0));
    return () => {
      parti = true;
      clearTimeout(minuterie);
    };
  }, [x, y, actif, periodeMs, lire]);

  return lecture;
}
