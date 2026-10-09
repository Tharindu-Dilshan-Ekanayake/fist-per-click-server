const colyseus = require('colyseus')

/**
 * Real-time lobbies, as a Colyseus room.
 *
 * One Colyseus room hosts every connected player - `lobbies` (an existing
 * LobbyManager, handed in via `gameServer.define('lobby', LobbyRoom, { lobbies })`)
 * is what actually decides which logical lobby (of up to MAX_PLAYERS) a given
 * player belongs to, same as before Colyseus; every broadcast here is filtered
 * down to one lobby's members. Colyseus's room is just the one shared connection
 * pool underneath, and its ping/pong keeps dead connections reaped for us.
 *
 * Protocol: unchanged from the plain-WebSocket version, except 'hello' is gone -
 * joining a room already carries what it used to (name/avatar/gun/pet/trainer/footprints),
 * as the join options. Everything else is still a typed message:
 *
 *   client -> server
 *     'profile' { name, avatar, gun, pet, trainer, footprints }  any of these changed
 *     'state'   { p: [x, y, z], sw, ts }  own position; sw counts shots fired,
 *                                         ts is the sender's clock in ms
 *
 *   server -> client
 *     'welcome' { id, lobby: { id, name, max }, players: [player...] }
 *     'join' { player }   'leave' { id }
 *     'profile' { id, name, avatar, gun, pet, trainer, footprints }
 *     'states' { s: [[id, x, y, z, sw, ts], ...] }   everyone who moved, 20/s
 */

const TICK_MS = 1000 / 20
const MAX_AVATAR_BYTES = 4 * 1024
const MAX_MESSAGES_PER_SECOND = 40
const NAME_MAX = 24
const GUN_MAX = 32
const PET_MAX = 32
const TRAINER_MAX = 32
const FOOTPRINTS_MAX = 32
/** Positions outside this box are rejected as garbage. */
const WORLD_LIMIT = 10000
/**
 * Players one pod holds. The deploy tells Legion's matchmaker the same number as
 * `seatCap` (see .github/workflows/deploy.yml): when a pod is this full, the
 * matchmaker starts another rather than squeezing one more in. Keep the two equal.
 */
const SEAT_CAP = Number(process.env.SEAT_CAP) || 50

/** Name, avatar, gun, equipped pet, footprints and active target pad from a
 *  join/profile message, cleaned up. */
function readProfile(message) {
  const name = typeof message?.name === 'string' ? message.name.trim().slice(0, NAME_MAX) : ''
  const gun = typeof message?.gun === 'string' ? message.gun.slice(0, GUN_MAX) : null
  const pet = typeof message?.pet === 'string' ? message.pet.slice(0, PET_MAX) : null
  const trainer = typeof message?.trainer === 'string' ? message.trainer.slice(0, TRAINER_MAX) : null
  const footprints = typeof message?.footprints === 'string' ? message.footprints.slice(0, FOOTPRINTS_MAX) : null
  let avatar = null
  if (message?.avatar && typeof message.avatar === 'object') {
    const size = JSON.stringify(message.avatar).length
    if (size <= MAX_AVATAR_BYTES) avatar = message.avatar
  }
  return { name: name || 'Player', avatar, gun, pet, trainer, footprints }
}

/** `[x, y, z]` rounded to centimetres, or null if it isn't a sane position. */
function readPosition(value) {
  if (!Array.isArray(value) || value.length !== 3) return null
  const out = []
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > WORLD_LIMIT) return null
    out.push(Math.round(n * 100) / 100)
  }
  return out
}

/** What other players get to see of a player (never the client). */
function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    gun: player.gun,
    pet: player.pet,
    trainer: player.trainer,
    footprints: player.footprints,
    p: player.p,
    sw: player.sw,
  }
}

function lobbyInfo(lobby, manager) {
  return { id: lobby.id, name: lobby.name, max: manager.maxPlayers }
}

