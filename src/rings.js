/**
 * The boxing rings: four in every lobby, two fighters in each.
 *
 * The fight itself lives here, on the server, so that both fighters and everyone
 * watching see the same thing: who is waiting on which pad, who is in which ring,
 * both health bars, every punch that lands and who goes down. The clients only ask -
 * to stand on a pad, to step off it, to throw a punch - and are told what happened.
 *
 * Nobody walks into a ring: its ropes are solid all the time. Beside each ring are
 * two pads, the red corner's and the blue corner's. When both have someone standing
 * on them, those two are taken into the ring (their clients put them in their
 * corners) and the fight starts:
 *
 *   open       nobody fighting. The pads fill up; two on them starts a fight.
 *   countdown  COUNTDOWN_MS of "3, 2, 1".
 *   fight      punches land. Each one does more damage the stronger its thrower is
 *              next to the other (see damageFor), and only within reach. A fight
 *              that runs ROUND_MS goes to whoever has more health left (a draw if
 *              neither does).
 *   ko         someone went down. KO_MS later both fighters are out: the loser
 *              back to the lobby, the winner beside the ring with the Wins - and if
 *              the pads have filled up in the meantime, the next fight starts.
 *
 * Dropping off the server mid-fight is a forfeit.
 *
 * Positions and the ring layout are the client's (src/game/rings.js); keep RINGS and
 * PAD_OFFSET / PAD_FRONT below in step with it. They are used to check that a player asking for
 * a pad is standing on it, and that a punch is thrown from within reach - generously,
 * since positions arrive twenty times a second.
 */

const RINGS = [
  { id: 0, x: -24, z: 76 },
  { id: 1, x: -8, z: 76 },
  { id: 2, x: 8, z: 76 },
  { id: 3, x: 24, z: 76 },
]
/** How far either side of a ring's middle its two pads are (red to the west)... */
const PAD_OFFSET = 2.7
/** ...and how far in front of it (south). */
const PAD_FRONT = 8
/** How far from a pad's middle its player may be, a tick out of date. */
const PAD_RADIUS = 2.2

const MAX_HP = 100
const COUNTDOWN_MS = 3000
const ROUND_MS = 60000
const KO_MS = 2600
/** Fastest a fighter's punches count: about seven a second. */
const MIN_PUNCH_GAP_MS = 140
/** Damage of one punch between two equally strong fighters. */
const BASE_DAMAGE = 6
/** Horizontal distance between the two fighters' centres within which a punch lands. */
const REACH = 4
/** Largest power a client may claim; anything past this is treated as this. */
const MAX_POWER = Number.MAX_SAFE_INTEGER * 1e6

const cleanPower = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_POWER) : 1

/** Where ring `index`'s pad `slot` is: [x, z]. */
const padAt = (index, slot) => {
  const ring = RINGS[index]
  return [ring.x + (slot === 0 ? -PAD_OFFSET : PAD_OFFSET), ring.z - PAD_FRONT]
}

/** A ring with nobody in it or waiting. */
function freshRing() {
  return {
    pads: [null, null],
    fighters: [null, null],
    hp: [MAX_HP, MAX_HP],
    power: [1, 1],
    lastPunch: [0, 0],
    state: 'open',
    until: 0,
    ko: null,
  }
}

/** The four rings for a new lobby. */
const createRings = () => RINGS.map(() => freshRing())

/**
 * What one punch does: twice the base damage, split by how strong each fighter is.
 * Equal fighters do BASE_DAMAGE each; one ten times stronger does nearly twice that
 * while the other does a tenth of it - so the stronger fist wins, but a fight is
 * still a fight and not one click.
 */
function damageFor(attackerPower, defenderPower) {
  const a = cleanPower(attackerPower)
  const d = cleanPower(defenderPower)
  const share = a / (a + d)
  return Math.max(0.05, Math.round(BASE_DAMAGE * 2 * share * 100) / 100)
}

/**
 * Wins for beating someone, before the winner's own Wins multipliers (the client
 * applies those). Grows with the loser's Strength, slowly, so a fight is worth
 * having at every stage of the game without ever beating a stage's Win pad.
 */
