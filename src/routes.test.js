const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')

const express = require('express')

/**
 * The HTTP API end to end: a real Express app with the real routes, the in-memory
 * store, and a stand-in for Bloxity's auth API on another port - so the token check
 * runs exactly as in production, just against a server we control.
 */

const USER = { _id: 'user-1', username: 'tester' }
const TOKEN = 'good-token-abcdef'

let fakeBloxity
let gameServer
let base

before(async () => {
  const fake = express()
  fake.use(express.json())
  const answer = (req, res) => {
    if (req.get('authorization') === `Bearer ${TOKEN}`) res.json({ user: USER })
    else res.status(401).json({ error: 'nope' })
  }
  fake.post('/v1/auth/game-token/verify', answer)
  fake.get('/v1/auth/me', answer)
  fakeBloxity = await listen(fake)

  // Read once, at require time - so set before the routes are loaded.
  process.env.BLOXITY_API_URL = `http://127.0.0.1:${fakeBloxity.address().port}`
  process.env.BLOXITY_GAME_SLUG = 'ammo-per-click'
  const { mountRoutes } = require('./routes')
  const { memoryStore } = require('./store')

  const app = express()
  mountRoutes(app, memoryStore())
  gameServer = await listen(app)
  base = `http://127.0.0.1:${gameServer.address().port}`
})

after(() => {
  fakeBloxity?.close()
  gameServer?.close()
})

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const call = (method, path, { token = TOKEN, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : null),
      ...(body ? { 'Content-Type': 'application/json' } : null),
    },
    body: body ? JSON.stringify(body) : undefined,
  })


test('no token, or a token Bloxity does not know, is not signed in', async () => {
  assert.equal((await call('GET', '/api/progress', { token: null })).status, 401)
  assert.equal((await call('GET', '/api/progress', { token: 'someone-elses-token' })).status, 401)
})

test('a new player has no save yet', async () => {
  const res = await call('GET', '/api/progress')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.progress, null)
  assert.equal(body.rev, 0)
})

test('a save comes back on the next load, with a new revision', async () => {
  const progress = { ammo: 1234, wins: 56, rebirths: 2, owned: ['starter', 'space'], equipped: 'space' }
  const put = await call('PUT', '/api/progress', { body: { progress } })
  assert.equal(put.status, 200)
  const { rev } = await put.json()
  assert.equal(rev, 1)

  const body = await (await call('GET', '/api/progress')).json()
  assert.equal(body.rev, 1)
  assert.equal(body.progress.ammo, 1234)
  assert.equal(body.progress.rebirths, 2)
  assert.deepEqual(body.progress.owned, ['starter', 'space'])
})

test('saves too close together are turned away', async () => {
  // The previous test saved moments ago.
  const res = await call('PUT', '/api/progress', { body: { progress: { ammo: 1 } } })
  assert.equal(res.status, 429)
})

test('a closing page can save with a beacon, token in the body', async () => {
  await new Promise((r) => setTimeout(r, 1100))
  const send = (body) =>
    fetch(`${base}/api/progress/beacon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
  assert.equal((await send(JSON.stringify({ token: 'someone-elses-token', progress: { ammo: 1 } }))).status, 401)
  assert.equal((await send('not json')).status, 400)
  assert.equal((await send(JSON.stringify({ token: TOKEN, progress: { ammo: 777 } }))).status, 200)
  const body = await (await call('GET', '/api/progress')).json()
  assert.equal(body.progress.ammo, 777)
})

test('the leaderboard lists saved players by name, without signing in', async () => {
  await new Promise((r) => setTimeout(r, 1100))
  await call('PUT', '/api/progress', { body: { progress: { wins: 900, rebirths: 3, bossLevel: 4 } } })
  const res = await call('GET', '/api/leaderboard', { token: null })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.wins, [{ username: 'tester', value: 900 }])
  assert.deepEqual(body.rebirths, [{ username: 'tester', value: 3 }])
  // Level 4 is the next boss: three beaten.
  assert.deepEqual(body.bosses, [{ username: 'tester', value: 3 }])
})