/** True (and bumps the count) once a player has sent too many messages this second. */
function overRate(player) {
  const now = Date.now()
  if (now - player.windowStart >= 1000) {
    player.windowStart = now
    player.windowCount = 0
  }
  return ++player.windowCount > MAX_MESSAGES_PER_SECOND
}

class LobbyRoom extends colyseus.Room {
  /** `lobbies`: the shared LobbyManager, passed in via gameServer.define(...). */
  onCreate({ lobbies }) {
    this.lobbies = lobbies
    this.maxClients = SEAT_CAP
    this.tick = setInterval(() => this.broadcastMoved(), TICK_MS)

    this.onMessage('state', (client, message) => {
      const player = this.playerFor(client)
      if (!player || overRate(player)) return
      const p = readPosition(message?.p)
      if (!p) return
      player.p = p
      if (Number.isSafeInteger(message.sw) && message.sw >= 0) player.sw = message.sw
      if (typeof message.ts === 'number' && Number.isFinite(message.ts) && message.ts >= 0) {
        player.ts = message.ts
      }
      player.moved = true
    })

    this.onMessage('profile', (client, message) => {
      const player = this.playerFor(client)
      if (!player || overRate(player)) return
      Object.assign(player, readProfile(message))
      const lobby = this.lobbies.lobbyOf(player.id)
      if (lobby) {
        this.tellLobby(
          lobby,
          'profile',
          {
            id: player.id,
            name: player.name,
            avatar: player.avatar,
            gun: player.gun,
            pet: player.pet,
            trainer: player.trainer,
            footprints: player.footprints,
          },
          player,
        )
      }
    })
  }

  /** Joining the room already carries what 'hello' used to (name/avatar/gun). */
  onJoin(client, options) {
    const player = {
      id: client.sessionId,
      client,
      ...readProfile(options),
      p: [0, 0, 0],
      sw: 0,
      ts: 0,
      moved: false,
      windowStart: Date.now(),
      windowCount: 0,
    }
    const lobby = this.lobbies.join(player)
    client.send('welcome', {
      id: player.id,
      lobby: lobbyInfo(lobby, this.lobbies),
      players: [...lobby.players.values()].filter((other) => other !== player).map(publicPlayer),
    })
    this.tellLobby(lobby, 'join', { player: publicPlayer(player) }, player)
    console.log(
      `[lobby] ${player.name} (${player.id}) joined ${lobby.name} - ${lobby.players.size}/${this.lobbies.maxPlayers}`,
    )
  }

  onLeave(client) {
    const player = this.playerFor(client)
    if (!player) return
    const lobby = this.lobbies.leave(player.id)
    if (lobby) {
      this.tellLobby(lobby, 'leave', { id: player.id })
      console.log(
        `[lobby] ${player.name} (${player.id}) left ${lobby.name} - ${lobby.players.size}/${this.lobbies.maxPlayers}`,
      )
    }
  }

  onDispose() {
    clearInterval(this.tick)
  }

  /** The player record for `client`, found via the lobby it's already in. */
  playerFor(client) {
    return this.lobbies.lobbyOf(client.sessionId)?.players.get(client.sessionId) ?? null
  }

  /** Sends to everyone in `lobby` (except `except`). */
  tellLobby(lobby, type, message, except = null) {
    for (const player of lobby.players.values()) {
      if (player !== except) player.client.send(type, message)
    }
  }

  /** Everyone who moved since the last tick, one message per lobby. */
  broadcastMoved() {
    for (const lobby of this.lobbies.lobbies.values()) {
      const moved = []
      for (const player of lobby.players.values()) {
        if (!player.moved) continue
        player.moved = false
        moved.push([player.id, ...player.p, player.sw, player.ts])
      }
      if (moved.length > 0) this.tellLobby(lobby, 'states', { s: moved })
    }
  }
}

module.exports = { LobbyRoom }
