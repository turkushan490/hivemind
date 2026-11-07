#!/bin/sh
# Builds colibri (github.com/JustVugg/colibri) for the HiveMind image, twice: CPU only (x86-64-v3, any AVX2 CPU)
# and with CUDA for CUDA_ARCH. An engine that does not build is left out and never fails the image; HiveMind
# uses the CUDA build when it starts on the GPU there, and the CPU build otherwise.
#   COLIBRI_REF  the tag that was cloned into /src (written into build.json)
#   CUDA_ARCH    e.g. sm_75 (Turing), sm_86; empty = no CUDA build
set -u
out=/opt/colibri
mkdir -p "$out"
engines="colibri qwen36 deepseek-v4"
cuda=false
for flavour in cpu cuda; do
  flags="ARCH=x86-64-v3"
  if [ "$flavour" = cuda ]; then
    [ -n "${CUDA_ARCH:-}" ] || continue
    flags="$flags CUDA=1 CUDA_ARCH=${CUDA_ARCH}"
  fi
  rm -rf /tmp/b && cp -r /src /tmp/b
  built=""
  for t in $engines; do
    # shellcheck disable=SC2086
    if make -C /tmp/b/c -j"$(nproc)" $flags "$t" >"/tmp/$flavour-$t.log" 2>&1; then
      built="$built $t"
    else
      echo "colibri ($flavour): $t did not build, left out. Last lines:"
      tail -n 25 "/tmp/$flavour-$t.log"
    fi
  done
  echo "colibri ($flavour) built:${built:- nothing}"
  [ -n "$built" ] || continue
  # The launcher (coli), its Python gateway and tools, and the engine binaries; no sources or objects.
  find /tmp/b/c -name '*.o' -delete
  rm -rf /tmp/b/c/tests /tmp/b/c/.build-config
  mkdir -p "$out/$flavour"
  cp -r /tmp/b/c "$out/$flavour/c"
  [ "$flavour" = cuda ] && cuda=true
done
[ -f "$out/cpu/c/coli" ] || { echo "colibri: the CPU build failed, the image goes without colibri"; rm -rf "${out:?}"/*; exit 0; }
version=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$out/cpu/c/version.py")
printf '{"ref": "%s", "version": "%s", "cuda": %s, "cudaArch": "%s"}\n' "${COLIBRI_REF:-}" "$version" "$cuda" "${CUDA_ARCH:-}" >"$out/build.json"
cat "$out/build.json"
du -sh "$out"
