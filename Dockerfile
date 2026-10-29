# ---- build ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build

# ---- server dependencies (pure JavaScript, so they run on any Linux) ----
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force

# ---- runtime: the training stack (PyTorch, CUDA, Unsloth, TRL, llama.cpp) with HiveMind on top ----
# Without a GPU everything except training works as before; with --gpus=all the built-in trainer can fine-tune models.
FROM unsloth/unsloth:core
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV NODE_ENV=production PORT=4820 DATA_DIR=/data WEB_DIR=/app/web HF_HOME=/data/trainer-cache/huggingface
COPY --from=deps /app ./
COPY --from=build /app/server/dist ./server/dist
# Scripts of the built-in trainer (copied into the Lab folder at start, run with the image's Python).
COPY --from=build /app/server/trainer ./server/trainer
COPY --from=build /app/web/dist ./web
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
VOLUME /data
EXPOSE 4820
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The base image starts JupyterLab; HiveMind is the only process here (it starts the trainer itself).
ENTRYPOINT []
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/main.js"]
