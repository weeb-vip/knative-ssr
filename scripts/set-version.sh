#!/usr/bin/env bash
# Writes a release version into the chart. Called from semantic-release's
# prepare step so a chart version in git always names an edge image that was
# actually built and pushed under the same number.
#
# Every substitution is verified afterwards. A sed that quietly matches nothing
# would ship a chart still pinned to the previous release's image — which looks
# like a deploy that "didn't take" and is miserable to trace back to this file.
set -euo pipefail

VERSION="${1:?usage: set-version.sh <version>}"

CHART_DIR="$(cd "$(dirname "$0")/../charts/ssr-knative" && pwd)"
CHART="$CHART_DIR/Chart.yaml"
VALUES="$CHART_DIR/values.yaml"

sed -E -i "s/^version: .*/version: $VERSION/"          "$CHART"
sed -E -i "s/^appVersion: .*/appVersion: \"$VERSION\"/" "$CHART"

# Scoped to the `edge:` block. ssr.image.tag in the same file is the consuming
# application's image, not ours, and must stay empty so the chart keeps failing
# loudly when a deployment forgets to set it.
sed -E -i "/^edge:/,/^[a-z]/ s/^    tag: .*/    tag: \"$VERSION\"/" "$VALUES"

check() {
  grep -qF "$2" "$1" || {
    echo "::error::$3 was not updated in $1 — the file's shape changed and this script's sed no longer matches" >&2
    exit 1
  }
}

check "$CHART"  "version: $VERSION"         "chart version"
check "$CHART"  "appVersion: \"$VERSION\""  "chart appVersion"
check "$VALUES" "tag: \"$VERSION\""         "edge image tag"

echo "chart and edge image tag pinned to $VERSION"
