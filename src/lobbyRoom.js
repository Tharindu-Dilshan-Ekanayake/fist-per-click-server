const colyseus = require('colyseus')

const rings = require('./rings')

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
 * Protocol: joining a room carries the profile (name/avatar/glove/pet/trainer/
 * footprints/aura/level) as the join options. Everything else is a typed message:
 *
 *   client -> server
 *     'profile'   { name, avatar, glove, pet, trainer, footprints, aura, level }  any changed
 *     'state'     { p: [x, y, z], sw, ts }  own position; sw counts punches thrown,
 *                                           ts is the sender's clock in ms
 *     'padEnter'  { r, slot, power }   stepped onto ring r's pad (0 red, 1 blue)
 *     'padLeave'  { r, slot }          stepped off it
 *     'ringPunch' { r, power }         threw a punch in the ring (power: Strength)
 *
 *   server -> client
 *     'welcome'    { id, lobby: { id, name, max }, players: [player...], rings }
 *     'join' { player }   'leave' { id }
 *     'profile'    { id, name, avatar, glove, pet, trainer, footprints, aura, level }
 *     'states'     { s: [[id, x, y, z, sw, ts], ...] }   everyone who moved, 20/s
 *     'rings'      { rings: [{ f: [id|null, id|null], p: [id|null, id|null], hp, s, t }] }
 *     'ringStart'  { r, f, mh }                    two off the pads and into the ring, full health
 *     'ringCancel' { r, f }                        a fighter dropped before it started
 *     'ringHit'    { r, from, to, d, hp }          a punch landed
 *     'ringKO'     { r, winner, loser, reward, reason, draw, f }
 *     'ringMiss'   { r }                           (to the puncher) out of reach
 *     'ringDeny'   { r, slot, reason }             (to one player) can't take that pad
 *
 * The rings' rules are in rings.js.
 */

const TICK_MS = 1000 / 20
const MAX_AVATAR_BYTES = 4 * 1024
const MAX_MESSAGES_PER_SECOND = 40
const NAME_MAX = 24
const GLOVE_MAX = 32
const PET_MAX = 32
const TRAINER_MAX = 32
const FOOTPRINTS_MAX = 32
const AURA_MAX = 32
const LEVEL_MAX = 1000
/** Positions outside this box are rejected as garbage. */
const WORLD_LIMIT = 10000
/**
 * Players one pod holds. The deploy tells Legion's matchmaker the same number as
 * `seatCap` (see .github/workflows/deploy.yml): when a pod is this full, the
 * matchmaker starts another rather than squeezing one more in. Keep the two equal.
 */
const SEAT_CAP = Number(process.env.SEAT_CAP) || 50

/** Name, avatar, gloves, equipped pet, footprints and active training pad from a
 *  join/profile message, cleaned up. */
function readProfile(message) {
  const name = typeof message?.name === 'string' ? message.name.trim().slice(0, NAME_MAX) : ''
  const glove = typeof message?.glove === 'string' ? message.glove.slice(0, GLOVE_MAX) : null
  const pet = typeof message?.pet === 'string' ? message.pet.slice(0, PET_MAX) : null
  const trainer = typeof message?.trainer === 'string' ? message.trainer.slice(0, TRAINER_MAX) : null
  const footprints = typeof message?.footprints === 'string' ? message.footprints.slice(0, FOOTPRINTS_MAX) : null
  const aura = typeof message?.aura === 'string' ? message.aura.slice(0, AURA_MAX) : null
  const level = Number.isInteger(message?.level) && message.level >= 1 ? Math.min(message.level, LEVEL_MAX) : 1
  let avatar = null
  if (message?.avatar && typeof message.avatar === 'object') {
    const size = JSON.stringify(message.avatar).length
    if (size <= MAX_AVATAR_BYTES) avatar = message.avatar
  }
  return { name: name || 'Player', avatar, glove, pet, trainer, footprints, aura, level }
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
    glove: player.glove,
    pet: player.pet,
    trainer: player.trainer,
    footprints: player.footprints,
    aura: player.aura,
    level: player.level,
    p: player.p,
    sw: player.sw,
  }
}

