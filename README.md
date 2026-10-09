# +1 Ammo Per Click — server

The online half of the game:

- **Cloud saves.** A signed-in player's Ammo, Wins, Rebirths, guns, pets and passes
  are kept in MongoDB, keyed by their Bloxity account, and come back the next time
  they play — any device, any time later (`src/routes.js`, `src/store.js`).
- **Leaderboards.** The top players by Wins, Rebirths and bosses beaten, for the
  boards in the lobby.
- **Lobbies.** The Colyseus room that lets players in the same lobby see each other
  (`src/lobbyRoom.js`). The game plays fine without it.

Everything runs on one port: Express for HTTP, Colyseus for the socket.

## Running it locally

```bash
npm install
npm run dev      # nodemon, restarts on save
npm start        # plain node
npm test         # lobby matchmaking, save cleaning, and the HTTP API end to end
```

It listens on `http://localhost:3000` unless `PORT` says otherwise. Without
`MONGODB_URI` saves are kept in memory (the log says so) and vanish on restart.

## The HTTP API

| route | who calls it | what it does |
| --- | --- | --- |
| `GET /health` | Legion's probes | `{ ok: true }` |
| `GET /api/progress` | the game, with the player's Bloxity token | their save |
| `PUT /api/progress` | the game, with the token | stores `{ progress }`, answers `{ rev }` |
| `POST /api/progress/beacon` | a page that is closing | the same save, token in the body (`sendBeacon` cannot set headers) |
| `GET /api/leaderboard` | the lobby boards | top 10 by Wins, Rebirths and bosses |

**Who is saving** is never taken from the request. The token is checked with
Bloxity's API (`POST /v1/auth/game-token/verify`, falling back to `GET /v1/auth/me`
— the same calls the SDK makes), and the user Bloxity names is the one saved.
Answers are cached for five minutes (`src/auth.js`).

## Deploying to Bloxity Legion

**One-time setup**, in this repo's GitHub settings:

| where | name | value |
| --- | --- | --- |
| Secrets and variables → Actions → **Secrets** | `LEGION_DEPLOY_TOKEN` | the deploy token from My Games (behind the eye icon) |
| Secrets and variables → Actions → **Variables** | `LEGION_GAME_ID` | this game's id, from the same page |

**Then it deploys itself.** Push to `main` and `.github/workflows/deploy.yml` builds
the Docker image, pushes it to `ghcr.io/<owner>/ammo-per-click-server`, and asks
Legion to roll it out to **prod**. Push to `dev` and it goes to **dev**.

**The first push only** — GHCR makes a new package private, and Legion cannot pull a
private image. On GitHub: your profile → **Packages** → `ammo-per-click-server` →
Package settings → **Change visibility → Public**.

Legion sets `PORT`, `NODE_ENV`, `CLIENT_ORIGIN`, `JWT_SECRET`, `MONGODB_URI`,
`BLOXITY_GAME_ID`, `BLOXITY_CHANNEL` and `POD_NAME`. `MONGODB_URI` is this game's own
isolated database for that channel, so prod and dev saves never mix.

**Scaling.** The deploy sends `seatCap: 50`, the same number as the lobby room's
`maxClients` (`SEAT_CAP` in `src/lobbyRoom.js`). When a pod is full the matchmaker
starts another; when everyone leaves, the game scales to zero. Players reach a pod
only through the matchmaker at `play.bloxity.io` (see the client's
`src/net/lobbyClient.js`) — never by opening a socket to `<id>.host.bloxity.io`,
which is for HTTP only (saves and leaderboards).

**Deploys drain.** On SIGTERM the server closes its rooms (players reconnect through
the matchmaker onto the new pod) and then closes the database. Progress is never at
risk on a deploy: it is saved over HTTP every few seconds, not held in a pod.
