import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { PROFESSION_LABELS, RACE_MUMBLE_LABELS } from "@/lib/domaine";
import { useLecturePeriodique } from "@/lib/lecture";
import { personnagesDuCompte } from "@/lib/nexus";
import type { Position } from "@/lib/position";
import { memeNom } from "@/lib/noms";
import { useLieuDeclare } from "@/lib/presence-lieu";
import { CLES, lireMagasin, lireUrlHub, surChangement } from "@/lib/reglages";
import { useSessionCourante } from "@/lib/session-courante";
import type { PersonnageDuCompte, PresenceLieu } from "@/lib/types";

/**
 * La présence Discord : sous le nom du joueur, ses amis lisent le personnage
 * qu'il joue, ce qu'il fait en jeu de rôle, et où — s'il le partage.
 *
 * Le front la **compose** : il connaît le nom des cartes, la fiche du
 * personnage sur le hub, le lieu déclaré et les choix du joueur. Rust la
 * **pose** (`regler_presence`), par la seule connexion au client Discord de
 * l'application, au rythme que Discord accepte. La fenêtre principale tient
 * la composition, parce qu'elle vit tant que l'application tourne.
 *
 * Trois réglages, rangés dans le magasin :
 * - `actif` : la présence elle-même, allumée par défaut — c'est ce pour quoi
 *   l'application est connue de Discord ;
 * - `carte` : la carte et sa région, **éteint par défaut** — une position ne
 *   se partage que parce qu'on l'a choisi ;
 * - `description` : ce que le personnage fait, en une ligne libre.
 *
 * Un lieu déclaré au hub s'affiche **même carte cachée** : se déclarer à la
 * Taverne du Lion, c'est déjà le dire à tout le monde.
 */

/** La limite de Discord pour une ligne. */
export const DESCRIPTION_MAX = 128;

export type ReglagesDiscord = { actif: boolean; carte: boolean; description: string };

export const REGLAGES_DISCORD_PAR_DEFAUT: ReglagesDiscord = {
  actif: true,
  carte: false,
  description: "",
};

/** Relu champ par champ : un fichier de réglages édité à la main, ou écrit
 *  par une version d'avant, ne fait pas tomber la présence. */
function bornerReglages(valeur: unknown): ReglagesDiscord {
  const brut = (valeur && typeof valeur === "object" ? valeur : {}) as Record<string, unknown>;
  return {
    actif: typeof brut.actif === "boolean" ? brut.actif : REGLAGES_DISCORD_PAR_DEFAUT.actif,
    carte: typeof brut.carte === "boolean" ? brut.carte : REGLAGES_DISCORD_PAR_DEFAUT.carte,
    description:
      typeof brut.description === "string" ? brut.description.slice(0, DESCRIPTION_MAX) : "",
  };
}

export async function ecrireReglagesDiscord(reglages: ReglagesDiscord): Promise<void> {
  await (await lireMagasin()).set(CLES.discord, bornerReglages(reglages));
}

