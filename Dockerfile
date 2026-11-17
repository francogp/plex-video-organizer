FROM mwader/static-ffmpeg:latest AS ffmpeg-source

FROM --platform=$BUILDPLATFORM node:26.13.1-alpine3.24 AS builder

RUN apk add --no-cache git \
  && npm install -g npm@latest \
  && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY index.html tsconfig.json vite.config.ts vite.plugins.ts ./
COPY public ./public
COPY src ./src
RUN ./node_modules/.bin/vp build

FROM node:26.13.1-alpine3.24 AS runtime

RUN apk add --no-cache ca-certificates

WORKDIR /app

ENV NODE_ENV=production \
  APP_PORT=3000 \
  HOME=/tmp

COPY --from=ffmpeg-source --chmod=0755 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-source --chmod=0755 /ffprobe /usr/local/bin/ffprobe
COPY package.json ./package.json
COPY --from=builder /app/node_modules/valibot ./node_modules/valibot
COPY --from=builder /app/dist ./dist
COPY src/domain ./src/domain
COPY src/server ./src/server

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.APP_PORT || '3000') + '/api/state').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER 1000:1000

CMD ["node", "src/server/index.ts"]
