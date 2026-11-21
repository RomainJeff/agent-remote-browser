#!/bin/sh
# Scans local images with Trivy, failing on CRITICAL vulnerabilities that have a fix. Used by ci.yml.
#   .github/trivy.sh arb-gateway:ci arb-computer:ci
# The Trivy binary comes from its GitHub release, checked against the sha256 pinned here (not trivy-action: its
# 2026 supply-chain compromise). ponytail: version + sum bumped by hand (Renovate cannot recompute the sum).
set -eu
V=0.76.1 SUM=c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0
d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT
curl -fsSLo "$d/t.tgz" "https://github.com/aquasecurity/trivy/releases/download/v$V/trivy_${V}_Linux-64bit.tar.gz"
echo "$SUM  $d/t.tgz" | sha256sum -c -
tar -C "$d" -xzf "$d/t.tgz" trivy
for img in "$@"; do
  "$d/trivy" image --no-progress --severity CRITICAL --ignore-unfixed --exit-code 1 "$img"
done
