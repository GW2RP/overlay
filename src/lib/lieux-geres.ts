import { useCallback, useEffect, useState } from "react";

import type { Activite } from "@/lib/activite";
import { useLecturePeriodique, type Lecture } from "@/lib/lecture";
import { lieuxGeres } from "@/lib/nexus";
import { CLES, lireJeton, surChangement } from "@/lib/reglages";
import type { LieuGere } from "@/lib/types";

/**
 * Les lieux que le compte connecté tient, pour poser l'interrupteur de statut
 * sous eux dans « À proximité ».
 *
 * Les alentours sont publics et resservis par le CDN du hub : ils ne peuvent
 * pas dire qui les lit, ni porter le statut à la seconde. Cette lecture-ci
 * porte le jeton, donc elle fait les deux : elle nomme les lieux qu'on tient,
 * et leur statut y est plus frais que celui des alentours. Elle suit la
 * règle des autres — fenêtre visible seulement, toutes les cinq minutes — et
 * se refait quand le jeton change : une connexion faite depuis la fenêtre
 * principale se voit ici.
 *
 * Un statut qu'on vient d'écrire s'applique tout de suite (`ecrit`), sans
 * attendre la lecture suivante, qui le reprend ensuite.
 */

const RAFRAICHISSEMENT_MS = 5 * 60 * 1000;

/** L'argument — le numéro de session — ne sert qu'à relancer la lecture. */
const lireLieuxGeres = () => lieuxGeres();

/** Un numéro qui change à chaque changement de jeton, `null` sans jeton : de
 *  quoi relancer la lecture sans faire entrer le jeton dans sa clé. */
function useSessionCourante(): number | null {
  const [session, setSession] = useState<{ jeton: boolean; version: number }>({
    jeton: false,
    version: 0,
  });

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;
    const suivre = (jeton: string | null | undefined) =>
      setSession((avant) => ({ jeton: Boolean(jeton), version: avant.version + 1 }));
    void lireJeton().then((jeton) => {
      if (!parti) suivre(jeton);
    });
    void surChangement<string | null>(CLES.jeton, suivre).then((stop) => {
      if (parti) stop();
      else arreter = stop;
    });
    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  return session.jeton ? session.version : null;
}

export type LieuxGeres = {
  /** Les lieux tenus, par identifiant, avec le statut le plus récent connu. */
  parId: ReadonlyMap<string, LieuGere>;
  /** Range le statut que le hub vient de rendre pour un lieu. */
  ecrit: (id: string, activite: Activite) => void;
};

export function useLieuxGeres(actif: boolean): LieuxGeres {
  const session = useSessionCourante();
  const lecture = useLecturePeriodique(session, actif, RAFRAICHISSEMENT_MS, lireLieuxGeres);

  // Les statuts écrits depuis la dernière lecture. Une lecture nouvelle les
  // reprend : ils repartent de zéro avec elle.
  const [ecrits, setEcrits] = useState<{
    base: Lecture<LieuGere[]>;
    valeurs: Record<string, Activite>;
  }>({ base: lecture, valeurs: {} });
  if (ecrits.base !== lecture) setEcrits({ base: lecture, valeurs: {} });

  const ecrit = useCallback(
    (id: string, activite: Activite) =>
      setEcrits((avant) => ({ ...avant, valeurs: { ...avant.valeurs, [id]: activite } })),
    [],
  );

  // Déconnecté, on ne tient plus rien — même si la dernière lecture disait
  // le contraire.
  const lieux = session !== null && lecture.etat === "lu" ? lecture.valeur : [];
  const parId = new Map(
    lieux.map((lieu) => [lieu.id, { ...lieu, activity: ecrits.valeurs[lieu.id] ?? lieu.activity }]),
  );
  return { parId, ecrit };
}
