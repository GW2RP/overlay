import { invoke } from "@tauri-apps/api/core";

/**
 * Les dispositions rangées sur la machine, lues et écrites par Rust
 * (`src-tauri/src/dispositions.rs`) : des `.xml`, dans le dossier choisi, et
 * nulle part ailleurs — sauf l'export, dont le chemin sort de la boîte
 * d'enregistrement du système.
 */

export type FichierDisposition = {
  nom: string;
  carte: string | null;
  decorations: number | null;
  modifie: number | null;
};

/** Le dossier des dispositions, tenu par Rust : celui choisi la dernière
 *  fois, à défaut `Documents\Guild Wars 2\Homesteads` s'il existe sur cette
 *  machine. Le front ne fait que l'afficher : aucun chemin n'en repart. */
export function dossierDispositions(): Promise<string | null> {
  return invoke<string | null>("dossier_dispositions");
}

/** La boîte de choix de dossier du système ; le dossier choisi devient
 *  celui des dispositions. `null` si on la referme. */
export function choisirDossier(): Promise<string | null> {
  return invoke<string | null>("choisir_dossier");
}

export function listerDispositions(): Promise<FichierDisposition[]> {
  return invoke<FichierDisposition[]>("lister_dispositions");
}

export function lireFichierDisposition(nom: string): Promise<string> {
  return invoke<string>("lire_disposition", { nom });
}

/** Sans `remplacer`, un fichier du même nom fait refuser l'écriture.
 *  `attendu` est le dossier que l'écran montre : s'il a changé entre-temps,
 *  Rust refuse plutôt que d'écrire ailleurs. */
export function ecrireFichierDisposition(
  attendu: string,
  nom: string,
  contenu: string,
  remplacer: boolean,
): Promise<void> {
  return invoke<void>("ecrire_disposition", { attendu, nom, contenu, remplacer });
}

/** Le chemin écrit, ou `null` si la boîte s'est refermée sans choix. */
export function exporterDisposition(nom: string, contenu: string): Promise<string | null> {
  return invoke<string | null>("exporter_disposition", { nom, contenu });
}

/** Le nom sous lequel une disposition s'écrit : celui qu'on tape, sans
 *  l'extension, à laquelle on la rajoute. */
export function nomDeFichier(saisi: string): string {
  const base = saisi.trim().replace(/\.xml$/i, "").trim();
  return `${base}.xml`;
}

/** Le nom d'un fichier sans son extension, pour le titre et la liste. */
export function sansExtension(nom: string): string {
  return nom.replace(/\.xml$/i, "");
}
