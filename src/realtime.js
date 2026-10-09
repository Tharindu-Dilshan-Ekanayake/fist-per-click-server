const colyseus = require('colyseus')
const { WebSocketTransport } = require('@colyseus/ws-transport')

const { LobbyManager } = require('./lobbies')
const { LobbyRoom } = require('./lobbyRoom')

/** Rejects any single message bigger than this outright. */
const MAX_MESSAGE_BYTES = 16 * 1024
/**
 * How often (and how many missed replies) before a connection is dropped as dead
 * (closed laptop, lost Wi-Fi) - lenient, so a briefly backgrounded tab survives.
 */
const HEARTBEAT_MS = 15000
const HEARTBEAT_RETRIES = 2

/**
 * A trusted platform host whose subdomains this game may be served from.
 *
 * Stopgap for Bloxity Legion specifically, not a general escape hatch. Legion sets
 * `CLIENT_ORIGIN` to "your game site" for CORS, but it was still refusing this
 * game's own Legion-hosted frontend after a fresh deploy (both this game's PROD
 * and DEV player pages are *.bloxity.io addresses we don't control the exact
 * spelling of, and Legion's dashboard has no field to add one to ALLOWED_ORIGINS
 * either) - so exact-matching alone left every Legion-hosted build of this game
 * refusing its own socket, indefinitely, until that gets sorted out on their side.
 *
 * A whole second-level domain, not a wildcard prefix match: `*.bloxity.io` is safe
 * to trust here specifically because nobody outside Bloxity can get a page served
 * from under it - it is their platform, not a public suffix like `*.dev` or
 * `*.app` a stranger could also get a domain under. Remove this the day Legion's
 * origin handling actually works, or exposes a way to list one explicitly.
 */
const TRUSTED_HOST_SUFFIX = '.bloxity.io'

/** Whether `origin` is exactly in `allowedOrigins`, or a `TRUSTED_HOST_SUFFIX` address. */
function originIsAllowed(origin, allowedOrigins) {
  if (!origin) return true
  if (!allowedOrigins) return true
  if (allowedOrigins.includes(origin)) return true
  try {
    return new URL(origin).hostname.endsWith(TRUSTED_HOST_SUFFIX)
  } catch {
    return false
  }
}

/**
 * Sets up the lobby room and matchmaking (see lobbyRoom.js for the protocol).
 *
 * Colyseus owns the HTTP server here, not the caller - its matchmaking endpoints
 * have to live on the same Express app the WebSocket upgrades are served from.
 * The caller gets that app back (`app`) to mount its own routes on, and a
 * `listen(port, cb)` to bind everything to one port.
 *
 * @param {{ allowedOrigins?: string[] }} [options]
 *   Browsers always send an Origin header; connections from other origins are
 *   refused (with the one exception in `originIsAllowed` above). Non-browser
 *   clients (tests, tools) send none and are let through.
 * @returns {{ lobbies: LobbyManager, app: import('express').Application,
 *             listen: (port: number, cb?: () => void) => Promise<any>, close: () => Promise<void> }}
 */
function attachRealtime({ allowedOrigins } = {}) {
  const lobbies = new LobbyManager()

  const transport = new WebSocketTransport({
    maxPayload: MAX_MESSAGE_BYTES,
    pingInterval: HEARTBEAT_MS,
    pingMaxRetries: HEARTBEAT_RETRIES,
    verifyClient: ({ origin }) => originIsAllowed(origin, allowedOrigins),
  })
  const app = transport.getExpressApp()

  const gameServer = new colyseus.Server({ transport })
  gameServer.define('lobby', LobbyRoom, { lobbies })

  return {
    lobbies,
    app,
    listen: (port, cb) => gameServer.listen(port).then(() => cb?.()),
    close: () => gameServer.gracefullyShutdown(false),
  }
}

module.exports = { attachRealtime, originIsAllowed }
