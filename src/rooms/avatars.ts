/**
 * The characters a player can wear, chosen on the client's welcome screen and
 * sent as the `avatar` join option. They are the four ASSET_NUSANTARA models in
 * the Unity client (`Char_Jawa_L`, `Char_Bali_P`, `Char_Bugis_P`,
 * `Char_Minang_L`). See docs/protocol.md.
 *
 * Cosmetic only — an avatar never changes a rule — but the list lives here
 * rather than being trusted from the client, so a peer can never be told to
 * render something the other clients do not ship.
 */
export const AVATAR_IDS = ["jawa", "bali", "bugis", "minang"] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

/** What a player wears when they sent nothing, or something not in the list. */
export const DEFAULT_AVATAR: AvatarId = "jawa";

/** A join option reduced to a known avatar id; anything else is the default. */
export function sanitizeAvatar(value: unknown): AvatarId {
  const id = (value ?? "").toString().trim().toLowerCase();
  return (AVATAR_IDS as readonly string[]).includes(id) ? (id as AvatarId) : DEFAULT_AVATAR;
}
