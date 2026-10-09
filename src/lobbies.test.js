const assert = require('node:assert/strict')
const test = require('node:test')

const { LobbyManager } = require('./lobbies')

const players = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `p${from + i}` }))

test('fills a lobby up to 8 before opening another', () => {
  const manager = new LobbyManager()
  const joined = players(1, 10).map((p) => manager.join(p))
  assert.equal(new Set(joined.slice(0, 8).map((l) => l.id)).size, 1)
  assert.notEqual(joined[8].id, joined[0].id)
  assert.equal(joined[9].id, joined[8].id)
  assert.deepEqual(
    manager.list().map((l) => l.players),
    [8, 2],
  )
})

test('nobody waits: the first player gets a lobby straight away', () => {
  const manager = new LobbyManager()
  const lobby = manager.join({ id: 'solo' })
  assert.equal(lobby.players.size, 1)
  assert.equal(lobby.name, 'Lobby 1')
})

test('a gap left in a full lobby is filled before a newer, emptier lobby', () => {
  const manager = new LobbyManager()
  const [first] = players(1, 10).map((p) => manager.join(p))
  manager.leave('p3')
  assert.equal(manager.join({ id: 'p11' }).id, first.id)
})

test('prefers the fullest lobby with room', () => {
  const manager = new LobbyManager()
  players(1, 17).forEach((p) => manager.join(p)) // 8, 8, 1
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) manager.leave(id) // 2, 8, 1
  const lobby = manager.join({ id: 'p18' })
  assert.equal(lobby.name, 'Lobby 1')
  assert.equal(lobby.players.size, 3)
})

test('closes empty lobbies and reuses the lowest free lobby number', () => {
  const manager = new LobbyManager()
  players(1, 9).forEach((p) => manager.join(p)) // Lobby 1: p1-p8, Lobby 2: p9
  for (const p of players(1, 8)) manager.leave(p.id)
  assert.deepEqual(
    manager.list().map((l) => l.name),
    ['Lobby 2'],
  )
  players(10, 17).forEach((p) => manager.join(p)) // fills Lobby 2 to 8 (+1 into a new one)
  assert.deepEqual(
    manager.list().map((l) => `${l.name}:${l.players}`),
    ['Lobby 2:8', 'Lobby 1:1'],
  )
})

test('leaving twice or joining twice is handled', () => {
  const manager = new LobbyManager()
  manager.join({ id: 'a' })
  assert.throws(() => manager.join({ id: 'a' }))
  assert.ok(manager.leave('a'))
  assert.equal(manager.leave('a'), null)
})
