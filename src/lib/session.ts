import { useCallback, useEffect, useState } from "react";

import { CLES, surChangement } from "@/lib/reglages";
import { ErreurHub, lireSession } from "@/lib/nexus";
import type { Utilisateur } from "@/lib/types";

export type Session =
  | { etat: "chargement" }
  | { etat: "deconnecte" }
  | { etat: "connecte"; utilisateur: Utilisateur }
  | { etat: "injoignable"; message: string };

/** La session du compte : relue au démarrage depuis le jeton rangé, et à
 *  chaque fois que le jeton change — une déconnexion faite dans une autre
 *  fenêtre se voit ici. */
export function useSession(): { session: Session; rafraichir: () => Promise<void> } {
  const [session, setSession] = useState<Session>({ etat: "chargement" });

  const rafraichir = useCallback(async () => {
    try {
      const utilisateur = await lireSession();
      setSession(utilisateur ? { etat: "connecte", utilisateur } : { etat: "deconnecte" });
    } catch (erreur) {
      setSession({
        etat: "injoignable",
        message: erreur instanceof ErreurHub ? erreur.message : "Le hub ne répond pas.",
      });
    }
  }, []);

  useEffect(() => {
    // Au prochain tour de boucle, pas dans l'effet même : la relecture pose un
    // état une fois la réponse du hub arrivée, jamais pendant le rendu.
    void Promise.resolve().then(rafraichir);
    let arreter: (() => void) | null = null;
    let parti = false;
    void surChangement<string>(CLES.jeton, () => void rafraichir()).then((stop) => {
      if (parti) stop();
      else arreter = stop;
    });
    return () => {
      parti = true;
      arreter?.();
    };
  }, [rafraichir]);

  return { session, rafraichir };
}