function rewardFor(loserPower) {
  return Math.max(5, Math.round(Math.sqrt(cleanPower(loserPower)) * 1.5))
}

const slotOf = (ring, id) => ring.fighters.indexOf(id)
const fighting = (ring) => ring.state !== 'open'

/** The ring, if any, the player is fighting in, as `[index, ring]`. */
function ringOf(rings, id) {
  for (let i = 0; i < rings.length; i++) if (rings[i].fighters.includes(id)) return [i, rings[i]]
  return [-1, null]
}

/** The pad, if any, the player is standing on, as `[ringIndex, slot]`. */
function padOf(rings, id) {
  for (let i = 0; i < rings.length; i++) {
    const slot = rings[i].pads.indexOf(id)
    if (slot >= 0) return [i, slot]
  }
  return [-1, -1]
}

/** Whether `p` ([x, y, z]) is on ring `index`'s pad `slot`, give or take PAD_RADIUS. */
function standingOn(index, slot, p) {
  if (!RINGS[index] || !Array.isArray(p)) return false
  const [x, z] = padAt(index, slot)
  return Math.hypot(p[0] - x, p[2] - z) <= PAD_RADIUS
}

/**
 * Two on the pads and nobody fighting: they go in. Returns the start event, or null.
 */
function tryStart(rings, index, now) {
  const ring = rings[index]
  if (fighting(ring) || ring.pads[0] === null || ring.pads[1] === null) return null
  ring.fighters = [...ring.pads]
  ring.pads = [null, null]
  ring.hp = [MAX_HP, MAX_HP]
  ring.lastPunch = [0, 0]
  ring.state = 'countdown'
  ring.until = now + COUNTDOWN_MS
  ring.ko = null
  return { type: 'start', ring: index, fighters: [...ring.fighters] }
}

/**
 * A player steps onto ring `index`'s pad `slot` (0 red, 1 blue).
 * @returns {{ ok: boolean, reason?: string, events: object[] }}
 */
function padEnter(rings, index, slot, player, power, now) {
  const ring = rings[index]
  if (!ring || (slot !== 0 && slot !== 1)) return { ok: false, reason: 'no such pad', events: [] }
  if (ringOf(rings, player.id)[0] >= 0) return { ok: false, reason: 'fighting', events: [] }
  if (ring.pads[slot] === player.id) return { ok: true, events: [] }
  if (ring.pads[slot] !== null) return { ok: false, reason: 'taken', events: [] }
  if (!standingOn(index, slot, player.p)) return { ok: false, reason: 'not here', events: [] }
  // Off whichever pad they were on before.
  const [oldRing, oldSlot] = padOf(rings, player.id)
  if (oldRing >= 0) rings[oldRing].pads[oldSlot] = null
  ring.pads[slot] = player.id
  ring.power[slot] = cleanPower(power)
  const start = tryStart(rings, index, now)
  return { ok: true, events: start ? [start] : [] }
}

/** A player steps off ring `index`'s pad `slot`. Returns whether anything changed. */
function padLeave(rings, index, slot, id) {
  const ring = rings[index]
  if (!ring || ring.pads[slot] !== id) return false
  ring.pads[slot] = null
  return true
}

/** Starts the end of a fight: `loserSlot` is down (or -1 for a draw). */
function finish(rings, index, loserSlot, now, reason) {
  const ring = rings[index]
  ring.state = 'ko'
  ring.until = now + KO_MS
  if (loserSlot < 0) {
    ring.ko = { winner: null, loser: null, reward: 0, reason }
    return { type: 'ko', ring: index, winner: null, loser: null, draw: true, fighters: [...ring.fighters], reward: 0, reason }
  }
  const winnerSlot = 1 - loserSlot
  ring.hp[loserSlot] = 0
  ring.ko = {
    winner: ring.fighters[winnerSlot],
    loser: ring.fighters[loserSlot],
    reward: rewardFor(ring.power[loserSlot]),
    reason,
  }
  return { type: 'ko', ring: index, ...ring.ko, draw: false, fighters: [...ring.fighters] }
}

