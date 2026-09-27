import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { ecrireJeton, lireJeton, lireUrlHub } from "@/lib/reglages";
import type {
  Alentours,
  Evenement,
  Lieu,
  Recherche,
  ReleveMeteo,
  ScenesDuJour,
  Utilisateur,
} from "@/lib/types";

/**
 * Le client du hub.
 *
 * Les requêtes passent par `@tauri-apps/plugin-http`, qui les exécute côté
 * Rust. Deux conséquences : pas de CORS — le hub n'a rien à ouvrir pour
 * l'application —, et pas de cookie de vue web à espérer. La session est un
 * **jeton** : le hub le rend à la connexion dans l'en-tête `set-auth-token`
 * (greffon `bearer` de Better Auth), l'application le range, et le représente
 * en `Authorization: Bearer` à chaque appel.
 */

export class ErreurHub extends Error {
  readonly statut: number;

  constructor(statut: number, message: string) {
    super(message);
    this.name = "ErreurHub";
    this.statut = statut;
  }

  get nonAutorise() {
    return this.statut === 401;
  }
}

type Options = {
  methode?: "GET" | "POST";
  parametres?: Record<string, string | number | undefined>;
  corps?: unknown;
  /** Présente le jeton de session. Vrai par défaut. */
  authentifie?: boolean;
};

/** Le hub répond `{ erreur }` sur ses routes, `{ message }` sur celles de
 *  Better Auth. */
function messageDe(charge: unknown): string | null {
  if (!charge || typeof charge !== "object") return null;
  for (const cle of ["erreur", "message"]) {
    const valeur = (charge as Record<string, unknown>)[cle];
    if (typeof valeur === "string" && valeur.trim()) return valeur;
  }
  return null;
}

