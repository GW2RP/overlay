import { openUrl } from "@tauri-apps/plugin-opener";

import { lireUrlHub } from "@/lib/reglages";

/** Ouvre une adresse dans le navigateur de la personne. Seuls `http` et
 *  `https` partent : le reste n'a rien à faire dehors. */
export async function ouvrirDehors(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    await openUrl(url);
  } catch (erreur) {
    console.error("le lien ne s'ouvre pas", erreur);
  }
}

/** Ouvre un chemin du hub — `/lieux/<slug>`, `/evenements/<slug>`… — dans le
 *  navigateur : ce que l'overlay ne montre pas se lit là-bas. */
export async function ouvrirSurLeHub(chemin: string): Promise<void> {
  await ouvrirDehors(`${await lireUrlHub()}${chemin}`);
}