/** A ring index from a message, or -1. */
const readRing = (value) => (Number.isInteger(value) && value >= 0 && value < rings.RINGS.length ? value : -1)
/** A pad (0 red, 1 blue) from a message, or -1. */
const readSlot = (value) => (value === 0 || value === 1 ? value : -1)

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
            glove: player.glove,
            pet: player.pet,
            trainer: player.trainer,
            footprints: player.footprints,
            aura: player.aura,
            level: player.level,
          },
          player,
        )
      }
    })

    this.onMessage('padEnter', (client, message) => {
      const player = this.playerFor(client)
      const r = readRing(message?.r)
      const slot = readSlot(message?.slot)
      if (!player || r < 0 || slot < 0 || overRate(player)) return
      const lobby = this.lobbies.lobbyOf(player.id)
      const result = rings.padEnter(this.ringsOf(lobby), r, slot, player, message?.power, Date.now(), lobby.players)
      if (!result.ok) {
        client.send('ringDeny', { r, slot, reason: result.reason })
        return
      }
      this.tellRingEvents(lobby, result.events)
      this.tellRings(lobby)
    })

    this.onMessage('padLeave', (client, message) => {
      const player = this.playerFor(client)
      const r = readRing(message?.r)
      const slot = readSlot(message?.slot)
      if (!player || r < 0 || slot < 0 || overRate(player)) return
      const lobby = this.lobbies.lobbyOf(player.id)
      if (rings.padLeave(this.ringsOf(lobby), r, slot, player.id)) this.tellRings(lobby)
    })

    this.onMessage('ringPunch', (client, message) => {
      const player = this.playerFor(client)
      const r = readRing(message?.r)
      if (!player || r < 0 || overRate(player)) return
      const lobby = this.lobbies.lobbyOf(player.id)
      const events = rings.punch(this.ringsOf(lobby), r, player.id, message?.power, lobby.players, Date.now())
      this.tellRingEvents(lobby, events)
      if (events.some((event) => event.type === 'ko')) this.tellRings(lobby)
    })
  }

  /** Joining the room carries the profile (name/avatar/gloves/pet...) as its options. */
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
      rings: rings.snapshot(this.ringsOf(lobby), Date.now()),
    })
    this.tellLobby(lobby, 'join', { player: publicPlayer(player) }, player)
    console.log(
      `[lobby] ${player.name} (${player.id}) joined ${lobby.name} - ${lobby.players.size}/${this.lobbies.maxPlayers}`,
    )
  }

  onLeave(client) {
    const player = this.playerFor(client)
    if (!player) return
    // Off any pad and out of any ring first: leaving a fight by closing the tab is a
    // forfeit.
    const current = this.lobbies.lobbyOf(player.id)
    if (current?.rings) {
      const all = current.rings
      const onPad = rings.padOf(all, player.id)[0] >= 0
      const inRing = rings.ringOf(all, player.id)[0] >= 0
      if (onPad || inRing) {
        this.tellRingEvents(current, rings.leave(all, player.id, Date.now()), player)
        this.tellRings(current, player)
      }
    }
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

  /** The lobby's four rings, made the first time anyone asks. */
  ringsOf(lobby) {
    lobby.rings ??= rings.createRings()
    return lobby.rings
  }

  /** Everyone in `lobby` gets the state of its rings. */
  tellRings(lobby, except = null) {
    this.tellLobby(lobby, 'rings', { rings: rings.snapshot(this.ringsOf(lobby), Date.now()) }, except)
  }

  /** Passes ring events on: starts, hits and knockouts to the lobby, misses to the puncher. */
  tellRingEvents(lobby, events, except = null) {
    for (const event of events) {
      if (event.type === 'start') {
        this.tellLobby(lobby, 'ringStart', { r: event.ring, f: event.fighters, mh: event.maxHp }, except)
      } else if (event.type === 'cancel') {
        this.tellLobby(lobby, 'ringCancel', { r: event.ring, f: event.fighters }, except)
      } else if (event.type === 'hit') {
        this.tellLobby(lobby, 'ringHit', { r: event.ring, from: event.from, to: event.to, d: event.damage, hp: event.hp })
      } else if (event.type === 'ko') {
        const { ring, winner, loser, reward, reason, draw, fighters } = event
        this.tellLobby(lobby, 'ringKO', { r: ring, winner, loser, reward, reason, draw, f: fighters }, except)
        console.log(`[ring] ${lobby.name} ring ${ring + 1}: ${draw ? 'draw' : `${winner} beat ${loser}`} (${reason})`)
      } else if (event.type === 'miss') {
        lobby.players.get(event.from)?.client.send('ringMiss', { r: event.ring })
      }
    }
  }

  /** Sends to everyone in `lobby` (except `except`). */
  tellLobby(lobby, type, message, except = null) {
    for (const player of lobby.players.values()) {
      if (player !== except) player.client.send(type, message)
    }
  }

  /** Everyone who moved since the last tick, one message per lobby - and the rings' clocks. */
  broadcastMoved() {
    const now = Date.now()
    for (const lobby of this.lobbies.lobbies.values()) {
      if (lobby.rings) {
        const { changed, events } = rings.tick(lobby.rings, now, lobby.players)
        if (events.length) this.tellRingEvents(lobby, events)
        if (changed) this.tellRings(lobby)
      }
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
