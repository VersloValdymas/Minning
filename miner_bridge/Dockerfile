# Home Assistant add-on image: Node.js app + embedded PostgreSQL/TimescaleDB ("install and forget").
# Also usable standalone: docker build -t miner-bridge . && docker run -p 3000:3000 -v mb-data:/data miner-bridge
#
# The base image is pinned: a PostgreSQL MAJOR upgrade needs a data migration (pg_upgrade / dump+restore),
# so never bump the -pgNN part without a migration plan.
ARG BASE_IMAGE=timescale/timescaledb:2.30.2-pg18

FROM ${BASE_IMAGE} AS build
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${BASE_IMAGE}
RUN apk add --no-cache nodejs
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY migrations ./migrations
COPY run.sh /run.sh
# Strip CRLF in case the repo was checked out on Windows
RUN sed -i 's/\r$//' /run.sh && chmod a+x /run.sh

LABEL io.hass.type="addon" io.hass.name="Miner Bridge"
EXPOSE 3000
# Replace the postgres image's entrypoint: run.sh starts PostgreSQL itself
ENTRYPOINT ["/run.sh"]
CMD []
