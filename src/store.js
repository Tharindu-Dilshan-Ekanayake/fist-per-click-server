const { MongoClient } = require('mongodb')

/**
 * Where saves live.
 *
 * On Bloxity Legion that is the game's own managed MongoDB: every game and channel
 * gets an isolated database and a user scoped to it, handed over as MONGODB_URI.
 * Nothing to provision - read the variable and connect. Every pod of the game shares
 * it, which is what lets a save made on one pod be loaded on another.
 *
 * Without MONGODB_URI (local development) the same interface is backed by memory, so
 * the game runs end to end on a laptop; it simply forgets everything on restart.
 *
 * One collection:
 *   saves  { _id: userId, progress, rev, username, updatedAt }
 */

function memoryStore() {
  const saves = new Map()
  return {
    kind: 'memory',
    async getSave(userId) {
      return saves.get(userId) ?? null
    },
    async putSave(userId, progress, username) {
      const rev = (saves.get(userId)?.rev ?? 0) + 1
      saves.set(userId, { progress, rev, username, updatedAt: new Date() })
      return rev
    },
    async topSaves(field, limit) {
      return [...saves.values()]
        .filter((save) => save.username && save.progress?.[field] > 0)
        .sort((a, b) => b.progress[field] - a.progress[field])
        .slice(0, limit)
        .map((save) => ({ username: save.username, value: save.progress[field] }))
    },
    async close() {},
  }
}

async function mongoStore(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 })
  await client.connect()
  // The URI names this game's own database; `db()` with no argument uses it.
  const db = client.db()
  const saves = db.collection('saves')
  // One per leaderboard (see routes.js), so the boards never scan every save.
  await Promise.all(['wins', 'rebirths', 'ringWins'].map((field) => saves.createIndex({ [`progress.${field}`]: -1 })))

  return {
    kind: 'mongo',
    async getSave(userId) {
      return saves.findOne({ _id: userId })
    },
    async putSave(userId, progress, username) {
      // One atomic step, so two tabs saving at once still get two distinct revisions.
      const doc = await saves.findOneAndUpdate(
        { _id: userId },
        { $set: { progress, username, updatedAt: new Date() }, $inc: { rev: 1 } },
        { upsert: true, returnDocument: 'after', projection: { rev: 1 } },
      )
      return doc.rev
    },
    /** The `limit` best saves by `progress[field]`, as `{ username, value }`. */
    async topSaves(field, limit) {
      const key = `progress.${field}`
      const docs = await saves
        .find({ username: { $nin: ['', null] }, [key]: { $gt: 0 } }, { projection: { username: 1, [key]: 1 } })
        .sort({ [key]: -1 })
        .limit(limit)
        .toArray()
      return docs.map((doc) => ({ username: doc.username, value: doc.progress[field] }))
    },
    async close() {
      await client.close()
    },
  }
}

/** Connects to MONGODB_URI if set, otherwise falls back to memory (and says so). */
async function openStore() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.warn('[store] MONGODB_URI is not set - saves are kept in memory only')
    return memoryStore()
  }
  const store = await mongoStore(uri)
  console.log('[store] connected to MongoDB')
  return store
}

module.exports = { openStore, memoryStore }
