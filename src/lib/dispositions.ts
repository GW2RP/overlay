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

/** `Documents\Guild Wars 2\Homesteads`, là où le jeu les range quand on ne lui
 *  dit rien, s'il existe sur cette machine. */
export function dossierParDefaut(): Promise<string | null> {
  return invoke<string | null>("dossier_par_defaut");
}

/** La boîte de choix de dossier du système ; `null` si on la referme. */
export function choisirDossier(depart: string | null): Promise<string | null> {
  return invoke<string | null>("choisir_dossier", { depart });
}

export function listerDispositions(dossier: string): Promise<FichierDisposition[]> {
  return invoke<FichierDisposition[]>("lister_dispositions", { dossier });
}

export function lireFichierDisposition(dossier: string, nom: string): Promise<string> {
  return invoke<string>("lire_disposition", { dossier, nom });
}

/** Sans `remplacer`, un fichier du même nom fait refuser l'écriture. */
export function ecrireFichierDisposition(
  dossier: string,
  nom: string,
  contenu: string,
  remplacer: boolean,
): Promise<void> {
  return invoke<void>("ecrire_disposition", { dossier, nom, contenu, remplacer });
}

/** Le chemin écrit, ou `null` si la boîte s'est refermée sans choix. */
export function exporterDisposition(
  nom: string,
  depart: string | null,
  contenu: string,
): Promise<string | null> {
  return invoke<string | null>("exporter_disposition", { nom, depart, contenu });
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
