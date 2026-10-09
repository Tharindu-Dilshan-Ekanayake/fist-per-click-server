const cors = require('cors')

const { attachRealtime, originIsAllowed } = require('./realtime')
const { mountRoutes } = require('./routes')
const { openStore } = require('./store')

const PORT = process.env.PORT || 3000

/**
 * Every browser origin allowed to open a lobby socket or call the API.
 *
 * Three sources, because three different things know a piece of the answer. The
 * Vite dev origins are constants and belong in the code. `CLIENT_ORIGIN` is what
 * Bloxity Legion sets to the game's own address, so on Legion the main one needs no
 * configuring at all. `ALLOWED_ORIGINS` is the comma-separated list for everything
 * else - preview builds, a phone on the Wi-Fi, a second front end.
 */
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.CLIENT_ORIGIN ? [process.env.CLIENT_ORIGIN.trim()] : []),
  ...(process.env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
]

async function main() {
  // Before listening, on purpose: Legion sends no traffic to a pod until /health
  // answers, so a pod that cannot reach its database never takes a player whose
  // progress it would then fail to save. If it cannot connect at all it exits, and
  // the platform starts it again.
  const store = await openStore()

  // Express and the lobby room (Colyseus) share one HTTP server and port; Colyseus
  // owns the Express app (see realtime.js).
  const realtime = attachRealtime({ allowedOrigins: ALLOWED_ORIGINS })
  const { app } = realtime

  app.use(
    cors({
      // A function, not the plain array, so a Legion-hosted build of this game is
      // trusted the same way the socket already trusts it - see originIsAllowed's
      // own comment in realtime.js for why that one extra case is safe.
      origin: (origin, callback) => callback(null, originIsAllowed(origin, ALLOWED_ORIGINS)),
      credentials: true,
    }),
  )

  /**
   * Two paths, one answer.
   *
   * `/health` is the one Bloxity Legion polls: a new deploy is given no traffic until
   * it replies, and a pod that stops replying is replaced. `/api/health` is what
   * render.yaml points at. Keeping both costs a line and means neither host has to be
   * talked out of its own convention.
   */
  const health = (_req, res) => res.json({ ok: true, store: store.kind })
  app.get('/health', health)
  app.get('/api/health', health)

  // Cloud saves and the leaderboards (see routes.js).
  mountRoutes(app, store)

  /** Open lobbies on this pod and how full they are. */
  app.get('/api/lobbies', (_req, res) => {
    res.json({ lobbies: realtime.lobbies.list() })
  })

  await realtime.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT} (lobbies over Colyseus, saves in ${store.kind})`)
  })

  /**
   * Let the host drain this process instead of cutting it off.
   *
   * A rolling deploy sends SIGTERM and then waits a while before killing what is
   * left. Node's default answer to SIGTERM is to die on the spot - and every player
   * in a lobby is holding a WebSocket open, so that drops all of them, mid-game, on
   * every single deploy. Colyseus's graceful shutdown closes the rooms first, which
   * gives each client an ordinary disconnect it already knows how to recover from:
   * it asks the matchmaker again and lands on the fresh pod (see the client's
   * lobbyClient.js). Progress is not at risk either way - it is saved over HTTP, to
   * the database, every few seconds - so the database is closed last.
   */
  let draining = false
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (draining) return
      draining = true
      console.log(`${signal} received - draining lobbies`)
      realtime
        .close()
        .then(() => store.close())
        .then(
          () => process.exit(0),
          (error) => {
            console.error('graceful shutdown failed:', error)
            process.exit(1)
          },
        )
    })
  }
}

main().catch((error) => {
  console.error('server failed to start:', error)
  process.exit(1)
})
