import type { Position } from "@/lib/position";

/** Ce qu'un élément dit quand il n'a pas de position à montrer. Un titre, et
 *  rien d'autre : l'écran ne s'explique pas, il se montre. */
export function EtatSansPosition({ position }: { position: Exclude<Position, { etat: "pret" }> }) {
  const titre = {
    "sans-jeu": "Jeu non détecté",
    "sans-carte": "Aucune carte chargée",
    "carte-inconnue": "Carte en cours de lecture",
    "hors-tyrie": "Hors de Tyrie",
  }[position.etat];

  return (
    <div className="flex h-full items-center px-4 py-3">
      <p className="meta text-ink-muted">{titre}</p>
    </div>
  );
}

/** Ce qu'un élément dit tant que sa lecture n'est pas arrivée : pas de tiret
 *  qui ferait croire à une mesure. */
export function EnCours({ libelle }: { libelle: string }) {
  return <p className="meta text-ink-muted">{libelle}</p>;
}

export function EnPanne({ libelle }: { libelle: string }) {
  return <p className="meta text-crimson-ink">{libelle}</p>;
}
