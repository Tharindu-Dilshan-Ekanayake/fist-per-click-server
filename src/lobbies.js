/**
 * Lobby matchmaking.
 *
 * A lobby holds at most MAX_PLAYERS. A joining player goes into the fullest lobby
 * that still has room, so lobbies fill up instead of spreading players thin; a new
 * lobby opens only when every existing one is full. Nobody waits for a lobby to
 * fill: it's playable from its first player. A lobby closes when its last player
 * leaves, and the gap a leaving player makes is filled by the next one to join.
 */

const MAX_PLAYERS = 8

class LobbyManager {
  constructor({ maxPlayers = MAX_PLAYERS } = {}) {
    this.maxPlayers = maxPlayers
    /** lobbyId -> { id, number, name, players: Map<playerId, player>, createdAt } */
    this.lobbies = new Map()
    /** playerId -> lobbyId */
    this.playerLobby = new Map()
    this.nextLobbyId = 1
  }

  /**
   * Puts a player (any object with an `id`) into the fullest lobby with room,
   * opening a new one if they're all full.
   * @returns the lobby they joined
   */
  join(player) {
    if (this.playerLobby.has(player.id)) {
      throw new Error(`player ${player.id} is already in a lobby`)
    }
    let best = null
    // Map iteration follows insertion order, so ties go to the oldest lobby.
    for (const lobby of this.lobbies.values()) {
      if (lobby.players.size >= this.maxPlayers) continue
      if (!best || lobby.players.size > best.players.size) best = lobby
    }
    const lobby = best ?? this.open()
    lobby.players.set(player.id, player)
    this.playerLobby.set(player.id, lobby.id)
    return lobby
  }

  /**
   * Takes a player out of their lobby, closing it if it's now empty.
   * @returns the lobby they left, or null if they weren't in one
   */
  leave(playerId) {
    const lobbyId = this.playerLobby.get(playerId)
    if (!lobbyId) return null
    this.playerLobby.delete(playerId)
    const lobby = this.lobbies.get(lobbyId)
    lobby.players.delete(playerId)
    if (lobby.players.size === 0) this.lobbies.delete(lobbyId)
    return lobby
  }

  /** The lobby a player is in, or null. */
  lobbyOf(playerId) {
    const lobbyId = this.playerLobby.get(playerId)
    return lobbyId ? this.lobbies.get(lobbyId) : null
  }

  /** A summary of every open lobby, for the status endpoint. */
  list() {
    return [...this.lobbies.values()].map((lobby) => ({
      id: lobby.id,
      name: lobby.name,
      players: lobby.players.size,
      max: this.maxPlayers,
    }))
  }

  /** @private Opens a lobby named with the lowest free number ("Lobby 1", "Lobby 2", ...). */
  open() {
    const used = new Set([...this.lobbies.values()].map((lobby) => lobby.number))
    let number = 1
    while (used.has(number)) number++
    const lobby = {
      // Ids are never reused, so a stale message can't land in a newer lobby.
      id: `L${this.nextLobbyId++}`,
      number,
      name: `Lobby ${number}`,
      players: new Map(),
      createdAt: Date.now(),
    }
    this.lobbies.set(lobby.id, lobby)
    return lobby
  }
}

module.exports = { LobbyManager, MAX_PLAYERS }
