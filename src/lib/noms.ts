/** Deux noms de personnage se valent sans la casse ni les espaces : c'est la
 *  règle du hub pour relier un nom en jeu à sa fiche. */
export function memeNom(a: string, b: string): boolean {
  const propre = (texte: string) => texte.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
  return propre(a) === propre(b);
}