export function useReglagesDiscord(): ReglagesDiscord {
  const [reglages, setReglages] = useState(REGLAGES_DISCORD_PAR_DEFAUT);

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;
    void lireMagasin()
      .then((magasin) => magasin.get<unknown>(CLES.discord))
      .then((valeur) => {
        if (!parti) setReglages(bornerReglages(valeur));
      });
    void surChangement<unknown>(CLES.discord, (valeur) => setReglages(bornerReglages(valeur))).then(
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

  return reglages;
}

/** L'activité telle que Rust la lit (`Activite::depuis_json`). */
export type ActiviteDiscord = {
  details: string;
  etat?: string;
  texteImage?: string;
  debut?: number;
  boutons?: { libelle: string; url: string }[];
};


export function composerActivite({
  position,
  reglages,
  fiche,
  lieu,
  urlHub,
  debut,
}: {
  position: Position;
  reglages: ReglagesDiscord;
  /** La fiche du personnage joué sur le hub, s'il en a une. */
  fiche: PersonnageDuCompte | null;
  lieu: PresenceLieu | null;
  urlHub: string;
  debut: number | null;
}): ActiviteDiscord | null {
  if (!reglages.actif || position.etat === "sans-jeu" || position.etat === "sans-carte") return null;
  const identite = position.lien.identite;
  // Sans nom, la présence n'a rien à dire que Discord ne dise déjà.
  if (!identite?.name) return null;

  const traits = [RACE_MUMBLE_LABELS[identite.race], PROFESSION_LABELS[identite.profession]]
    .filter(Boolean)
    .join(" ");
  const details = traits ? `${identite.name}, ${traits}` : identite.name;

  const carte =
    reglages.carte && "carte" in position
      ? [position.carte.name, position.carte.region_name].filter(Boolean).join(", ")
      : null;
  const ou = lieu
    ? [`À ${lieu.lieu.name}`, reglages.carte && "carte" in position ? position.carte.name : null]
        .filter(Boolean)
        .join(", ")
    : carte;

  const description = reglages.description.trim();
  const boutons: { libelle: string; url: string }[] = [];
  // Discord n'ouvre que des liens web sûrs : le hub local de développement
  // n'en fait pas partie.
  if (urlHub.startsWith("https://")) {
    if (fiche) boutons.push({ libelle: "Fiche du personnage", url: `${urlHub}/personnages/${fiche.slug}` });
    if (lieu) boutons.push({ libelle: "Voir le lieu", url: `${urlHub}/lieux/${lieu.lieu.slug}` });
  }

  return {
    details,
    // La ligne RP d'abord : c'est elle que le joueur a écrite. Le lieu passe
    // alors au survol de l'image.
    etat: description || ou || undefined,
    texteImage: description && ou ? ou : "GW2 Roleplay",
    debut: debut ?? undefined,
    boutons,
  };
}

export type EtatPresence = { disponible: boolean; posee: boolean; erreur: string | null };

/** Ce que Rust dit de la présence, relu toutes les trois secondes tant que
 *  l'écran qui le montre est là. */
export function useEtatPresence(): EtatPresence | null {
  const [etat, setEtat] = useState<EtatPresence | null>(null);
  useEffect(() => {
    let parti = false;
    const lire = () =>
      void invoke<EtatPresence>("etat_presence")
        .then((valeur) => {
          if (!parti) setEtat(valeur);
        })
        .catch((erreur) => console.error("l'état de la présence ne se lit pas", erreur));
    lire();
    const minuterie = setInterval(lire, 3_000);
    return () => {
      parti = true;
      clearInterval(minuterie);
    };
  }, []);
  return etat;
}

const lirePersonnages = () => personnagesDuCompte();

/** L'horloge, hors du composant : le début d'une partie se lit une fois, au
 *  rendu où le personnage change. */
const maintenant = () => Date.now();

/** Compose la présence et la confie à Rust, à chaque changement de ce qu'elle
 *  dit. Depuis la fenêtre principale seulement. */
export function usePresenceDiscord(position: Position): void {
  const reglages = useReglagesDiscord();
  const lieu = useLieuDeclare();
  const session = useSessionCourante();
  const personnages = useLecturePeriodique(session, true, 10 * 60 * 1000, lirePersonnages);
  const [urlHub, setUrlHub] = useState<string | null>(null);

  useEffect(() => {
    let parti = false;
    const relire = () =>
      void lireUrlHub().then((url) => {
        if (!parti) setUrlHub(url);
      });
    relire();
    let arreter: (() => void) | null = null;
    void surChangement<string>(CLES.urlHub, relire).then((stop) => {
      if (parti) stop();
      else arreter = stop;
    });
    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  // « Depuis 12 min » compte depuis que ce personnage est en jeu, pas depuis
  // le dernier changement de carte : un écran de chargement, où le jeu
  // n'écrit plus le lien, ne le remet pas à zéro. Seul un autre personnage le
  // fait.
  const nom = position.etat === "sans-jeu" ? null : (position.lien.identite?.name ?? null);
  const [depuis, setDepuis] = useState<{ nom: string; debut: number } | null>(null);
  if (nom !== null && depuis?.nom !== nom) setDepuis({ nom, debut: maintenant() });
  const debut = nom !== null && depuis?.nom === nom ? depuis.debut : null;

  const fiche =
    session !== null && nom && personnages.etat === "lu"
      ? (personnages.valeur.find((personnage) => memeNom(personnage.name, nom)) ?? null)
      : null;
  const activite =
    urlHub === null
      ? null
      : composerActivite({
          position,
          reglages,
          fiche,
          lieu: session !== null ? lieu : null,
          urlHub,
          debut,
        });
  const cle = JSON.stringify(activite);

  // Une présence qui s'efface attend `GRACE_MS` : un changement de carte
  // passe par un écran de chargement où le jeu n'écrit plus le lien, et la
  // présence ne doit pas clignoter à chaque portail. Le jeu fermé, elle
  // tombe une minute après.
  useEffect(() => {
    const poser = () =>
      void invoke("regler_presence", { activite: JSON.parse(cle) as ActiviteDiscord | null }).catch(
        (erreur) => console.error("la présence ne se pose pas", erreur),
      );
    if (cle !== "null") {
      poser();
      return;
    }
    const minuterie = setTimeout(poser, GRACE_MS);
    return () => clearTimeout(minuterie);
  }, [cle]);
}

/** Le temps qu'une présence survit au lien qui se tait. */
const GRACE_MS = 60_000;
