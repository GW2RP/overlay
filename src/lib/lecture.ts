import { useEffect, useRef, useState } from "react";

/** Ce qu'une lecture peut demander : une valeur qui fait l'aller-retour par
 *  JSON sans rien perdre. Pas de `Date`, de `Map` ni d'instance de classe. */
export type ValeurJson =
  | string
  | number
  | boolean
  | null
  | readonly ValeurJson[]
  | { readonly [cle: string]: ValeurJson };

export type Lecture<T> = { etat: "en-cours" } | { etat: "en-panne" } | { etat: "lu"; valeur: T };

/**
 * Une lecture du hub qui se refait quand son argument change et toutes les
 * `periodeMs` — **seulement tant que la fenêtre est à l'écran et que
 * l'argument existe**. Cachée, la fenêtre garde sa dernière lecture et ne
 * demande rien ; remontrée dans la période, elle attend le reste de la période
 * avant de relire ; un argument `null` — le point d'une lecture qui suit le
 * jeu, quand le jeu n'est pas là — arrête la minuterie.
 *
 * L'argument est ce que la lecture demande : un point pour la météo et les
 * alentours, une limite pour les scènes du jour, qui n'ont pas de point. Il
 * se compare par sa forme JSON — un point se recrée à chaque rendu, et
 * l'effet ne doit se relancer que s'il a changé de valeur —, d'où
 * `ValeurJson` : `lire` reçoit la valeur relue, pas l'objet d'origine.
 *
 * La lecture d'avant reste affichée pendant que la suivante arrive : on voit
 * ce qu'on quitte, pas un panneau vide.
 *
 * `lire` doit être une fonction de module : elle entre dans les dépendances de
 * l'effet, et un fléchage écrit dans le composant relancerait la lecture à
 * chaque rendu.
 */
export function useLecturePeriodique<A extends ValeurJson, T>(
  argument: A | null,
  actif: boolean,
  periodeMs: number,
  lire: (argument: A) => Promise<T>,
): Lecture<T> {
  const cle = argument === null ? null : JSON.stringify(argument);
  const [lecture, setLecture] = useState<Lecture<T>>({ etat: "en-cours" });
  // Quand la dernière lecture a abouti, et pour quel argument : de quoi ne pas
  // relire une fenêtre qu'on vient de remontrer. Écrite dans l'effet seulement.
  const derniere = useRef<{ cle: string; quand: number } | null>(null);

  useEffect(() => {
    if (!actif || cle === null) return;
    const valeur = JSON.parse(cle) as A;
    let parti = false;
    let minuterie: ReturnType<typeof setTimeout>;

    const tour = async () => {
      try {
        const lue = await lire(valeur);
        if (parti) return;
        derniere.current = { cle, quand: Date.now() };
        setLecture({ etat: "lu", valeur: lue });
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
  }, [cle, actif, periodeMs, lire]);

  return lecture;
}
