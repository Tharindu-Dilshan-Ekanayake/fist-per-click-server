const express = require('express')

const { requireUser, verifyToken } = require('./auth')
const { sanitizeProgress } = require('./progress')

/** Least time between two saves from one account; anything faster is turned away. */
const MIN_SAVE_GAP_MS = 1000
/** Rows on each leaderboard, and how long one answer is reused. */
const LEADERBOARD_SIZE = 10
const LEADERBOARD_TTL_MS = 30 * 1000
/** A save is a few kilobytes; anything near this is not one. */
const MAX_BODY = '64kb'

/**
 * The game's HTTP API, mounted on the same Express app (and port) as Colyseus.
 *
 *   GET  /api/progress         the signed-in player's save
 *   PUT  /api/progress         store it
 *   POST /api/progress/beacon  store it, from a page that is closing (see below)
 *   GET  /api/leaderboard      the top players, for the boards in the lobby
 *
 * The first three are the player's own browser, carrying their Bloxity token (see
 * auth.js). Everything goes through the database, never a pod's memory, so any pod
 * can answer any of them.
 *
 * @param {import('express').Application} app
 * @param {Awaited<ReturnType<import('./store').openStore>>} store
 */
function mountRoutes(app, store) {
  const json = express.json({ limit: MAX_BODY })

  app.get('/api/progress', requireUser, async (req, res) => {
    try {
      const save = await store.getSave(req.user.id)
      res.json({ progress: save?.progress ?? null, rev: save?.rev ?? 0 })
    } catch (error) {
      console.error('[progress] load failed:', error)
      res.status(500).json({ error: 'could not load your progress' })
    }
  })

  /**
   * The lobby's leaderboards: the top LEADERBOARD_SIZE signed-in players by Wins, by
   * Rebirths, and by bosses beaten. Public - names and scores only - and cached per
   * pod for LEADERBOARD_TTL_MS, so a full lobby asking at once is one set of queries.
   */
  let board = null
  app.get('/api/leaderboard', async (_req, res) => {
    try {
      if (!board || Date.now() - board.at > LEADERBOARD_TTL_MS) {
        const [wins, rebirths, bosses] = await Promise.all(
          ['wins', 'rebirths', 'bossLevel'].map((field) => store.topSaves(field, LEADERBOARD_SIZE + 1)),
        )
        board = {
          at: Date.now(),
          body: {
            wins: wins.slice(0, LEADERBOARD_SIZE),
            rebirths: rebirths.slice(0, LEADERBOARD_SIZE),
            // The save holds the next boss to fight; the board counts the ones beaten.
            bosses: bosses
              .map(({ username, value }) => ({ username, value: value - 1 }))
              .filter((row) => row.value > 0)
              .slice(0, LEADERBOARD_SIZE),
          },
        }
      }
      res.set('Cache-Control', 'public, max-age=30').json(board.body)
    } catch (error) {
      console.error('[leaderboard] failed:', error)
      res.status(500).json({ error: 'could not load the leaderboard' })
    }
  })

  /** userId -> time of their last accepted save. Per pod, which is plenty for a rate limit. */
  const lastSave = new Map()

  /** The shared half of both ways of saving: cleaned, then stored. Answers { status, body }. */
  async function storeSave(user, input) {
    const now = Date.now()
    if (now - (lastSave.get(user.id) ?? 0) < MIN_SAVE_GAP_MS) return { status: 429, body: { error: 'saving too often' } }
    lastSave.set(user.id, now)
    const progress = sanitizeProgress(input)
    if (!progress) return { status: 400, body: { error: 'no progress in that request' } }
    const rev = await store.putSave(user.id, progress, user.username)
    return { status: 200, body: { rev } }
  }

  app.put('/api/progress', requireUser, json, async (req, res) => {
    try {
      const { status, body } = await storeSave(req.user, req.body?.progress)
      res.status(status).json(body)
    } catch (error) {
      console.error('[progress] save failed:', error)
      res.status(500).json({ error: 'could not save your progress' })
    }
  })

  /**
   * The last save from a page that is closing, sent with navigator.sendBeacon.
   *
   * A beacon cannot carry an Authorization header, and as `text/plain` it needs no
   * CORS preflight - which is the point: a closing page will not wait for one. So
   * the token comes in the body, `{ token, progress }`, and is checked exactly like
   * the header would have been. Nobody reads the answer.
   */
  app.post('/api/progress/beacon', express.text({ type: '*/*', limit: MAX_BODY }), async (req, res) => {
    let body
    try {
      body = JSON.parse(req.body)
    } catch {
      return res.status(400).end()
    }
    try {
      const user = await verifyToken(body?.token)
      if (!user) return res.status(401).end()
      const { status } = await storeSave(user, body.progress)
      res.status(status).end()
    } catch (error) {
      console.error('[progress] beacon save failed:', error)
      res.status(500).end()
    }
  })
}

module.exports = { mountRoutes }
