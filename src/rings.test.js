const test = require('node:test')
const assert = require('node:assert/strict')

const rings = require('./rings')

const RING = rings.RINGS[1]
/** A player standing on ring 1's canvas, `dx` from its middle. */
const fighter = (id, dx = 0) => ({ id, p: [RING.x + dx, 2, RING.z] })

/** Two fighters in ring 1, through the countdown and into the fight. */
function fightingPair(powerA = 100, powerB = 100) {
  const all = rings.createRings()
  const a = fighter('a', -1)
  const b = fighter('b', 1)
  assert.equal(rings.enter(all, 1, a, powerA, 0).ok, true)
  assert.equal(rings.enter(all, 1, b, powerB, 0).ok, true)
  assert.equal(all[1].state, 'countdown')
  rings.tick(all, rings.COUNTDOWN_MS)
  assert.equal(all[1].state, 'fight')
  return { all, players: new Map([['a', a], ['b', b]]) }
}

test('one fighter waits; a second starts the countdown; a third is turned away', () => {
  const all = rings.createRings()
  assert.equal(rings.enter(all, 1, fighter('a'), 10, 0).ok, true)
  assert.equal(all[1].state, 'open')
  assert.equal(rings.enter(all, 1, fighter('b'), 10, 0).ok, true)
  assert.equal(all[1].state, 'countdown')
  const third = rings.enter(all, 1, fighter('c'), 10, 0)
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'full')
})

test('you have to be standing in the ring to step into it', () => {
  const all = rings.createRings()
  const result = rings.enter(all, 1, { id: 'far', p: [0, 2, 0] }, 10, 0)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not here')
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
  assert.ok(ko.reward >= 5)
  assert.equal(all[1].state, 'ko')
  // The knockout plays out, then the winner waits on at full health.
  rings.tick(all, now + rings.KO_MS)
  assert.equal(all[1].state, 'open')
  assert.deepEqual(all[1].fighters, ['a', null])
  assert.deepEqual(all[1].hp, [rings.MAX_HP, rings.MAX_HP])
})

test('punches too fast or out of reach do nothing', () => {
  const { all, players } = fightingPair()
  const now = rings.COUNTDOWN_MS + 1000
  assert.equal(rings.punch(all, 1, 'a', 100, players, now)[0].type, 'hit')
  assert.deepEqual(rings.punch(all, 1, 'a', 100, players, now + 10), [])
  players.get('b').p = [RING.x + rings.REACH + 2, 2, RING.z]
  assert.equal(rings.punch(all, 1, 'a', 100, players, now + 500)[0].type, 'miss')
})

test('nobody punches during the countdown', () => {
  const all = rings.createRings()
  const players = new Map([['a', fighter('a')], ['b', fighter('b')]])
  rings.enter(all, 1, players.get('a'), 10, 0)
  rings.enter(all, 1, players.get('b'), 10, 0)
  assert.deepEqual(rings.punch(all, 1, 'a', 10, players, 1000), [])
})

test('walking out of a fight is a forfeit; out of a countdown it is not', () => {
  const { all } = fightingPair()
  const events = rings.leave(all, 1, 'b', 5000)
  assert.equal(events[0].type, 'ko')
  assert.equal(events[0].winner, 'a')
  assert.equal(events[0].forfeit, true)

  const calm = rings.createRings()
  rings.enter(calm, 1, fighter('a'), 10, 0)
  rings.enter(calm, 1, fighter('b'), 10, 0)
  assert.deepEqual(rings.leave(calm, 1, 'b', 100), [])
  assert.equal(calm[1].state, 'open')
  assert.deepEqual(calm[1].fighters, ['a', null])
})

test('the snapshot says who is where and how long is left', () => {
  const all = rings.createRings()
  rings.enter(all, 1, fighter('a'), 10, 0)
  rings.enter(all, 1, fighter('b'), 10, 0)
  const snap = rings.snapshot(all, 1000)
  assert.equal(snap.length, rings.RINGS.length)
  assert.deepEqual(snap[1].f, ['a', 'b'])
  assert.equal(snap[1].s, 'countdown')
  assert.equal(snap[1].t, rings.COUNTDOWN_MS - 1000)
  assert.deepEqual(snap[0].f, [null, null])
})
