import { load, type Store } from "@tauri-apps/plugin-store";
import { useEffect, useState } from "react";

/**
 * Les réglages persistants, rangés par le greffon `store` dans le dossier de
 * données de l'application : ils survivent aux redémarrages.
 *
 * Un seul magasin pour toute l'application, et un seul handle par fenêtre :
 * deux handles sur le même fichier gardent chacun leur copie en mémoire, et la
 * dernière écriture l'emporterait sur un changement jamais relu. Le greffon
 * propage les changements d'une fenêtre à l'autre, donc `surChangement` suffit
 * pour qu'un overlay suive ce que la fenêtre principale a réglé.
 */

const FICHIER = "reglages.json";

const CLE_JETON = "jeton";
const CLE_URL_HUB = "urlHub";
const CLE_FENETRES = "fenetres";
const CLE_ELEMENTS_OUVERTS = "elementsOuverts";
const CLE_CARTES = "cartes";
const CLE_OPACITE = "opacite";

/** L'opacité du fond des éléments, en pourcent. Le plancher garde un fond qui
 *  se voit encore : à zéro, le texte flotterait sur le jeu sans rien derrière. */
export const OPACITE_PAR_DEFAUT = 100;
export const OPACITE_MINIMALE = 30;
export const OPACITE_MAXIMALE = 100;

/** Le hub en production. */
export const URL_HUB_PAR_DEFAUT = "https://www.gw2rp.eu";

/** Les adresses que la capacité `http` de `src-tauri/capabilities/default.json`
 *  laisse passer. Les deux listes doivent dire la même chose : une adresse
 *  acceptée ici et refusée là échouerait à la première requête, sans dire
 *  pourquoi. */
export const URLS_HUB_AUTORISEES = [
  URL_HUB_PAR_DEFAUT,
  "http://localhost:3000",
] as const;

/** Les aperçus de Vercel : n'importe quel sous-domaine, en HTTPS. */
const APERCU_VERCEL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

let magasin: Promise<Store> | null = null;

export function lireMagasin(): Promise<Store> {
  if (!magasin) {
    magasin = load(FICHIER, { autoSave: true });
  }
  return magasin;
}

export function normaliserUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function urlHubAutorisee(url: string): boolean {
  const propre = normaliserUrl(url);
  return (URLS_HUB_AUTORISEES as readonly string[]).includes(propre) || APERCU_VERCEL.test(propre);
}

/** L'adresse du hub, revalidée à chaque lecture : un fichier de réglages édité
 *  à la main ne doit pas pouvoir pointer l'application sur un autre serveur. */
export async function lireUrlHub(): Promise<string> {
  const valeur = await (await lireMagasin()).get<string>(CLE_URL_HUB);
  if (!valeur || !urlHubAutorisee(valeur)) return URL_HUB_PAR_DEFAUT;
  return normaliserUrl(valeur);
}

export async function ecrireUrlHub(url: string): Promise<void> {
  await (await lireMagasin()).set(CLE_URL_HUB, normaliserUrl(url));
}

/** Le jeton de session que le hub a rendu à la connexion (`set-auth-token`). */
export async function lireJeton(): Promise<string | null> {
  return (await (await lireMagasin()).get<string>(CLE_JETON)) ?? null;
}

export async function ecrireJeton(jeton: string | null): Promise<void> {
  const store = await lireMagasin();
  if (jeton) await store.set(CLE_JETON, jeton);
  else await store.delete(CLE_JETON);
}

/** Où une fenêtre d'overlay a été posée, en pixels physiques d'écran. */
export type CadreFenetre = { x: number; y: number; largeur: number; hauteur: number };

export async function lireCadres(): Promise<Record<string, CadreFenetre>> {
  return (await (await lireMagasin()).get<Record<string, CadreFenetre>>(CLE_FENETRES)) ?? {};
}

export async function ecrireCadre(label: string, cadre: CadreFenetre): Promise<void> {
  const store = await lireMagasin();
  const cadres = (await store.get<Record<string, CadreFenetre>>(CLE_FENETRES)) ?? {};
  await store.set(CLE_FENETRES, { ...cadres, [label]: cadre });
}

/** Les overlays à rouvrir au prochain démarrage : ceux qu'on a laissés ouverts. */
export async function lireElementsOuverts(): Promise<string[]> {
  return (await (await lireMagasin()).get<string[]>(CLE_ELEMENTS_OUVERTS)) ?? [];
}

export async function ecrireElementsOuverts(labels: string[]): Promise<void> {
  await (await lireMagasin()).set(CLE_ELEMENTS_OUVERTS, labels);
}

/** Les cartes du jeu déjà décrites par son API, par identifiant : une carte ne
 *  change pas de rectangle, et l'API n'a pas à être rappelée à chaque
 *  lancement pour la même Kryte. */
export async function lireCartes<T>(): Promise<Record<string, T>> {
  return (await (await lireMagasin()).get<Record<string, T>>(CLE_CARTES)) ?? {};
}

export async function ecrireCarte<T>(id: number, carte: T): Promise<void> {
  const store = await lireMagasin();
  const cartes = (await store.get<Record<string, T>>(CLE_CARTES)) ?? {};
  await store.set(CLE_CARTES, { ...cartes, [String(id)]: carte });
}

function bornerOpacite(valeur: unknown): number {
  const nombre = typeof valeur === "number" && Number.isFinite(valeur) ? valeur : OPACITE_PAR_DEFAUT;
  return Math.min(Math.max(Math.round(nombre), OPACITE_MINIMALE), OPACITE_MAXIMALE);
}

/** L'opacité du fond des éléments, bornée à la lecture : un fichier de
 *  réglages édité à la main ne rend pas les éléments invisibles. */
export async function lireOpacite(): Promise<number> {
  return bornerOpacite(await (await lireMagasin()).get<number>(CLE_OPACITE));
}

export async function ecrireOpacite(valeur: number): Promise<void> {
  await (await lireMagasin()).set(CLE_OPACITE, bornerOpacite(valeur));
}

/** L'opacité en vigueur, suivie d'où qu'elle soit réglée : la fenêtre
 *  principale la change, chaque élément la reflète aussitôt. */
export function useOpacite(): number {
  const [opacite, setOpacite] = useState(OPACITE_PAR_DEFAUT);

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;
    void lireOpacite().then((valeur) => {
      if (!parti) setOpacite(valeur);
    });
    void surChangement<number>(CLE_OPACITE, (valeur) => setOpacite(bornerOpacite(valeur))).then(
      (stop) => {
        if (parti) stop();
        else arreter = stop;
      },
    );
    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  return opacite;
}

/** Suit une clé, d'où qu'elle soit écrite. */
export async function surChangement<T>(
  cle: string,
  rappel: (valeur: T | undefined) => void,
): Promise<() => void> {
  return (await lireMagasin()).onKeyChange<T>(cle, rappel);
}

export const CLES = {
  jeton: CLE_JETON,
  urlHub: CLE_URL_HUB,
  fenetres: CLE_FENETRES,
  elementsOuverts: CLE_ELEMENTS_OUVERTS,
  opacite: CLE_OPACITE,
} as const;
