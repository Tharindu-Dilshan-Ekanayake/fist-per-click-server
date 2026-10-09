const assert = require('node:assert/strict')
const { test } = require('node:test')

const { sanitizeProgress } = require('./progress')

test('rejects anything that is not a save', () => {
  assert.equal(sanitizeProgress(null), null)
  assert.equal(sanitizeProgress('strength'), null)
  assert.equal(sanitizeProgress([1, 2]), null)
})

test('keeps numbers finite, positive and whole where they must be', () => {
  const out = sanitizeProgress({ strength: -5, wins: Infinity, rebirths: 2.7, ringWins: -1, bestWall: '9' })
  assert.equal(out.strength, 0)
  assert.equal(out.wins, 0)
  assert.equal(out.rebirths, 2)
  assert.equal(out.ringWins, 0)
  assert.equal(out.bestWall, 0)
})

test('keeps VIP items - they are bought with Wins like everything else', () => {
  const save = {
    owned: ['starter', 'space', 'phantom', 'celestial'],
    equipped: 'celestial',
    ownedPasses: ['power2x', 'wins2x'],
    unlockedTrainers: ['target-1', 'vip-2'],
    ownedPets: ['common', 'exclusive'],
    equippedPets: ['exclusive', 'common'],
  }
  const out = sanitizeProgress(save)
  assert.deepEqual(out.owned, ['starter', 'space', 'phantom', 'celestial'])
  assert.equal(out.equipped, 'celestial')
  assert.deepEqual(out.ownedPasses, ['power2x', 'wins2x'])
  assert.deepEqual(out.unlockedTrainers, ['target-1', 'vip-2'])
  assert.deepEqual(out.equippedPets, ['exclusive', 'common'])
})

test('nothing un-owned can be in your hand or following you', () => {
  const out = sanitizeProgress({ owned: ['starter'], equipped: 'phantom', ownedPets: ['common'], equippedPets: ['exclusive', 'common'] })
  assert.equal(out.equipped, 'starter')
  assert.deepEqual(out.equippedPets, ['common'])
})

test('lists are de-duplicated, string-only and bounded', () => {
  const out = sanitizeProgress({ owned: ['a', 'a', 7, '', 'x'.repeat(100), 'b'] })
  assert.deepEqual(out.owned, ['a', 'b'])
})

test('footprints need the gloves, and only bought ones can be worn', () => {
  const out = sanitizeProgress({ owned: ['starter', 'space'], ownedFootprints: ['starter', 'lava'], footprints: 'lava' })
  assert.deepEqual(out.ownedFootprints, ['starter'])
  assert.equal(out.footprints, null)
  const worn = sanitizeProgress({ owned: ['starter'], ownedFootprints: ['starter'], footprints: 'starter' })
  assert.equal(worn.footprints, 'starter')
})
