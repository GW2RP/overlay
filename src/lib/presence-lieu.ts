import { useEffect, useState } from "react";

import { distance } from "@/lib/carte";
import { useLecturePeriodique } from "@/lib/lecture";
import { declarerPresence, ErreurHub, lirePresence, quitterPresence } from "@/lib/nexus";
import type { Position } from "@/lib/position";
import { CLES, lireMagasin, surChangement } from "@/lib/reglages";
import { useSessionCourante } from "@/lib/session-courante";
import type { PresenceLieu } from "@/lib/types";
import { memeNom } from "@/lib/noms";

/**
 * « Je suis à ce lieu » : la présence déclarée à un lieu du hub, d'où le hub
 * tire la fréquentation en direct.
 *
 * La déclaration vit **au hub**, et sa copie dans le magasin (`lieuDeclare`) :
 * c'est par là que la fenêtre principale, qui l'entretient, « À proximité »,
 * qui la propose, et la présence Discord, qui l'affiche, la partagent.
 *
 * Une déclaration de l'overlay vit un quart d'heure au hub, et la fenêtre
 * principale la **renouvelle** tant que le personnage reste près du lieu ; il
 * s'en éloigne, elle la **retire**. Le jeu fermé, plus rien ne la renouvelle,
 * et elle tombe d'elle-même. Une déclaration faite sur le site vit deux heures
 * et ne suit pas la position : le lieu peut se tenir dans une instance que la
 * carte du continent ne situe pas.
 */

/** Assez près pour qu'on demande « êtes-vous à ce lieu ? », en pixels de
 *  continent — environ 1 400 unités du jeu, une grande place de ville. */
export const RAYON_PROPOSITION = 60;
/** Au-delà, une déclaration de l'overlay se retire : on a quitté le lieu. Plus
 *  large que la proposition, pour qu'un pas de côté ne la fasse pas tomber. */
export const RAYON_MAINTIEN = 150;
/** On renouvelle à ce rythme une déclaration d'un quart d'heure. Compté sur
 *  l'horloge de la machine depuis qu'on l'a reçue, jamais sur l'échéance du
 *  hub : une horloge en avance renouvellerait en rafale. */
const RENOUVELLEMENT_MS = 7 * 60 * 1000;
/** La relecture de la déclaration au hub : une déclaration faite ou retirée
 *  sur le site se voit ici. */
const RELECTURE_MS = 5 * 60 * 1000;

function valide(presence: PresenceLieu | null | undefined, maintenant = Date.now()) {
  return presence && new Date(presence.until).getTime() > maintenant ? presence : null;
}

async function ranger(presence: PresenceLieu | null): Promise<void> {
  const magasin = await lireMagasin();
  if (presence) await magasin.set(CLES.lieuDeclare, presence);
  else await magasin.delete(CLES.lieuDeclare);
}

/** Se déclare au lieu, sous le personnage joué. */
export async function seDeclarer(slug: string, personnage: string | null): Promise<PresenceLieu> {
  const presence = await declarerPresence(slug, personnage);
  await ranger(presence);
  return presence;
}

/** Quitte le lieu déclaré, quel qu'il soit : c'est le bouton. La copie
 *  s'efface même si le hub ne répond pas : l'échéance fera le reste là-bas. */
export async function quitterLieu(): Promise<void> {
  try {
    await quitterPresence();
  } finally {
    await ranger(null);
  }
}

/** Ce que l'overlay fait seul, sans qu'on le lui demande : renouveler ou
 *  retirer **sa** déclaration à **ce** lieu. Le hub refuse un renouvellement
 *  et ignore un départ visant une présence qui a changé entre-temps — quittée
 *  ou déplacée depuis le site — et l'on reprend alors ce qu'il dit. */
async function renouveler(slug: string, personnage: string | null): Promise<void> {
  try {
    await ranger(await declarerPresence(slug, personnage, true));
  } catch (erreur) {
    if (erreur instanceof ErreurHub && erreur.statut === 409) await ranger(valide(await lirePresence()));
    else throw erreur;
  }
}

async function retirer(slug: string): Promise<void> {
  await quitterPresence(slug);
  await ranger(valide(await lirePresence()));
}

/** La présence déclarée, suivie d'où qu'elle soit écrite, et jugée à son
 *  échéance à chaque minute. */
export function useLieuDeclare(): PresenceLieu | null {
  const [presence, setPresence] = useState<PresenceLieu | null>(null);
  const [maintenant, setMaintenant] = useState(() => Date.now());

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;
    void lireMagasin()
      .then((magasin) => magasin.get<PresenceLieu>(CLES.lieuDeclare))
      .then((valeur) => {
        if (!parti) setPresence(valeur ?? null);
      });
    void surChangement<PresenceLieu>(CLES.lieuDeclare, (valeur) => setPresence(valeur ?? null)).then(
      (stop) => {
        if (parti) stop();
        else arreter = stop;
      },
    );
    const minuterie = setInterval(() => setMaintenant(Date.now()), 60_000);
    return () => {
      parti = true;
      arreter?.();
      clearInterval(minuterie);
    };
  }, []);

  return valide(presence, maintenant);
}

const relirePresence = () => lirePresence();

/**
 * L'entretien de la déclaration, depuis la fenêtre principale — la seule qui
 * vive tant que l'application tourne : relue au hub à chaque changement de
 * session et toutes les cinq minutes, renouvelée près du lieu, retirée loin
 * de lui.
 */
export function useEntretienPresence(position: Position): void {
  const session = useSessionCourante();
  const lecture = useLecturePeriodique(session, true, RELECTURE_MS, relirePresence);
  const declare = useLieuDeclare();

  // Ce que le hub dit fait foi : il range la déclaration faite sur le site,
  // et oublie celle qu'il a laissé échoir. Déconnecté, il n'y en a plus.
  useEffect(() => {
    if (session === null) {
      void ranger(null);
      return;
    }
    if (lecture.etat === "lu") void ranger(valide(lecture.valeur));
  }, [session, lecture]);

  const nom = position.etat === "sans-jeu" ? null : (position.lien.identite?.name ?? null);
  const point = position.etat === "pret" ? position.point : null;
  const ecart =
    declare?.source === "overlay" && declare.lieu.coordinates && point
      ? distance(point, declare.lieu.coordinates)
      : null;
  const pres = ecart !== null && ecart <= RAYON_MAINTIEN;
  const loin = ecart !== null && ecart > RAYON_MAINTIEN;
  // Un autre personnage que celui déclaré : ce n'est plus lui qui y est. Le
  // hub rend le nom de la fiche, qui peut différer du nom en jeu par la casse
  // ou les espaces.
  const autre =
    declare?.source === "overlay" &&
    nom !== null &&
    declare.personnage !== null &&
    !memeNom(declare.personnage.name, nom);

  const slug = declare?.source === "overlay" ? declare.lieu.slug : null;
  // L'échéance identifie la déclaration : la relecture périodique rend la
  // même, et ne doit pas repousser le renouvellement.
  const echeance = declare?.source === "overlay" ? declare.until : null;

  useEffect(() => {
    if (!slug || !(loin || autre)) return;
    void retirer(slug).catch((erreur) => console.error("la présence ne se retire pas", erreur));
  }, [slug, loin, autre]);

  useEffect(() => {
    if (!slug || !echeance || !pres) return;
    const minuterie = setTimeout(
      () =>
        void renouveler(slug, nom).catch((erreur) =>
          console.error("la présence ne se renouvelle pas", erreur),
        ),
      RENOUVELLEMENT_MS,
    );
    return () => clearTimeout(minuterie);
  }, [slug, echeance, pres, nom]);
}
