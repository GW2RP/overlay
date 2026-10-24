import { useEffect, useRef, type ReactNode } from "react";

const ATTEIGNABLES = "input:not([disabled]), button:not([disabled]), select:not([disabled])";

/**
 * Une boîte posée sur la fenêtre, derrière un voile : elle garde le focus —
 * `Tab` tourne dans la boîte sans atteindre ce que le voile couvre —, se
 * referme à `Échap`, et rend le focus à ce qui l'avait quand elle part.
 * Son bouton principal est le seul carmin de l'écran tant qu'elle est là.
 */
export function Modale({
  titre,
  onFermer,
  children,
  actions,
}: {
  titre: string;
  onFermer: () => void;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const boite = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    const premier = boite.current?.querySelector<HTMLElement>(ATTEIGNABLES);
    premier?.focus();
    return () => avant?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-scrim p-6">
      <div
        ref={boite}
        role="dialog"
        aria-modal="true"
        aria-labelledby="titre-modale"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onFermer();
            return;
          }
          if (e.key !== "Tab" || !boite.current) return;
          const atteignables = [...boite.current.querySelectorAll<HTMLElement>(ATTEIGNABLES)];
          if (atteignables.length === 0) return;
          const premier = atteignables[0];
          const dernier = atteignables[atteignables.length - 1];
          if (e.shiftKey && document.activeElement === premier) {
            e.preventDefault();
            dernier.focus();
          } else if (!e.shiftKey && document.activeElement === dernier) {
            e.preventDefault();
            premier.focus();
          }
        }}
        className="flex w-full max-w-xl flex-col border border-rule bg-surface"
      >
        <h2 id="titre-modale" className="panel-title border-b border-hairline px-6 py-4 text-ink">
          {titre}
        </h2>
        {children ? <div className="flex flex-col gap-4 px-6 py-5">{children}</div> : null}
        <div className="flex justify-end gap-3 border-t border-hairline px-6 py-4">{actions}</div>
      </div>
    </div>
  );
}
