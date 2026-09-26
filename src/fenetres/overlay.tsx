import { CadreElement } from "@/components/cadre-element";
import { Meteo } from "@/elements/meteo";
import { Personnage } from "@/elements/personnage";
import { Proximite } from "@/elements/proximite";
import { useEdition, type Element } from "@/lib/overlays";
import { usePosition } from "@/lib/position";

/** Une fenêtre d'overlay : un élément dans son cadre, nourri de la position
 *  du personnage. */
export function FenetreOverlay({ element }: { element: Element }) {
  const edition = useEdition();
  const position = usePosition();

  return (
    <CadreElement element={element} edition={edition}>
      {element.id === "meteo" ? (
        <Meteo position={position} />
      ) : element.id === "proximite" ? (
        <Proximite element={element} position={position} />
      ) : (
        <Personnage position={position} />
      )}
    </CadreElement>
  );
}
