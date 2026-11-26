import { useEffect, useState } from "react";

import { distance } from "@/lib/carte";
import { useLecturePeriodique } from "@/lib/lecture";
import { declarerPresence, lirePresence, quitterPresence } from "@/lib/nexus";
import type { Position } from "@/lib/position";
import { CLES, lireMagasin, surChangement } from "@/lib/reglages";
import { useSessionCourante } from "@/lib/session-courante";
import type { PresenceLieu } from "@/lib/types";

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
/** On renouvelle quand il reste moins que ceci avant l'échéance. */
const MARGE_RENOUVELLEMENT_MS = 8 * 60 * 1000;
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

/** Quitte le lieu déclaré. La copie s'efface même si le hub ne répond pas :
 *  l'échéance fera le reste là-bas. */
export async function quitterLieu(): Promise<void> {
  try {
    await quitterPresence();
  } finally {
    await ranger(null);
  }
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
  // Un autre personnage que celui déclaré : ce n'est plus lui qui y est.
  const autre =
    declare?.source === "overlay" && nom !== null && declare.personnage !== null && declare.personnage.name !== nom;

  useEffect(() => {
    if (!declare || declare.source !== "overlay") return;
    if (loin || autre) {
      void quitterLieu().catch((erreur) => console.error("la présence ne se retire pas", erreur));
      return;
    }
    if (!pres) return;
    const reste = new Date(declare.until).getTime() - Date.now();
    const minuterie = setTimeout(
      () =>
        void seDeclarer(declare.lieu.slug, nom).catch((erreur) =>
          console.error("la présence ne se renouvelle pas", erreur),
        ),
      Math.max(reste - MARGE_RENOUVELLEMENT_MS, 0),
    );
    return () => clearTimeout(minuterie);
  }, [declare, pres, loin, autre, nom]);
}
