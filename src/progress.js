/**
 * What a saved game may contain, and the cleaning every save gets on the way in.
 *
 * The game is a single-player clicker at heart: Strength and Wins are counted in the
 * browser, and the server cannot replay every click to check them. What it can do is
 * refuse anything malformed, keep numbers finite and inside JavaScript's exact range,
 * keep lists short and made of short strings, and keep what is equipped consistent
 * with what is owned.
 */

/** Numbers in a save: finite, not negative, at most this. */
const MAX_NUMBER = Number.MAX_SAFE_INTEGER * 1e6
const MAX_LIST = 200
const MAX_ID = 40

const NUMBERS = ['strength', 'rebirths', 'wins', 'bestWall', 'spaceBest', 'ringWins', 'ringStreak']
const LISTS = ['owned', 'ownedPets', 'equippedPets', 'unlockedTrainers', 'ownedPasses', 'ownedFootprints']
const STRINGS = ['equipped', 'footprints']
const BOOLEANS = ['opAutoOwned', 'autoWins']

const cleanNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_NUMBER) : 0

const cleanList = (value) =>
  Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID))].slice(
        0,
        MAX_LIST,
      )
    : []

/** A running boost `{ multiplier, until }`, or null. */
function cleanBoost(value) {
  if (!value || typeof value !== 'object') return null
  const multiplier = cleanNumber(value.multiplier)
  const until = cleanNumber(value.until)
  if (![2, 4, 8].includes(multiplier) || !until) return null
  return { multiplier, until }
}

/**
 * A save as the client sent it, made safe to store: every field typed and bounded,
 * nothing unknown kept.
 *
 * Returns null if `input` is not an object at all.
 *
 * @param {unknown} input
 */
function sanitizeProgress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const out = {}
  for (const key of NUMBERS) out[key] = cleanNumber(input[key])
  for (const key of LISTS) out[key] = cleanList(input[key])
  for (const key of STRINGS) out[key] = typeof input[key] === 'string' ? input[key].slice(0, MAX_ID) : null
  for (const key of BOOLEANS) out[key] = input[key] === true
  out.boost = cleanBoost(input.boost)
  out.rebirths = Math.floor(out.rebirths)

  // A pet that is not owned cannot be following you, nor gloves on your hands.
  out.equippedPets = out.equippedPets.filter((id) => out.ownedPets.includes(id))
  if (out.equipped && !out.owned.includes(out.equipped)) out.equipped = out.owned[0] ?? null
  if (!out.equipped) delete out.equipped
  // Footprints are bought per pair of gloves, and only the ones bought can be worn.
  out.ownedFootprints = out.ownedFootprints.filter((id) => out.owned.includes(id))
  if (!out.ownedFootprints.includes(out.footprints)) out.footprints = null
  return out
}

module.exports = { sanitizeProgress }
