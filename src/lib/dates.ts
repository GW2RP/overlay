/** Les heures sont celles du serveur de jeu, et se disent comme telles : une
 *  scène « à 21 h » se tient à 21 h à Paris, où que le joueur soit. */
export const FUSEAU_DU_JEU = "Europe/Paris";

const JOUR = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: FUSEAU_DU_JEU,
});

const HEURE = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: FUSEAU_DU_JEU,
});

const QUANTIEME = new Intl.DateTimeFormat("fr-FR", { day: "numeric", timeZone: FUSEAU_DU_JEU });
const MOIS = new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: FUSEAU_DU_JEU });

/** « sam. 26 sept. » */
export function formatJour(iso: string): string {
  return JOUR.format(new Date(iso));
}

/** « 21:00 » */
export function formatHeure(iso: string): string {
  return HEURE.format(new Date(iso));
}

/** Le quantième et le mois séparés, pour la case de date d'une ligne d'agenda. */
export function caseDeDate(iso: string): { quantieme: string; mois: string } {
  const date = new Date(iso);
  return {
    quantieme: QUANTIEME.format(date),
    mois: MOIS.format(date).replace(".", "").toLocaleUpperCase("fr-FR"),
  };
}
