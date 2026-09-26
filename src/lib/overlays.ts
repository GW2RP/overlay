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
    id: "lieux",
    label: "overlay-lieux",
    titre: "Lieux à proximité",
    ancre: "#/lieux",
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

export function elementParAncre(ancre: string): Element | null {
  return ELEMENTS.find((element) => element.ancre === ancre) ?? null;
}

/** Le raccourci d'édition, tel que Rust l'enregistre (`RACCOURCI_EDITION`).
 *  Écrit ici pour l'afficher, pas pour l'écouter. */
export const RACCOURCI_EDITION = "Ctrl + Maj + O";

const EVENEMENT_EDITION = "edition";
const EVENEMENT_VISIBILITE = "overlay-visibilite";

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

/** Le mode d'édition en vigueur : demandé à Rust au montage — la fenêtre a pu
 *  être créée cachée bien avant —, puis suivi sur l'évènement. */
export function useEdition(): boolean {
  const [edition, setEdition] = useState(false);

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;

    void invoke<boolean>("lire_edition")
      .then((initiale) => {
        if (!parti) setEdition(initiale);
      })
      .catch((erreur) => console.error("le mode d'édition ne se lit pas", erreur));

    void listen<boolean>(EVENEMENT_EDITION, (evenement) => setEdition(evenement.payload))
      .then((stop) => {
        if (parti) stop();
        else arreter = stop;
      })
      .catch((erreur) => console.error("le mode d'édition ne s'écoute pas", erreur));

    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  return edition;
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
