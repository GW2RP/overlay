import { CadreElement } from "@/components/cadre-element";
import { Aujourdhui } from "@/elements/aujourdhui";
import { Meteo } from "@/elements/meteo";
import { Personnage } from "@/elements/personnage";
import { Proximite } from "@/elements/proximite";
import { useEdition, useVisible, type Element } from "@/lib/overlays";
import { usePosition } from "@/lib/position";

/** Une fenêtre d'overlay : un élément dans son cadre, nourri de la position
 *  du personnage. Les éléments qui lisent le hub reçoivent la visibilité de
 *  leur fenêtre : cachée, elle ne demande rien — toutes naissent cachées, et
 *  la plupart ne s'ouvrent jamais. Une prop plutôt qu'un démontage : l'élément
 *  garde sa dernière lecture et ne la refait pas si on le remontre aussitôt. */
export function FenetreOverlay({ element }: { element: Element }) {
  const edition = useEdition();
  const position = usePosition();
  const visible = useVisible(element.label);

  return (
    <CadreElement element={element} edition={edition}>
      {element.id === "meteo" ? (
        <Meteo position={position} actif={visible} />
      ) : element.id === "proximite" ? (
        <Proximite element={element} position={position} actif={visible} />
      ) : element.id === "aujourdhui" ? (
        <Aujourdhui element={element} actif={visible} />
      ) : (
        <Personnage position={position} />
      )}
    </CadreElement>
  );
}
