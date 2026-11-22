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
# Fast speech to text in the same worker: faster-whisper (MIT) on CTranslate2 (MIT), next to Qwen3-TTS. No PyAV (ffmpeg
# decodes, the worker stands in for it); the GPU uses the CUDA 12 libraries PyTorch already ships. Models download into
# /data/whisper/fast from Settings → Voice.
RUN /opt/unsloth-venv/bin/pip install --no-cache-dir --quiet --target /opt/voice-lib --no-deps faster-whisper==1.2.1 ctranslate2==4.9.0  && rm -rf /opt/voice-lib/bin && PYTHONPATH=/opt/voice-lib:/opt/kokoro-lib /opt/unsloth-venv/bin/python -c 'import sys, types; sys.modules.setdefault("av", types.ModuleType("av")); import yaml, tqdm, onnxruntime, ctranslate2, faster_whisper; print("fast speech ok", ctranslate2.__version__, faster_whisper.__version__)'
COPY server/voice/worker.py ./server/voice/worker.py
# The Shell block's sandbox (HiveBot H18): build and run code, make Windows .exe files without Windows. Go and the .NET 8
# SDK cross-build for Windows, Wine (64-bit) + Xvfb start an .exe headless, PowerShell 7 for pwsh scripts.
ARG PWSH_VERSION=7.4.6
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      zip unzip p7zip-full xvfb xauth wine wine64 golang-go dotnet-sdk-8.0 python3-venv python3-pip curl ca-certificates libicu74 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-x64.tar.gz" -o /tmp/pwsh.tgz \
 && mkdir -p /opt/microsoft/powershell/7 && tar -xzf /tmp/pwsh.tgz -C /opt/microsoft/powershell/7 && rm /tmp/pwsh.tgz \
 && chmod +x /opt/microsoft/powershell/7/pwsh && ln -sf /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
 && go version && dotnet --version && pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' && wine --version && command -v xvfb-run
# The Browser block (HiveBot H19): headless Chromium for Playwright, with the system libraries it needs.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN cd /app/server && npx --yes playwright-core@1.49.1 install --with-deps chromium && rm -rf /var/lib/apt/lists/* && ls /opt/ms-playwright
# Skills that come with HiveMind (the workflow guide), installed and shared at start.
COPY server/skills ./server/skills
# HiveBot's first rule files (names, listening): written into the owner's memory the first time HiveBot asks for them.
COPY server/hivebot ./server/hivebot
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
