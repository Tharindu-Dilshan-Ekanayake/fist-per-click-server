const test = require('node:test')
const assert = require('node:assert/strict')

const rings = require('./rings')

/** A player standing on ring `r`'s pad `slot`. */
const onPad = (id, r = 1, slot = 0) => {
  const [x, z] = rings.padAt(r, slot)
  return { id, p: [x, 1, z] }
}
/** Where a fighter stands in ring 1 once the fight is on. */
const inRing = (player, dx) => {
  player.p = [rings.RINGS[1].x + dx, 2, rings.RINGS[1].z]
  return player
}

/** Two players onto ring 1's pads, through the countdown and into the fight. */
function fightingPair(powerA = 100, powerB = 100) {
  const all = rings.createRings()
  const a = onPad('a', 1, 0)
  const b = onPad('b', 1, 1)
  assert.equal(rings.padEnter(all, 1, 0, a, powerA, 0).ok, true)
  const started = rings.padEnter(all, 1, 1, b, powerB, 0)
  assert.equal(started.ok, true)
  assert.deepEqual(started.events[0], { type: 'start', ring: 1, fighters: ['a', 'b'] })
  assert.equal(all[1].state, 'countdown')
  assert.deepEqual(all[1].pads, [null, null])
  rings.tick(all, rings.COUNTDOWN_MS)
  assert.equal(all[1].state, 'fight')
  inRing(a, -1.3)
  inRing(b, 1.3)
  return { all, players: new Map([['a', a], ['b', b]]) }
}

test('one on a pad waits; the second starts the fight; a taken pad is refused', () => {
  const all = rings.createRings()
  assert.equal(rings.padEnter(all, 1, 0, onPad('a', 1, 0), 10, 0).ok, true)
  assert.equal(all[1].state, 'open')
  const taken = rings.padEnter(all, 1, 0, onPad('c', 1, 0), 10, 0)
  assert.equal(taken.ok, false)
  assert.equal(taken.reason, 'taken')
  assert.equal(rings.padEnter(all, 1, 1, onPad('b', 1, 1), 10, 0).ok, true)
  assert.equal(all[1].state, 'countdown')
  assert.deepEqual(all[1].fighters, ['a', 'b'])
})

test('you have to be standing on the pad to take it', () => {
  const all = rings.createRings()
  const result = rings.padEnter(all, 1, 0, { id: 'far', p: [0, 1, 0] }, 10, 0)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not here')
})

test('the next two wait on the pads while a fight is on, and go in when it ends', () => {
  const { all, players } = fightingPair(1000, 1)
  assert.equal(rings.padEnter(all, 1, 0, onPad('c', 1, 0), 10, 5000).ok, true)
  assert.equal(rings.padEnter(all, 1, 1, onPad('d', 1, 1), 10, 5000).ok, true)
  assert.equal(all[1].state, 'fight')
  let now = rings.COUNTDOWN_MS
  for (let i = 0; i < 40 && all[1].state === 'fight'; i++) {
    now += 200
    rings.punch(all, 1, 'a', 1000, players, now)
  }
  assert.equal(all[1].state, 'ko')
  const { events } = rings.tick(all, now + rings.KO_MS)
  assert.deepEqual(events.map((e) => e.type), ['start'])
  assert.deepEqual(all[1].fighters, ['c', 'd'])
})

test('the stronger fist does more damage, equal fists the base', () => {
  assert.equal(rings.damageFor(50, 50), rings.BASE_DAMAGE)
  assert.ok(rings.damageFor(1000, 10) > rings.damageFor(10, 1000) * 50)
  assert.ok(rings.damageFor(1e12, 1) <= rings.BASE_DAMAGE * 2)
})

test('punches land within reach, and enough of them knock out', () => {
  const { all, players } = fightingPair(1000, 10)
  let now = rings.COUNTDOWN_MS
  let ko = null
  for (let i = 0; i < 40 && !ko; i++) {
    now += 200
    const events = rings.punch(all, 1, 'a', 1000, players, now)
    assert.equal(events[0].type, 'hit')
    ko = events.find((event) => event.type === 'ko')
  }
  assert.ok(ko, 'b should be down')
  assert.equal(ko.winner, 'a')
  assert.equal(ko.loser, 'b')
  assert.equal(ko.reason, 'ko')
  assert.ok(ko.reward >= 5)
  // The knockout plays out, then both are out and the ring is open again.
  rings.tick(all, now + rings.KO_MS)
  assert.equal(all[1].state, 'open')
  assert.deepEqual(all[1].fighters, [null, null])
})

test('punches too fast or out of reach do nothing', () => {
  const { all, players } = fightingPair()
  const now = rings.COUNTDOWN_MS + 1000
  assert.equal(rings.punch(all, 1, 'a', 100, players, now)[0].type, 'hit')
  assert.deepEqual(rings.punch(all, 1, 'a', 100, players, now + 10), [])
  inRing(players.get('b'), rings.REACH + 2)
  assert.equal(rings.punch(all, 1, 'a', 100, players, now + 500)[0].type, 'miss')
})

test('a fight that runs out of time goes to whoever has more health', () => {
  const { all, players } = fightingPair()
  rings.punch(all, 1, 'b', 100, players, rings.COUNTDOWN_MS + 100)
  const { events } = rings.tick(all, rings.COUNTDOWN_MS + rings.ROUND_MS + 1)
  assert.equal(events[0].type, 'ko')
  assert.equal(events[0].reason, 'decision')
  assert.equal(events[0].winner, 'b')
})

test('dropping out of a fight is a forfeit; out of a countdown it is not', () => {
  const { all } = fightingPair()
  const events = rings.leave(all, 'b', 5000)
  assert.equal(events[0].type, 'ko')
  assert.equal(events[0].winner, 'a')
  assert.equal(events[0].reason, 'forfeit')

  const calm = rings.createRings()
  rings.padEnter(calm, 1, 0, onPad('a', 1, 0), 10, 0)
  rings.padEnter(calm, 1, 1, onPad('b', 1, 1), 10, 0)
  const cancel = rings.leave(calm, 'b', 100)
  assert.equal(cancel[0].type, 'cancel')
  assert.equal(calm[1].state, 'open')
  assert.deepEqual(calm[1].fighters, [null, null])
})

test('the snapshot says who is where and how long is left', () => {
  const all = rings.createRings()
  rings.padEnter(all, 1, 0, onPad('a', 1, 0), 10, 0)
  let snap = rings.snapshot(all, 0)
  assert.deepEqual(snap[1].p, ['a', null])
  rings.padEnter(all, 1, 1, onPad('b', 1, 1), 10, 0)
  snap = rings.snapshot(all, 1000)
  assert.equal(snap.length, rings.RINGS.length)
  assert.deepEqual(snap[1].f, ['a', 'b'])
  assert.equal(snap[1].s, 'countdown')
  assert.equal(snap[1].t, rings.COUNTDOWN_MS - 1000)
})
