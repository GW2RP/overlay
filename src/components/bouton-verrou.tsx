import { useEffect, useRef } from "react";

import { LockIcon, UnlockIcon } from "@/components/icons";
import { deverrouillerOverlay, verrouillerOverlay, type Zone } from "@/lib/overlays";
import { cn } from "@/lib/utils";

/**
 * Le cadenas d'un élément.
 *
 * Fermé, la fenêtre laisse passer chaque clic jusqu'au jeu — sauf sur ce
 * bouton, le seul chemin du retour. Rust en décide en comparant la position
 * du curseur au rectangle que ce bouton déclare de lui-même ; le bouton le
 * tient donc informé : à la fermeture, et chaque fois que la fenêtre change
 * de taille et que l'en-tête se réagence sous lui.
 */
export function BoutonVerrou({
  label,
  verrouille,
  className,
}: {
  label: string;
  verrouille: boolean;
  className?: string;
}) {
  const bouton = useRef<HTMLButtonElement>(null);

  // La zone suit le bouton. Un `ResizeObserver` sur le corps plutôt que sur le
  // bouton : sa taille ne change pas, sa *place* si, et c'est la fenêtre qui
  // la déplace.
  useEffect(() => {
    if (!verrouille) return;

    const declarer = () => {
      const zone = zoneDe(bouton.current);
      if (!zone) return;
      void verrouillerOverlay(label, zone).catch((erreur) =>
        console.error("le cadenas ne se déclare pas", erreur),
      );
    };

    declarer();
    const observateur = new ResizeObserver(declarer);
    observateur.observe(document.body);
    window.addEventListener("resize", declarer);
    return () => {
      observateur.disconnect();
      window.removeEventListener("resize", declarer);
    };
  }, [label, verrouille]);

  const action = verrouille
    ? "Ouvrir : la fenêtre reprend les clics"
    : "Fermer : les clics passent au jeu, sauf sur ce bouton";

  return (
    <button
      ref={bouton}
      type="button"
      onClick={() => {
        // La fermeture se déclare par l'effet ci-dessus, une fois l'état
        // revenu de Rust ; l'ouverture se demande directement, c'est le seul
        // clic qu'une fenêtre fermée reçoit encore.
        const changement = verrouille
          ? deverrouillerOverlay(label)
          : verrouillerOverlay(label, zoneDe(bouton.current) ?? { x: 0, y: 0, width: 0, height: 0 });
        void changement.catch((erreur) => console.error("le cadenas ne bascule pas", erreur));
      }}
      title={action}
      aria-label={action}
      aria-pressed={verrouille}
      className={cn(
        "flex size-tap shrink-0 items-center justify-center border",
        // Fermé, il porte l'or : c'est la seule chose vivante d'une fenêtre
        // qui ne prend plus rien.
        verrouille
          ? "border-gold bg-surface-selected text-gold-ink"
          : "border-rule text-ink-muted hover:bg-surface-inset hover:text-ink",
        className,
      )}
    >
      {verrouille ? <LockIcon size={16} /> : <UnlockIcon size={16} />}
    </button>
  );
}

function zoneDe(element: HTMLElement | null): Zone | null {
  const rect = element?.getBoundingClientRect();
  return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
}