/**
 * A player drops off the server: off any pad, and out of any fight - a forfeit if it
 * had started, a cancelled fight if it was still counting down.
 * @returns {object[]} events for the lobby
 */
function leave(rings, id, now) {
  const [padRing, padSlot] = padOf(rings, id)
  if (padRing >= 0) rings[padRing].pads[padSlot] = null
  const [index, ring] = ringOf(rings, id)
  if (index < 0) return []
  const slot = slotOf(ring, id)
  if (ring.state === 'fight') return [finish(rings, index, slot, now, 'forfeit')]
  if (ring.state === 'countdown') {
    const other = ring.fighters[1 - slot]
    ring.fighters = [null, null]
    ring.state = 'open'
    ring.until = 0
    return [{ type: 'cancel', ring: index, fighters: [other] }]
  }
  if (ring.state === 'ko') ring.fighters[slot] = null
  return []
}

/**
 * A punch from `attacker` in ring `index`. `players` maps ids to records with a `p`
 * position. Returns the events it caused: nothing (not fighting, too soon), a miss
 * (out of reach), a hit, or a hit and a knockout.
 */
function punch(rings, index, attacker, power, players, now) {
  const ring = rings[index]
  if (!ring || ring.state !== 'fight') return []
  const slot = slotOf(ring, attacker)
  if (slot < 0) return []
  if (now - ring.lastPunch[slot] < MIN_PUNCH_GAP_MS) return []
  ring.lastPunch[slot] = now
  ring.power[slot] = cleanPower(power)

  const other = 1 - slot
  const a = players.get(attacker)?.p
  const b = players.get(ring.fighters[other])?.p
  if (!a || !b || Math.hypot(a[0] - b[0], a[2] - b[2]) > REACH) return [{ type: 'miss', ring: index, from: attacker }]

  const damage = damageFor(ring.power[slot], ring.power[other])
  ring.hp[other] = Math.max(0, Math.round((ring.hp[other] - damage) * 100) / 100)
  const events = [{ type: 'hit', ring: index, from: attacker, to: ring.fighters[other], damage, hp: [...ring.hp] }]
  if (ring.hp[other] <= 0) events.push(finish(rings, index, other, now, 'ko'))
  return events
}

/**
 * Moves every ring's clock on: countdowns into fights, fights that ran out of time
 * to a decision, finished knockouts back to open - and then, if two are waiting on
 * the pads, straight into the next fight. Returns `{ changed, events }`.
 */
function tick(rings, now) {
  let changed = false
  const events = []
  rings.forEach((ring, index) => {
    if (ring.state === 'countdown' && now >= ring.until) {
      ring.state = 'fight'
      ring.until = now + ROUND_MS
      changed = true
    } else if (ring.state === 'fight' && now >= ring.until) {
      const [a, b] = ring.hp
      events.push(finish(rings, index, a === b ? -1 : a < b ? 0 : 1, now, 'decision'))
      changed = true
    } else if (ring.state === 'ko' && now >= ring.until) {
      ring.fighters = [null, null]
      ring.hp = [MAX_HP, MAX_HP]
      ring.state = 'open'
      ring.until = 0
      ring.ko = null
      changed = true
    }
    const start = tryStart(rings, index, now)
    if (start) {
      events.push(start)
      changed = true
    }
  })
  return { changed, events }
}

/** What everyone is told about the rings: compact, and with no clocks but "how long". */
function snapshot(rings, now) {
  return rings.map((ring) => ({
    f: [...ring.fighters],
    p: [...ring.pads],
    hp: [...ring.hp],
    s: ring.state,
    t: ring.until ? Math.max(0, ring.until - now) : 0,
  }))
}

module.exports = {
  RINGS,
  PAD_OFFSET,
  MAX_HP,
  COUNTDOWN_MS,
  ROUND_MS,
  KO_MS,
  BASE_DAMAGE,
  REACH,
  createRings,
  damageFor,
  rewardFor,
  ringOf,
  padOf,
  padAt,
  padEnter,
  padLeave,
  leave,
  punch,
  tick,
  snapshot,
}
