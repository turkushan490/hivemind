# ---- build ----
FROM node:24-slim AS build
# The project tests use git (against local repos).
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
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

# ---- colibri: an engine for very large mixture-of-experts models (Settings → Colibri), pinned to a release ----
# Built from source for x86-64 CPUs and, with CUDA, for CUDA_ARCH (sm_75 = Turing; the release files start at sm_80).
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS colibri
ARG COLIBRI_REF=v2.1.0
ARG CUDA_ARCH=sm_75
ENV COLIBRI_REF=$COLIBRI_REF CUDA_ARCH=$CUDA_ARCH
RUN apt-get update && apt-get install -y --no-install-recommends git make build-essential python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$COLIBRI_REF" https://github.com/JustVugg/colibri.git /src
COPY server/colibri/build.sh /build.sh
RUN sh /build.sh

# ---- whisper.cpp: built-in speech-to-text (Settings → Voice), the same engine that ships in the Windows .exe ----
# A static CPU build, so one small binary copies in; the ggml model files download into /data/whisper on first use.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.7.4
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggerganov/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build -j --target whisper-cli \
 && mkdir -p /opt/whisper && cp build/bin/whisper-cli /opt/whisper/whisper-cli && strip /opt/whisper/whisper-cli

# ---- runtime: the training stack (PyTorch, CUDA, Unsloth, TRL, llama.cpp) with HiveMind on top ----
# Without a GPU everything except training works as before; with --gpus=all the built-in trainer can fine-tune models.
FROM unsloth/unsloth:core
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
# npm and npx for project builds (Build block), git for projects on GitHub, and the unprivileged user builds run as.
COPY --from=node:24-slim /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && (command -v git >/dev/null || (apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*)) \
 && (id hmbuild >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hmbuild) \
 && git --version && npm --version && npx --version && id hmbuild
WORKDIR /app
ENV NODE_ENV=production PORT=4820 DATA_DIR=/data WEB_DIR=/app/web HF_HOME=/data/trainer-cache/huggingface
COPY --from=deps /app ./
COPY --from=build /app/server/dist ./server/dist
# Scripts of the built-in trainer (copied into the Lab folder at start, run with the image's Python).
COPY --from=build /app/server/trainer ./server/trainer
# Colibri: the engine builds (/opt/colibri/cpu, /opt/colibri/cuda) and HiveMind's bridge to its catalog and downloads.
COPY --from=colibri /opt/colibri /opt/colibri
COPY server/colibri/helper.py ./server/colibri/helper.py
# Built-in speech-to-text: the whisper.cpp binary (Settings → Voice). Models download into /data/whisper on first use.
COPY --from=whisper /opt/whisper /opt/whisper
# Built-in voice: Kokoro (kokoro-onnx) in its own folder, so the training stack's packages stay as they are. The model
# files (~350 MB) are downloaded into /data/kokoro the first time a voice is needed.
RUN /opt/unsloth-venv/bin/pip install --no-cache-dir --quiet --target /opt/kokoro-lib kokoro-onnx==0.6.1  && rm -rf /opt/kokoro-lib/bin && PYTHONPATH=/opt/kokoro-lib /opt/unsloth-venv/bin/python -c 'import kokoro_onnx, soundfile; print("kokoro ok")'
COPY server/kokoro/serve.py ./server/kokoro/serve.py
# Voice engine for cloned voices (HiveBot's Voice trainer): Qwen3-TTS with the transformers it was made for, in its own
# folder (the training stack keeps its own versions); onnxruntime and soundfile come from /opt/kokoro-lib. Its model
# (~2.5 GB) is downloaded into /data/models/voice the first time a voice speaks.
RUN /opt/unsloth-venv/bin/pip install --no-cache-dir --quiet --target /opt/voice-lib --no-deps qwen-tts==0.1.1 transformers==4.57.3 accelerate==1.12.0 sox==1.5.0 tokenizers==0.22.1 'huggingface_hub<1.0'  && rm -rf /opt/voice-lib/bin && PYTHONPATH=/opt/voice-lib:/opt/kokoro-lib /opt/unsloth-venv/bin/python -c 'import qwen_tts; print("voice engine ok")'
COPY server/voice/worker.py ./server/voice/worker.py
# Skills that come with HiveMind (the workflow guide), installed and shared at start.
COPY server/skills ./server/skills
RUN (ldconfig -p | grep -q 'libgomp.so.1' || (apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*))  && (cat /opt/colibri/build.json 2>/dev/null || echo 'colibri: not in this image')
COPY --from=build /app/web/dist ./web
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ARG APP_RELEASE=dev
ENV APP_RELEASE=$APP_RELEASE
VOLUME /data
EXPOSE 4820
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The base image starts JupyterLab; HiveMind is the only process here (it starts the trainer itself).
ENTRYPOINT []
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/main.js"]
