/**
 * The boxing rings: four in every lobby, two fighters in each.
 *
 * The fight itself lives here, on the server, so that both fighters and everyone
 * watching see the same thing: who is in which ring, both health bars, every punch
 * that lands and who goes down. The clients only ask - to step in, to step out, to
 * throw a punch - and are told what happened.
 *
 * A ring goes:
 *
 *   open       nobody, or one fighter waiting for a challenger. Anyone may step in.
 *   countdown  a second fighter stepped in: COUNTDOWN_MS of "3, 2, 1" and the ropes
 *              go solid, so nobody else gets in and neither fighter gets out.
 *   fight      punches land. Each one does more damage the stronger its thrower is
 *              next to the other (see damageFor), and only within reach.
 *   ko         someone hit zero. KO_MS later the loser is out (their client sends
 *              them back to the lobby) and the winner stays on, at full health,
 *              waiting for the next challenger.
 *
 * Stepping out during a fight - or dropping off the server - is a forfeit.
 *
 * Positions and the ring layout are the client's (src/game/rings.js); keep RINGS
 * below in step with it. They are only used to check that a player asking to step
 * in is actually standing on that canvas, and that a punch is thrown from within
 * reach - generously, since positions arrive twenty times a second.
 */

const RING_HALF = 4.4
const RINGS = [
  { id: 0, x: -22.5, z: 76 },
  { id: 1, x: -7.5, z: 76 },
  { id: 2, x: 7.5, z: 76 },
  { id: 3, x: 22.5, z: 76 },
]

const MAX_HP = 100
const COUNTDOWN_MS = 3000
const KO_MS = 2600
/** Fastest a fighter's punches count: about seven a second. */
const MIN_PUNCH_GAP_MS = 140
/** Damage of one punch between two equally strong fighters. */
const BASE_DAMAGE = 6
/** Horizontal distance between the two fighters' centres within which a punch lands. */
const REACH = 3.4
/** Slack on the "standing on the canvas" check, for a position a tick out of date. */
const ENTER_MARGIN = 2
/** Largest power a client may claim; anything past this is treated as this. */
const MAX_POWER = Number.MAX_SAFE_INTEGER * 1e6

const cleanPower = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_POWER) : 1