async function requete<T>(
  chemin: string,
  options: Options = {},
): Promise<{ donnees: T; entetes: Headers; statut: number }> {
  const { methode = "GET", parametres, corps, authentifie = true } = options;
  const base = await lireUrlHub();
  const url = new URL(chemin, `${base}/`);
  for (const [cle, valeur] of Object.entries(parametres ?? {})) {
    if (valeur !== undefined) url.searchParams.set(cle, String(valeur));
  }

  const entetes: Record<string, string> = { Accept: "application/json" };
  if (corps !== undefined) entetes["Content-Type"] = "application/json";
  if (authentifie) {
    const jeton = await lireJeton();
    if (jeton) entetes.Authorization = `Bearer ${jeton}`;
  }

  let reponse: Response;
  try {
    reponse = await tauriFetch(url.toString(), {
      method: methode,
      headers: entetes,
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
  } catch {
    throw new ErreurHub(0, `Le hub ne répond pas à l'adresse ${base}.`);
  }

  const texte = await reponse.text();
  let charge: unknown = undefined;
  if (texte) {
    try {
      charge = JSON.parse(texte);
    } catch {
      charge = texte;
    }
  }

  if (!reponse.ok) {
    throw new ErreurHub(
      reponse.status,
      messageDe(charge) ?? `${methode} ${chemin} a échoué (HTTP ${reponse.status}).`,
    );
  }

  return { donnees: charge as T, entetes: reponse.headers, statut: reponse.status };
}

/* --- La session -------------------------------------------------------------- */

type ReponseSession = { user: Utilisateur } | null;

/** Ouvre une session par courriel et mot de passe, et range le jeton rendu. */
export async function connecter(email: string, motDePasse: string): Promise<Utilisateur> {
  let resultat: Awaited<ReturnType<typeof requete<{ user: Utilisateur }>>>;
  try {
    resultat = await requete<{ user: Utilisateur }>("/api/auth/sign-in/email", {
      methode: "POST",
      corps: { email, password: motDePasse, rememberMe: true },
      authentifie: false,
    });
  } catch (erreur) {
    // Better Auth répond en anglais : la phrase du hub est celle qu'on montre.
    if (erreur instanceof ErreurHub && (erreur.statut === 401 || erreur.statut === 403)) {
      throw new ErreurHub(erreur.statut, "L'adresse ou le mot de passe ne correspond pas.");
    }
    throw erreur;
  }

  const jeton = resultat.entetes.get("set-auth-token");
  if (!jeton) {
    throw new ErreurHub(
      resultat.statut,
      "Le hub n'a pas rendu de jeton de session : son greffon « bearer » manque.",
    );
  }
  await ecrireJeton(jeton);
  return resultat.donnees.user;
}

/** Le compte connecté, ou `null` : sans session, Better Auth répond `null`. */
export async function lireSession(): Promise<Utilisateur | null> {
  if (!(await lireJeton())) return null;
  try {
    const { donnees } = await requete<ReponseSession>("/api/auth/get-session");
    return donnees?.user ?? null;
  } catch (erreur) {
    if (erreur instanceof ErreurHub && erreur.nonAutorise) {
      await ecrireJeton(null);
      return null;
    }
    throw erreur;
  }
}

/** Ferme la session côté hub, et oublie le jeton quoi qu'il arrive : un hub
 *  injoignable ne doit pas garder l'application connectée. */
export async function deconnecter(): Promise<void> {
  try {
    await requete("/api/auth/sign-out", { methode: "POST", corps: {} });
  } finally {
    await ecrireJeton(null);
  }
}

/* --- Les lectures ------------------------------------------------------------- */

/** Le temps au point donné, ou `null` si la simulation n'a encore rien écrit. */
export async function releverMeteo(x: number, y: number): Promise<ReleveMeteo | null> {
  try {
    const { donnees } = await requete<ReleveMeteo | undefined>("/api/meteo/point", {
      parametres: { x: Math.round(x), y: Math.round(y) },
      authentifie: false,
    });
    // Un corps vide n'est pas un relevé : mieux vaut le dire que planter dessus.
    return donnees ?? null;
  } catch (erreur) {
    if (erreur instanceof ErreurHub && erreur.statut === 404) return null;
    throw erreur;
  }
}

/** Tout ce qu'il y a autour d'un point, en une lecture : les lieux et les
 *  scènes à moins de `rayon`, la région et ses `rumeurs` dernières rumeurs.
 *  `region` vaut `null` hors de toute région, et les rumeurs sont alors vides. */
export async function alentours(
  x: number,
  y: number,
  rayon?: number,
  limite?: number,
  rumeurs?: number,
): Promise<Alentours> {
  const { donnees, statut } = await requete<Alentours | undefined>("/api/alentours", {
    parametres: { x: Math.round(x), y: Math.round(y), rayon, limite, rumeurs },
    authentifie: false,
  });
  // Un corps vide n'est pas une réponse : mieux vaut le dire que planter dessus.
  if (!donnees) throw new ErreurHub(statut, "Le hub n'a rien rendu pour les alentours.");
  return donnees;
}

/** Les scènes publiques du jour, où que soit le personnage : celles en cours,
 *  puis celles qui commencent avant minuit à l'heure du serveur de jeu, dans
 *  l'ordre de l'agenda. `total` compte tout le jour, `evenements` s'arrête à
 *  `limite`. */
export async function scenesDuJour(limite?: number): Promise<ScenesDuJour> {
  const { donnees, statut } = await requete<ScenesDuJour | undefined>(
    "/api/evenements/aujourdhui",
    { parametres: { limite }, authentifie: false },
  );
  // Un corps vide n'est pas une réponse : mieux vaut le dire que planter dessus.
  if (!donnees) throw new ErreurHub(statut, "Le hub n'a rien rendu pour les scènes du jour.");
  return donnees;
}

/** La fiche d'un lieu, ou `null` s'il n'existe pas ou plus. */
export async function lireLieu(slug: string): Promise<Lieu | null> {
  try {
    const { donnees } = await requete<Lieu>(`/api/lieux/${encodeURIComponent(slug)}`, {
      authentifie: false,
    });
    return donnees ?? null;
  } catch (erreur) {
    if (erreur instanceof ErreurHub && erreur.statut === 404) return null;
    throw erreur;
  }
}

/** Les scènes publiques non finies d'un lieu. */
export async function evenementsDuLieu(slug: string, limite?: number): Promise<Evenement[]> {
  const { donnees } = await requete<{ evenements: Evenement[] }>(
    `/api/lieux/${encodeURIComponent(slug)}/evenements`,
    { parametres: { limite }, authentifie: false },
  );
  return donnees?.evenements ?? [];
}

/** Une recherche à travers lieux, personnages, groupes et scènes. */
export async function rechercher(q: string, limite?: number): Promise<Recherche> {
  const { donnees, statut } = await requete<Recherche | undefined>("/api/recherche", {
    parametres: { q, limite },
    authentifie: false,
  });
  if (!donnees) throw new ErreurHub(statut, "Le hub n'a rien rendu pour la recherche.");
  return donnees;
}
