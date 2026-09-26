import {
  AdventureIcon,
  BannerIcon,
  CloudIcon,
  EstateIcon,
  HouseIcon,
  MistIcon,
  RainIcon,
  RuinIcon,
  ScalesIcon,
  SnowIcon,
  StormIcon,
  SunIcon,
  TavernIcon,
  TentIcon,
  TradeIcon,
  WindIcon,
} from "@/components/icons";
import type { EventType, Phenomene, PlaceType, WeatherCondition } from "@/lib/domaine";

/** La correspondance type → glyphe, la même que celle du hub. Une valeur que
 *  cette version ne connaît pas prend le glyphe de repli plutôt que rien. */

type GlyphProps = { size?: number; className?: string };
type Glyph = (props: GlyphProps) => React.ReactElement;

const EVENT_GLYPHS: Record<EventType, Glyph> = {
  taverne: TavernIcon,
  aventure: AdventureIcon,
  commerce: TradeIcon,
  ceremonie: BannerIcon,
  intrigue: ScalesIcon,
};

const PLACE_GLYPHS: Record<PlaceType, Glyph> = {
  taverne: TavernIcon,
  guilde: BannerIcon,
  ruine: RuinIcon,
  commerce: TradeIcon,
  domaine: EstateIcon,
  maison: HouseIcon,
  campement: TentIcon,
};

const WEATHER_GLYPHS: Record<WeatherCondition, Glyph> = {
  degage: SunIcon,
  nuages: CloudIcon,
  "pluie-fine": RainIcon,
  orage: StormIcon,
  brume: MistIcon,
  neige: SnowIcon,
};

const PHENOMENE_GLYPHS: Record<Phenomene, Glyph> = {
  orage: StormIcon,
  neige: SnowIcon,
  pluie: RainIcon,
  brume: MistIcon,
  vent: WindIcon,
  chaleur: SunIcon,
};

export function EventGlyph({ type, ...props }: GlyphProps & { type: string }) {
  const Component = EVENT_GLYPHS[type as EventType] ?? TavernIcon;
  return <Component {...props} />;
}

export function PlaceGlyph({ type, ...props }: GlyphProps & { type: string }) {
  const Component = PLACE_GLYPHS[type as PlaceType] ?? TavernIcon;
  return <Component {...props} />;
}

export function WeatherGlyph({ condition, ...props }: GlyphProps & { condition: string }) {
  const Component = WEATHER_GLYPHS[condition as WeatherCondition] ?? CloudIcon;
  return <Component {...props} />;
}

export function PhenomeneGlyph({ phenomene, ...props }: GlyphProps & { phenomene: string }) {
  const Component = PHENOMENE_GLYPHS[phenomene as Phenomene] ?? CloudIcon;
  return <Component {...props} />;
}