/** A ring with nobody in it. */
function freshRing() {
  return {
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
const full = (ring) => ring.fighters[0] !== null && ring.fighters[1] !== null

/** The ring, if any, the player is fighting in, as `[index, ring]`. */
function ringOf(rings, id) {
  for (let i = 0; i < rings.length; i++) if (rings[i].fighters.includes(id)) return [i, rings[i]]
  return [-1, null]
}

/** Whether `p` ([x, y, z]) is on ring `index`'s canvas, give or take ENTER_MARGIN. */
function standingIn(index, p) {
  const at = RINGS[index]
  if (!at || !Array.isArray(p)) return false
  return Math.abs(p[0] - at.x) <= RING_HALF + ENTER_MARGIN && Math.abs(p[2] - at.z) <= RING_HALF + ENTER_MARGIN
}

/**
 * Starts a knockout: `loserSlot` is down. Returns the event for everyone.
 * `forfeit` is set when they walked out or dropped rather than were punched out.
 */
function knockOut(rings, index, loserSlot, now, forfeit = false) {
  const ring = rings[index]
  const winnerSlot = 1 - loserSlot
  ring.hp[loserSlot] = 0
  ring.state = 'ko'
  ring.until = now + KO_MS
  ring.ko = {
    winner: ring.fighters[winnerSlot],
    loser: ring.fighters[loserSlot],
    reward: rewardFor(ring.power[loserSlot]),
    forfeit,
  }
  return { type: 'ko', ring: index, ...ring.ko }
}

/**
 * A player asks to step into ring `index`.
 * @returns {{ ok: boolean, reason?: string, events: object[] }}
 *   `events` is what to tell the lobby (a knockout, if stepping in here meant
 *   forfeiting a fight somewhere else).
 */
function enter(rings, index, player, power, now) {
  const ring = rings[index]
  if (!ring) return { ok: false, reason: 'no such ring', events: [] }
  if (ring.fighters.includes(player.id)) return { ok: true, events: [] }
  if (full(ring) || ring.state !== 'open') return { ok: false, reason: 'full', events: [] }
  if (!standingIn(index, player.p)) return { ok: false, reason: 'not here', events: [] }

  // In another ring already (the client lost track): that one is left first.
  const events = []
  const [other] = ringOf(rings, player.id)
  if (other >= 0) events.push(...leave(rings, other, player.id, now))

  const slot = ring.fighters[0] === null ? 0 : 1
  ring.fighters[slot] = player.id
  ring.hp[slot] = MAX_HP
  ring.power[slot] = cleanPower(power)
  ring.lastPunch[slot] = 0
  if (full(ring)) {
    ring.state = 'countdown'
    ring.until = now + COUNTDOWN_MS
    ring.hp = [MAX_HP, MAX_HP]
  }
  return { ok: true, events }
}

/**
 * A player steps out of ring `index`, or drops off the server. During a fight (or
 * its countdown) that is a forfeit; otherwise they are simply gone.
 * @returns {object[]} events for the lobby
 */
function leave(rings, index, id, now) {
  const ring = rings[index]
  if (!ring) return []
  const slot = slotOf(ring, id)
  if (slot < 0) return []
  if (ring.state === 'fight') return [knockOut(rings, index, slot, now, true)]
  if (ring.state === 'ko') {
    // The loser leaving is expected (they are on their way to the lobby). The winner
    // leaving early just ends the celebration.
    ring.fighters[slot] = null
    if (ring.ko?.winner === id) finishKo(ring)
    return []
  }
  ring.fighters[slot] = null
  ring.hp[slot] = MAX_HP
  if (ring.state === 'countdown') {
    // Nobody had thrown a punch yet: no winner, the other fighter just waits again.
    ring.state = 'open'
    ring.until = 0
  }
  return []
}

/** Clears a finished knockout: the loser is out, the winner (if still here) waits on. */
function finishKo(ring) {
  const loser = ring.ko?.loser
  if (loser) {
    const slot = slotOf(ring, loser)
    if (slot >= 0) ring.fighters[slot] = null
  }
  ring.hp = [MAX_HP, MAX_HP]
  ring.state = 'open'
  ring.until = 0
  ring.ko = null
}

/**
 * A punch from `attacker` in ring `index`. `players` maps ids to records with a `p`
 * position. Returns the events it caused: nothing (not fighting, too soon, out of
 * reach), a hit, or a hit and a knockout.
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
  if (ring.hp[other] <= 0) events.push(knockOut(rings, index, other, now))
  return events
}

/**
 * Moves every ring's clock on: countdowns into fights, finished knockouts back to
 * open. Returns whether anything changed (so the lobby is sent a fresh snapshot).
 */
function tick(rings, now) {
  let changed = false
  for (const ring of rings) {
    if (ring.state === 'countdown' && now >= ring.until) {
      ring.state = 'fight'
      ring.until = 0
      changed = true
    } else if (ring.state === 'ko' && now >= ring.until) {
      finishKo(ring)
      changed = true
    }
  }
  return changed
}

/** What everyone is told about the rings: compact, and with no clocks but "how long". */
function snapshot(rings, now) {
  return rings.map((ring) => ({
    f: [...ring.fighters],
    hp: [...ring.hp],
    s: ring.state,
    t: ring.until ? Math.max(0, ring.until - now) : 0,
  }))
}

module.exports = {
  RINGS,
  MAX_HP,
  COUNTDOWN_MS,
  KO_MS,
  BASE_DAMAGE,
  REACH,
  createRings,
  damageFor,
  rewardFor,
  ringOf,
  enter,
  leave,
  punch,
  tick,
  snapshot,
}
