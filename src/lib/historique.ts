import { useCallback, useState } from "react";

/**
 * L'historique de l'éditeur de pavillon : chaque geste pose une nouvelle
 * liste de décorations, et « annuler » rend la précédente.
 *
 * On garde des listes entières, pas des opérations : les décorations sont
 * des objets qu'un geste remplace sans les muter, donc deux états voisins
 * partagent tout ce que le geste n'a pas touché, et une liste ne coûte qu'un
 * tableau de références. Un geste ne se rejoue jamais à l'envers, il se
 * relit.
 */

/** Au-delà, le plus ancien geste s'oublie. */
const GESTES_GARDES = 200;

type Etat<T> = {
  present: T;
  passe: T[];
  futur: T[];
  /** L'état tel qu'il a été lu ou enregistré : le comparer au présent dit
   *  s'il reste quelque chose à enregistrer, même après un aller-retour
   *  d'annulations. */
  enregistre: T;
};

export type Historique<T> = {
  present: T;
  peutAnnuler: boolean;
  peutRetablir: boolean;
  modifie: boolean;
  /** Avec `fusionner`, le geste prolonge le précédent au lieu d'en ouvrir
   *  un : une flèche maintenue s'annule d'un seul coup. */
  appliquer: (suivant: T, fusionner?: boolean) => void;
  annuler: () => void;
  retablir: () => void;
  /** Un nouveau départ : une autre disposition, sans passé. */
  repartir: (depart: T) => void;
  marquerEnregistre: () => void;
};

export function useHistorique<T>(depart: T): Historique<T> {
  const [etat, setEtat] = useState<Etat<T>>({ present: depart, passe: [], futur: [], enregistre: depart });

  const appliquer = useCallback((suivant: T, fusionner = false) => {
    setEtat((e) => {
      if (suivant === e.present) return e;
      if (fusionner && e.passe.length > 0) return { ...e, present: suivant, futur: [] };
      return {
        ...e,
        present: suivant,
        passe: [...e.passe, e.present].slice(-GESTES_GARDES),
        futur: [],
      };
    });
  }, []);

  const annuler = useCallback(() => {
    setEtat((e) =>
      e.passe.length === 0
        ? e
        : {
            ...e,
            present: e.passe[e.passe.length - 1],
            passe: e.passe.slice(0, -1),
            futur: [e.present, ...e.futur],
          },
    );
  }, []);

  const retablir = useCallback(() => {
    setEtat((e) =>
      e.futur.length === 0
        ? e
        : {
            ...e,
            present: e.futur[0],
            passe: [...e.passe, e.present],
            futur: e.futur.slice(1),
          },
    );
  }, []);

  const repartir = useCallback((nouveau: T) => {
    setEtat({ present: nouveau, passe: [], futur: [], enregistre: nouveau });
  }, []);

  const marquerEnregistre = useCallback(() => {
    setEtat((e) => ({ ...e, enregistre: e.present }));
  }, []);

  return {
    present: etat.present,
    peutAnnuler: etat.passe.length > 0,
    peutRetablir: etat.futur.length > 0,
    modifie: etat.present !== etat.enregistre,
    appliquer,
    annuler,
    retablir,
    repartir,
    marquerEnregistre,
  };
}
