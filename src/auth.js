const crypto = require('node:crypto')

/**
 * Who a request is from, according to Bloxity - never according to the request.
 *
 * The client sends the player's Bloxity token as `Authorization: Bearer <token>`,
 * and we ask Bloxity's API who it belongs to, exactly as the SDK itself does when it
 * restores a session: `POST /v1/auth/game-token/verify` with this game's slug (the
 * token a game is handed when embedded on bloxity.io is scoped to that game), and
 * `GET /v1/auth/me` for an ordinary account token. Whatever user the API returns is
 * the user; a body that claims to be someone else is ignored.
 *
 * Answers are cached for a few minutes, keyed by a hash of the token, so a save every
 * few seconds is not a round trip to Bloxity every few seconds. Rejections are cached
 * for less, so a token that was briefly refused (a Bloxity hiccup) recovers quickly.
 */

const API_URL = (process.env.BLOXITY_API_URL || 'https://api.bloxity.io').replace(/\/+$/, '')
/**
 * The slug the game is registered under on bloxity.io. Usually the same string as
 * its hosting id, which Legion injects as BLOXITY_GAME_ID; set BLOXITY_GAME_SLUG
 * only if the two differ.
 */
const GAME_SLUG = process.env.BLOXITY_GAME_SLUG || process.env.BLOXITY_GAME_ID || ''

const OK_TTL_MS = 5 * 60 * 1000
const FAIL_TTL_MS = 20 * 1000
const TIMEOUT_MS = 8000
const MAX_CACHE = 5000

/** token hash -> { user: { id, username } | null, until } */
const cache = new Map()

const hash = (token) => crypto.createHash('sha256').update(token).digest('base64url')

/** The user out of either endpoint's answer (`{ user }` or the user itself). */
function userFrom(payload) {
  const user = payload && typeof payload === 'object' && 'user' in payload && payload.user ? payload.user : payload
  const id = user?._id ?? user?.id
  if (typeof id !== 'string' || !id) return null
  return { id, username: typeof user.username === 'string' ? user.username : '' }
}

async function ask(path, token, init = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return userFrom(await res.json())
}

/**
 * The Bloxity user a token belongs to: `{ id, username }`, or null if Bloxity does
 * not recognise it. Throws only when Bloxity could not be asked at all, so callers
 * can tell "not signed in" (401) from "try again" (503).
 */
async function verifyToken(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 8192) return null
  const key = hash(token)
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.user

  let user = null
  if (GAME_SLUG) {
    user = await ask('/v1/auth/game-token/verify', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSlug: GAME_SLUG }),
    }).catch(() => null)
  }
  user ??= await ask('/v1/auth/me', token)

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
  cache.set(key, { user, until: Date.now() + (user ? OK_TTL_MS : FAIL_TTL_MS) })
  return user
}

/** The bearer token from a request, or null. */
function bearer(req) {
  const header = req.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

/**
 * Express middleware: puts the verified user on `req.user`, or answers 401 (no or
 * bad token) or 503 (Bloxity unreachable) and stops.
 */
function requireUser(req, res, next) {
  const token = bearer(req)
  if (!token) return res.status(401).json({ error: 'not signed in' })
  verifyToken(token).then(
    (user) => {
      if (!user) return res.status(401).json({ error: 'token not recognised' })
      req.user = user
      next()
    },
    (error) => {
      console.warn('[auth] could not reach Bloxity:', error.message)
      res.status(503).json({ error: 'could not verify you right now, try again' })
    },
  )
}

module.exports = { requireUser, verifyToken }
