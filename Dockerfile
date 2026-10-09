# Built by .github/workflows/deploy.yml and rolled out by Bloxity Legion - see
# that file for the branch-to-channel mapping and README.md for what Legion sets.
#
# Not used by Render: render.yaml runs the source directly with `npm ci` / `npm
# start`, no image involved. This exists for the Legion path only.

FROM node:22-alpine

WORKDIR /app

# Copied and installed before the rest of the source, so this layer - the slow one -
# is only rebuilt when a dependency actually changes, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Legion asks images to run as non-root; the base image already ships this user,
# so it is a matter of switching to it rather than creating one.
USER node

# Documentation, not enforcement - Legion reads PORT from the environment either
# way (see src/server.js) and maps its own port to whatever container port answers.
EXPOSE 3000

CMD ["node", "src/server.js"]
