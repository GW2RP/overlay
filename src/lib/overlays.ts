import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/**
 * Les éléments d'overlay, et ce que Rust en tient.
 *
 * Chaque élément est une fenêtre déclarée dans `tauri.conf.json`, sous
 * l'étiquette `overlay-<id>`, cachée au départ. Rust la montre, la cache et
 * décide si le curseur la traverse (`src-tauri/src/overlays.rs`) ; ce module
 * n'est que le fil.
 */

export const ELEMENTS = [
  {
    id: "meteo",
    label: "overlay-meteo",
    titre: "Météo",
    ancre: "#/meteo",
  },
  {
    id: "proximite",
    label: "overlay-proximite",
    titre: "À proximité",
    ancre: "#/proximite",
  },
  {
    id: "personnage",
    label: "overlay-personnage",
    titre: "Personnage",
    ancre: "#/personnage",
  },
] as const;

export type Element = (typeof ELEMENTS)[number];
export type ElementId = Element["id"];

/** La fiche d'un lieu n'est pas un élément qu'on affiche depuis le tableau de
 *  bord : elle s'ouvre depuis « À proximité », et se ferme par sa croix. */
export const FENETRE_FICHE = { label: "overlay-fiche", titre: "Fiche du lieu", ancre: "#/fiche" } as const;

export function elementParAncre(ancre: string): Element | null {
  return ELEMENTS.find((element) => element.ancre === ancre) ?? null;
}

/** Le raccourci d'édition, tel que Rust l'enregistre (`RACCOURCI_EDITION`).
 *  Écrit ici pour l'afficher, pas pour l'écouter. */
export const RACCOURCI_EDITION = "Ctrl + Maj + O";

const EVENEMENT_EDITION = "edition";
const EVENEMENT_VISIBILITE = "overlay-visibilite";
const EVENEMENT_VERROU = "overlay-verrou";
const EVENEMENT_FICHE = "fiche";

export function montrerOverlay(label: string): Promise<void> {
  return invoke("montrer_overlay", { label });
}

export function cacherOverlay(label: string): Promise<void> {
  return invoke("cacher_overlay", { label });
}

export function overlayVisible(label: string): Promise<boolean> {
  return invoke<boolean>("overlay_visible", { label });
}

export function reglerEdition(active: boolean): Promise<void> {
  return invoke("regler_edition", { active });
}

export function basculerEdition(): Promise<void> {
  return invoke("basculer_edition");
}

/* --- Le cadenas ---------------------------------------------------------------- */

/** Où est le bouton de cadenas, en pixels CSS depuis le coin de la fenêtre :
 *  ce que `getBoundingClientRect` donne, que Rust ramène à l'écran. */
export type Zone = { x: number; y: number; width: number; height: number };

/** Ferme le cadenas, ou déplace sa zone s'il l'est déjà : le bouton se
 *  redéclare chaque fois que la fenêtre change de taille. */
export function verrouillerOverlay(label: string, zone: Zone): Promise<void> {
  return invoke("verrouiller_overlay", { label, zone });
}

export function deverrouillerOverlay(label: string): Promise<void> {
  return invoke("deverrouiller_overlay", { label });
}

export function overlayVerrouille(label: string): Promise<boolean> {
  return invoke<boolean>("overlay_verrouille", { label });
}

/* --- La fiche ------------------------------------------------------------------ */

export function ouvrirFiche(slug: string): Promise<void> {
  return invoke("ouvrir_fiche", { slug });
}

/* --- Les hooks ----------------------------------------------------------------- */

/** Demande l'état à Rust au montage, puis suit l'évènement : la fenêtre a pu
 *  être créée cachée bien avant, et l'évènement seul la laisserait sur sa
 *  valeur par défaut jusqu'au premier changement. */
function useEtatDeRust<T>(
  lire: () => Promise<T>,
  evenement: string,
  extraire: (charge: unknown) => T | undefined,
  initial: T,
): T {
  const [etat, setEtat] = useState<T>(initial);

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;

    void lire()
      .then((valeur) => {
        if (!parti) setEtat(valeur);
      })
      .catch((erreur) => console.error(`l'état « ${evenement} » ne se lit pas`, erreur));

    void listen<unknown>(evenement, (recu) => {
      // Une émission peut tomber entre le démontage et l'arrêt de l'écoute.
      if (parti) return;
      const valeur = extraire(recu.payload);
      if (valeur !== undefined) setEtat(valeur);
    })
      .then((stop) => {
        if (parti) stop();
        else arreter = stop;
      })
      .catch((erreur) => console.error(`l'état « ${evenement} » ne s'écoute pas`, erreur));

    return () => {
      parti = true;
      arreter?.();
    };
    // `lire` et `extraire` sont écrites en place par les hooks ci-dessous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evenement]);

  return etat;
}

/** Le mode d'édition en vigueur. */
export function useEdition(): boolean {
  return useEtatDeRust(
    () => invoke<boolean>("lire_edition"),
    EVENEMENT_EDITION,
    (charge) => (typeof charge === "boolean" ? charge : undefined),
    false,
  );
}

/** Le cadenas de cette fenêtre : fermé, les clics la traversent. */
export function useVerrou(label: string): boolean {
  return useEtatDeRust(
    () => overlayVerrouille(label),
    EVENEMENT_VERROU,
    (charge) => {
      const etat = charge as { label?: string; verrouille?: boolean } | null;
      return etat?.label === label && typeof etat.verrouille === "boolean"
        ? etat.verrouille
        : undefined;
    },
    false,
  );
}

/** Le lieu que la fiche montre, par son slug. */
export function useFicheCourante(): string | null {
  return useEtatDeRust(
    () => invoke<string | null>("fiche_courante"),
    EVENEMENT_FICHE,
    (charge) => (typeof charge === "string" ? charge : undefined),
    null,
  );
}

/** Quels overlays sont à l'écran, par étiquette. */
export function useVisibilites(): Record<string, boolean> {
  const [visibilites, setVisibilites] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;

    void Promise.all(
      ELEMENTS.map(async (element) => [element.label, await overlayVisible(element.label)] as const),
    )
      .then((entrees) => {
        if (!parti) setVisibilites(Object.fromEntries(entrees));
      })
      .catch((erreur) => console.error("la visibilité des overlays ne se lit pas", erreur));

    void listen<{ label: string; visible: boolean }>(EVENEMENT_VISIBILITE, (evenement) => {
      const { label, visible } = evenement.payload;
      setVisibilites((courantes) => ({ ...courantes, [label]: visible }));
    })
      .then((stop) => {
        if (parti) stop();
        else arreter = stop;
      })
      .catch((erreur) => console.error("la visibilité des overlays ne s'écoute pas", erreur));

    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  return visibilites;
}
