/**
 * The museum exhibits whose effect other visitors see and hear — see
 * docs/protocol.md#exhibition-museum-scene. Each maps to how many distinct
 * `index` values it takes: one for a station that is simply set off, one per
 * petak for the walk-on engklek court. The Unity client's
 * `Museum.Core.MuseumInteractions` carries the same ids.
 *
 * Only what is safe to share is listed. Video screens and lesson plaques are not:
 * one visitor walking up to a screen or paging a plaque would start, stop or turn
 * it for everyone reading it.
 */
export const MUSEUM_STATIONS: Readonly<Record<string, number>> = {
  gong: 1,
  gasing: 1,
  tembang: 1,
  engklek: 8,
};

/** How many `index` values a station takes; 0 for anything not in the list. */
export function stationSlots(station: string): number {
  return Object.hasOwn(MUSEUM_STATIONS, station) ? MUSEUM_STATIONS[station] : 0;
}

/**
 * Where a visitor is, as far as the hall is concerned: `""` walking it, or the
 * game room they went through a doorway to play. There is no Engklek game room
 * yet — its doorway is a "segera hadir" notice — so it is not listed.
 */
export const MUSEUM_ACTIVITIES = ["", "dakon", "egrang"] as const;

export function isMuseumActivity(value: string): boolean {
  return (MUSEUM_ACTIVITIES as readonly string[]).includes(value);
}

/**
 * Interactions a visitor may set off per second. The engklek court fires two at
 * once (side-by-side petak), and a keen visitor mashes the gong, so it is set
 * well above a human's pace — it exists to stop a flood, not to shape play.
 */
export const INTERACTS_PER_SECOND = 8;
