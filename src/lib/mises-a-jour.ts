import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * La mise à jour automatique, depuis les releases GitHub du dépôt.
 *
 * Le manifeste (`latest.json`) est attaché à chaque release par
 * `.github/workflows/publier.yml` ; le greffon compare sa version à celle que
 * ce binaire porte, et n'annonce qu'une version **supérieure**. Rien ne
 * s'installe sans que l'on ait cliqué.
 */

/** Entre deux vérifications. L'application reste ouverte des jours durant. */
const INTERVALLE_MS = 6 * 60 * 60 * 1000;

export type Progression = {
  /** Octets reçus. */
  recus: number;
  /** La taille annoncée par le serveur, quand il l'a dite. */
  total: number | null;
};

export type EtatMiseAJour =
  | { etat: "inconnu" }
  | { etat: "recherche" }
  | { etat: "a-jour" }
  | { etat: "disponible"; miseAJour: Update }
  | { etat: "installation"; miseAJour: Update; progression: Progression }
  | { etat: "en-panne"; message: string; miseAJour: Update | null };

/** Ce qui n'a pas marché, en une phrase sur laquelle on peut agir. Les
 *  messages du greffon sont en anglais et nomment ses rouages ; le cas à part
 *  est « aucun manifeste à lire », qui est aussi ce à quoi ressemble une
 *  release encore en brouillon. */
function decrire(erreur: unknown): string {
  const message = erreur instanceof Error ? erreur.message : String(erreur);
  if (/release not found|Could not fetch a valid release/i.test(message)) {
    return "Aucune release publiée n'annonce de mise à jour.";
  }
  return `La vérification n'a pas abouti : ${message}`;
}

/**
 * Télécharge la mise à jour et la passe à l'installeur.
 *
 * Sous Windows, le greffon lance l'installeur et termine ce processus
 * lui-même : rien de ce qui suit cet appel ne s'exécute, et l'installeur
 * relance l'application (`installMode: "passive"`).
 */
async function installer(
  miseAJour: Update,
  surProgression: (progression: Progression) => void,
): Promise<void> {
  let recus = 0;
  let total: number | null = null;
  await miseAJour.downloadAndInstall((evenement) => {
    switch (evenement.event) {
      case "Started":
        total = evenement.data.contentLength ?? null;
        break;
      case "Progress":
        recus += evenement.data.chunkLength;
        break;
      case "Finished":
        recus = total ?? recus;
        break;
    }
    surProgression({ recus, total });
  });
}

/**
 * Regarde au montage, puis toutes les six heures, si une release plus récente
 * est publiée ; et offre de vérifier tout de suite et d'installer.
 *
 * Les échecs de la vérification périodique restent silencieux — pas de
 * réseau, pas encore de release —, personne ne les a demandés. Ceux d'une
 * vérification demandée s'affichent.
 */
export function useMiseAJour(): {
  version: string | null;
  etat: EtatMiseAJour;
  verifier: () => Promise<void>;
  installer: () => Promise<void>;
} {
  const [version, setVersion] = useState<string | null>(null);
  const [etat, setEtat] = useState<EtatMiseAJour>({ etat: "inconnu" });
  const enCours = useRef(false);

  const verifier = useCallback(async (silencieux = false) => {
    if (enCours.current) return;
    enCours.current = true;
    if (!silencieux) setEtat({ etat: "recherche" });
    try {
      const trouvee = await check();
      setEtat(trouvee ? { etat: "disponible", miseAJour: trouvee } : { etat: "a-jour" });
    } catch (erreur) {
      if (silencieux) console.error("la mise à jour ne se vérifie pas", erreur);
      else setEtat({ etat: "en-panne", message: decrire(erreur), miseAJour: null });
    } finally {
      enCours.current = false;
    }
  }, []);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch((erreur) => console.error("la version ne se lit pas", erreur));
    void Promise.resolve().then(() => verifier(true));
    const minuterie = setInterval(() => void verifier(true), INTERVALLE_MS);
    return () => clearInterval(minuterie);
  }, [verifier]);

  const installerCourante = useCallback(async () => {
    const miseAJour =
      etat.etat === "disponible" || etat.etat === "en-panne" ? etat.miseAJour : null;
    if (!miseAJour) return;
    setEtat({ etat: "installation", miseAJour, progression: { recus: 0, total: null } });
    try {
      await installer(miseAJour, (progression) =>
        setEtat({ etat: "installation", miseAJour, progression }),
      );
    } catch (erreur) {
      setEtat({
        etat: "en-panne",
        message: `L'installation a échoué : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
        miseAJour,
      });
    }
  }, [etat]);

  return { version, etat, verifier: () => verifier(false), installer: installerCourante };
}

/** Le pourcentage reçu, ou `null` sans total à rapporter. Un total à zéro
 *  compte comme pas de total : rien à diviser, rien à dessiner. */
export function pourcentage(progression: Progression): number | null {
  if (progression.total === null || progression.total <= 0) return null;
  return Math.min(100, Math.round((progression.recus / progression.total) * 100));
}

export function formatOctets(octets: number): string {
  return `${(octets / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}
