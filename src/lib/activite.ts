/**
 * Le statut d'activité d'un lieu, recopié du hub (`src/lib/place-activity.ts`
 * côté hub) : actif ou inactif, et un court message de son équipe.
 *
 * Un lieu actif redevient inactif à son échéance (`until`), message gardé.
 * Le hub l'a déjà jugé en répondant, mais ses alentours sont resservis par son
 * CDN : l'overlay rejuge l'échéance à chaque rendu, avec la même règle.
 */

/** Le message tient sous le nom du lieu, dans une liste. */
export const MESSAGE_ACTIVITE_MAX = 80;

export type Activite = {
  active: boolean;
  message: string | null;
  /** Depuis quand le lieu est actif — `null` s'il ne l'est pas. */
  since: string | null;
  /** Quand il redeviendra inactif de lui-même — `null` s'il ne l'est pas. */
  until: string | null;
};

/** Le statut tel qu'il est à `maintenant`. `null` pour un lieu qui n'a jamais
 *  rien déclaré — ou un hub d'avant les statuts, qui n'en écrit pas. */
export function activiteA(
  activite: Activite | null | undefined,
  maintenant: number = Date.now(),
): Activite | null {
  if (!activite) return null;
  if (!activite.active) return { ...activite, since: null, until: null };
  if (!activite.until || new Date(activite.until).getTime() <= maintenant) {
    return { active: false, message: activite.message, since: null, until: null };
  }
  return activite;
}
