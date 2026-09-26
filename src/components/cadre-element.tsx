import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { CloseIcon } from "@/components/icons";
import { cacherOverlay, RACCOURCI_EDITION, type Element } from "@/lib/overlays";
import { useCadrePersistant } from "@/lib/cadre";
import { useOpacite } from "@/lib/reglages";
import { cn } from "@/lib/utils";

/**
 * Le cadre d'un élément d'overlay : sa surface, et ce qui n'apparaît qu'en
 * édition — la barre qui le déplace, la croix qui le ferme, le bord qui dit
 * qu'il se saisit.
 *
 * Hors édition, la fenêtre laisse passer le curseur (Rust s'en charge), donc
 * rien ici n'a besoin d'être cliquable : l'élément est une image posée sur le
 * jeu. En édition, on le glisse par sa barre, on le redimensionne par le bord
 * de la fenêtre, et on le déplace aux flèches une fois au clavier — d'un pas
 * de grille, d'un pixel avec `Maj`. Chaque déplacement s'écrit dans les
 * réglages, et la fenêtre reprend sa place au démarrage suivant.
 */

/** Le pas des flèches, en pixels d'écran. */
const PAS = 10;

export function CadreElement({
  element,
  edition,
  children,
}: {
  element: Element;
  edition: boolean;
  children: ReactNode;
}) {
  // En édition, le panneau redevient plein : on le saisit par son cadre, et un
  // cadre à demi effacé se cherche.
  const opacite = useOpacite();
  useCadrePersistant(element.label);

  async function deplacer(dx: number, dy: number) {
    const fenetre = getCurrentWindow();
    const position = await fenetre.outerPosition();
    await fenetre.setPosition(new PhysicalPosition(position.x + dx, position.y + dy));
  }

  function surTouche(evenement: KeyboardEvent<HTMLDivElement>) {
    if (!edition) return;
    const pas = evenement.shiftKey ? 1 : PAS;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-pas, 0],
      ArrowRight: [pas, 0],
      ArrowUp: [0, -pas],
      ArrowDown: [0, pas],
    };
    const delta = deltas[evenement.key];
    if (!delta) return;
    evenement.preventDefault();
    void deplacer(...delta).catch((erreur) => console.error("la fenêtre ne se déplace pas", erreur));
  }

  return (
    <div
      className={cn(
        "panneau-overlay flex h-dvh w-dvw flex-col overflow-hidden border-2 text-ink",
        edition && "border-gold",
      )}
      style={{ "--opacite-panneau": edition ? 100 : opacite } as CSSProperties}
      tabIndex={edition ? 0 : -1}
      onKeyDown={surTouche}
      aria-label={element.titre}
    >
      {edition ? (
        <div
          data-tauri-drag-region
          className="flex min-h-tap shrink-0 cursor-move items-center gap-2 border-b border-gold bg-surface-selected pl-3"
          title={`Glisser pour déplacer · flèches pour ajuster · ${RACCOURCI_EDITION} pour quitter l'édition`}
        >
          <span data-tauri-drag-region className="eyebrow flex-1 text-gold-eyebrow">
            {element.titre.toLocaleUpperCase("fr-FR")}
          </span>
          <button
            type="button"
            onClick={() =>
              void cacherOverlay(element.label).catch((erreur) =>
                console.error("l'overlay ne se cache pas", erreur),
              )
            }
            className="flex size-tap items-center justify-center text-ink-muted hover:bg-surface-inset hover:text-ink"
            aria-label={`Fermer ${element.titre}`}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
