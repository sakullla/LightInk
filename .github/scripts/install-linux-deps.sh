#!/usr/bin/env bash
# GitHub-hosted Ubuntu runners often hang on azure.archive.ubuntu.com
# (actions/runner-images#11347, #12949) until the job is cancelled.
# Prefer archive.ubuntu.com, fail fast, and retry a few times.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo find /etc/apt -type f \( \
  -name 'apt-mirrors.txt' -o \
  -name 'sources.list' -o \
  -name '*.list' -o \
  -name '*.sources' \
\) -exec sed -i \
  -e 's|http://azure.archive.ubuntu.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' \
  -e 's|https://azure.archive.ubuntu.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' \
  {} +

if [ -f /etc/apt/apt-mirrors.txt ]; then
  printf 'http://archive.ubuntu.com/ubuntu/\nhttp://security.ubuntu.com/ubuntu/\n' \
    | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
fi

APT_OPTS=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o Acquire::ftp::Timeout=20
  -o Dpkg::Use-Pty=0
)

PACKAGES=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  patchelf
)

for attempt in 1 2 3; do
  if sudo apt-get "${APT_OPTS[@]}" update \
    && sudo apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "${PACKAGES[@]}"; then
    exit 0
  fi
  echo "apt failed (attempt ${attempt}/3), retrying..." >&2
  sleep $((attempt * 5))
done

echo "apt failed after 3 attempts" >&2
exit 1
