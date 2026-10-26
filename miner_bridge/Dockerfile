# Home Assistant add-on image. Also usable standalone: docker build -t miner-bridge .
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
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
CMD ["/run.sh"]
