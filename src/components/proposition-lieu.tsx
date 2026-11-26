import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ErreurHub } from "@/lib/nexus";
import { quitterLieu, RAYON_PROPOSITION, seDeclarer, useLieuDeclare } from "@/lib/presence-lieu";
import { useSessionCourante } from "@/lib/session-courante";

/**
 * « Êtes-vous à la Taverne du Lion ? » — posé en tête de « À proximité »
 * quand un lieu du registre est à moins de `RAYON_PROPOSITION`. Oui, on s'y
 * déclare sous le personnage joué ; non, la question ne revient plus pour ce
 * lieu tant que la fenêtre vit. Une fois déclaré, la même place dit où l'on
 * est, et s'y quitte.
 *
 * Connecté seulement — la déclaration est celle d'un compte —, et cadenas
 * ouvert : fermé, les clics passent au jeu.
 */
export function PropositionLieu({
  plusProche,
  personnage,
}: {
  /** Le lieu le plus proche, et sa distance en pixels de continent. */
  plusProche: { id: string; slug: string; name: string; distance: number } | null;
  /** Le nom du personnage joué, tel que le lien le donne. */
  personnage: string | null;
}) {
  const session = useSessionCourante();
  const declare = useLieuDeclare();
  const [refuses, setRefuses] = useState<ReadonlySet<string>>(new Set());
  const [envoi, setEnvoi] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);

  if (session === null) return null;

  async function agir(action: () => Promise<unknown>, repli: string) {
    setEnvoi(true);
    setEchec(null);
    try {
      await action();
    } catch (erreur) {
      setEchec(erreur instanceof ErreurHub ? erreur.message : repli);
    } finally {
      setEnvoi(false);
    }
  }

  let contenu: ReactNode = null;
  if (declare) {
    contenu = (
      <>
        <p className="min-w-0 flex-1 body-compact text-ink">
          À {declare.lieu.name}
          {declare.personnage ? (
            <span className="block caption text-ink-muted">{declare.personnage.name}</span>
          ) : null}
        </p>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={envoi}
          onClick={() => void agir(quitterLieu, "Le départ n'a pas été pris en compte.")}
        >
          QUITTER
        </Button>
      </>
    );
  } else if (plusProche && plusProche.distance <= RAYON_PROPOSITION && !refuses.has(plusProche.id)) {
    const lieu = plusProche;
    contenu = (
      <>
        <p className="min-w-0 flex-1 body-compact text-ink">Êtes-vous à {lieu.name} ?</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={envoi}
          onClick={() =>
            void agir(() => seDeclarer(lieu.slug, personnage), "La présence n'a pas été enregistrée.")
          }
        >
          OUI
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={envoi}
          onClick={() => setRefuses((avant) => new Set(avant).add(lieu.id))}
        >
          NON
        </Button>
      </>
    );
  }

  if (!contenu) return null;
  return (
    <div className="flex flex-col gap-2 border border-gold bg-surface-inset px-3 py-2">
      <div className="flex items-center gap-2">{contenu}</div>
      {echec ? (
        <p role="alert" className="caption text-crimson-ink">
          {echec}
        </p>
      ) : null}
    </div>
  );
}
