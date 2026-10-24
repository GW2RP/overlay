import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/**
 * Le serveur MCP de l'éditeur de pavillon, vu du front.
 *
 * Le serveur vit dans Rust (`src-tauri/src/mcp.rs`) : il écoute la boucle
 * locale, vérifie le jeton, et relaie chaque appel d'outil à cette fenêtre,
 * où vivent la disposition et la scène. La fenêtre répond par
 * `mcp_repondre`. Elle ne fait qu'exécuter : ni le port ni le jeton ne
 * passent par elle, sauf pour les montrer.
 */

export type EtatMcp = {
  actif: boolean;
  adresse: string;
  jeton: string;
  erreur: string | null;
};

export function etatMcp(): Promise<EtatMcp> {
  return invoke<EtatMcp>("etat_mcp");
}

export function reglerMcp(actif: boolean): Promise<EtatMcp> {
  return invoke<EtatMcp>("regler_mcp", { actif });
}

export function renouvelerJetonMcp(): Promise<EtatMcp> {
  return invoke<EtatMcp>("renouveler_jeton_mcp");
}

/** La commande qui branche Claude Code sur ce serveur. */
export function commandeClaudeCode(etat: EtatMcp): string {
  return `claude mcp add --transport http gw2rp-pavillon ${etat.adresse} --header "Authorization: Bearer ${etat.jeton}"`;
}

/** Un morceau du contenu que le protocole rend. */
export type Contenu =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Une erreur qu'un outil rend à Claude, en une phrase. */
export class ErreurOutil extends Error {}

/** Du texte, ou du JSON sans espaces : une liste de cent décorations
 *  indentée coûterait trois fois sa place à qui la lit. */
export function texte(valeur: unknown): Contenu {
  return { type: "text", text: typeof valeur === "string" ? valeur : JSON.stringify(valeur) };
}

type Appel = { id: number; outil: string; arguments: Record<string, unknown> };

/** Écoute les appels relayés par Rust, puis se déclare prête : un appel
 *  envoyé avant l'écoute se perdrait. `traiter` est relu à chaque appel. */
export function useAppelsMcp(
  traiter: (outil: string, args: Record<string, unknown>) => Promise<Contenu[]>,
) {
  const courant = useRef(traiter);
  useEffect(() => {
    courant.current = traiter;
  });

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;

    void listen<Appel>("mcp-appel", (recu) => {
      if (parti) return;
      const { id, outil, arguments: args } = recu.payload;
      courant
        .current(outil, args ?? {})
        .then((contenu) => invoke("mcp_repondre", { id, contenu }))
        .catch((cause: unknown) => {
          const phrase =
            cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "L'outil a échoué.";
          if (!(cause instanceof ErreurOutil)) console.error(`l'outil MCP « ${outil} » a échoué`, cause);
          return invoke("mcp_repondre", { id, erreur: phrase });
        })
        .catch((cause) => console.error("la réponse MCP ne part pas", cause));
    })
      .then((stop) => {
        if (parti) {
          stop();
          return;
        }
        arreter = stop;
        return invoke("mcp_pret");
      })
      .catch((cause) => console.error("les appels MCP ne s'écoutent pas", cause));

    return () => {
      parti = true;
      arreter?.();
    };
  }, []);
}

/** Attend qu'une condition tienne, en la relisant : l'état de React arrive
 *  après le geste qui l'a demandé. */
export async function attendre(condition: () => boolean, delai: number, quoi: string): Promise<void> {
  const fin = Date.now() + delai;
  while (!condition()) {
    if (Date.now() > fin) throw new ErreurOutil(`${quoi} n'est pas arrivé à temps.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
