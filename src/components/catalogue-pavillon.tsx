import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import {
  lireCatalogue,
  lireCategories,
  type Categorie,
  type FicheDecoration,
} from "@/lib/pavillon";

/**
 * Le catalogue des décorations de l'API, pour en ajouter une. Une
 * décoration choisie se pose au point que la vue regarde, choisie à son tour
 * pour qu'on la place aux poignées ; le catalogue reste ouvert pour la
 * suivante.
 *
 * L'API ne dit pas si on la possède : le jeu, lui, ne pose au chargement que
 * celles du compte. Le catalogue les montre toutes.
 */

type Etat =
  | { etat: "lecture" }
  | { etat: "erreur" }
  | { etat: "pret"; fiches: FicheDecoration[]; categories: Categorie[] };

/** Le catalogue lu, gardé pour la session — complet seulement : un lot de
 *  l'API en échec ne fige pas un catalogue troué, la prochaine ouverture
 *  le relit. */
let memoire: { fiches: FicheDecoration[]; categories: Categorie[] } | null = null;

/** Le plafond de tuiles à l'écran : au-delà, on affine la recherche. */
const TUILES_MAX = 240;

function normaliser(texte: string): string {
  return texte.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("fr-FR");
}

export function CataloguePavillon({
  onChoisir,
  onFermer,
}: {
  onChoisir: (fiche: FicheDecoration) => void;
  onFermer: () => void;
}) {
  const [lu, setLu] = useState<Etat>(memoire ? { etat: "pret", ...memoire } : { etat: "lecture" });
  const [recherche, setRecherche] = useState("");
  const [categorie, setCategorie] = useState<number | null>(null);

  useEffect(() => {
    if (memoire) return;
    let parti = false;
    Promise.all([lireCatalogue(), lireCategories()])
      .then(([{ fiches, complet }, categories]) => {
        fiches.sort((a, b) => a.name.localeCompare(b.name, "fr-FR"));
        if (complet) memoire = { fiches, categories };
        if (!parti) setLu({ etat: "pret", fiches, categories });
      })
      .catch((cause) => {
        console.error("le catalogue des décorations ne se lit pas", cause);
        if (!parti) setLu({ etat: "erreur" });
      });
    return () => {
      parti = true;
    };
  }, []);

  const trouvees = useMemo(() => {
    if (lu.etat !== "pret") return [];
    const cherche = normaliser(recherche.trim());
    return lu.fiches.filter(
      (fiche) =>
        (categorie === null || fiche.categories.includes(categorie)) &&
        (!cherche || normaliser(fiche.name).includes(cherche)),
    );
  }, [lu, recherche, categorie]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <h2 className="panel-title text-ink">AJOUTER UNE DÉCORATION</h2>
        <Button type="button" variant="quiet" size="icon" aria-label="Fermer le catalogue" onClick={onFermer}>
          ×
        </Button>
      </div>

      {lu.etat === "pret" ? (
        <>
          <div className="flex flex-col gap-3 border-b border-hairline px-5 py-4">
            <Input
              type="search"
              aria-label="Rechercher une décoration"
              placeholder={`Parmi ${lu.fiches.length} décorations`}
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
            />
            <div className="flex gap-2 overflow-x-auto pb-1">
              <Puce active={categorie === null} onClick={() => setCategorie(null)}>
                TOUTES
              </Puce>
              {lu.categories.map((c) => (
                <Puce key={c.id} active={categorie === c.id} onClick={() => setCategorie(c.id)}>
                  {c.name.toLocaleUpperCase("fr-FR")}
                </Puce>
              ))}
            </div>
          </div>
          <p role="status" className="px-5 pt-3 caption text-ink-muted">
            {trouvees.length > TUILES_MAX
              ? `${trouvees.length} décorations, ${TUILES_MAX} affichées`
              : `${trouvees.length} décorations`}
          </p>
          <ul className="grid min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto px-5 pt-3 pb-5">
            {trouvees.slice(0, TUILES_MAX).map((fiche) => (
              <li key={fiche.id}>
                <button
                  type="button"
                  onClick={() => onChoisir(fiche)}
                  className="flex size-full flex-col gap-2 border border-hairline bg-surface p-2 text-left hover:bg-surface-selected"
                >
                  {fiche.icon ? (
                    <img src={fiche.icon} alt="" loading="lazy" width={64} height={64} className="aspect-square w-full" />
                  ) : (
                    <span aria-hidden="true" className="aspect-square w-full border border-rule bg-surface-inset" />
                  )}
                  <span className="caption text-ink">{fiche.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="panel-title text-ink-muted">
            {lu.etat === "lecture" ? "LECTURE DU CATALOGUE…" : "CATALOGUE INDISPONIBLE"}
          </p>
        </div>
      )}
    </div>
  );
}

function Puce({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-tap shrink-0 border px-3 chip-label ${
        active ? "border-gold bg-surface-selected text-gold-ink" : "border-chip-edge bg-chip text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}
