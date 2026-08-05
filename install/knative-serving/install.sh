#!/usr/bin/env bash
#
# Install Knative Serving with the Istio network layer.
#
# The cluster already runs Istio, so net-istio is the natural ingress layer —
# Knative reuses the mesh rather than standing up a second data plane.
#
# Idempotent: safe to re-run to upgrade. Knative supports single minor-version
# steps only, so to go from 1.20 to 1.23 you must apply 1.21 and 1.22 first.

set -euo pipefail

# Pin deliberately. Knative's CRDs change between minors and a surprise upgrade
# on re-run is not something you want to discover mid-incident.
KNATIVE_VERSION="${KNATIVE_VERSION:-v1.23.0}"
NET_ISTIO_VERSION="${NET_ISTIO_VERSION:-v1.23.0}"

SERVING="https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}"
NET_ISTIO="https://github.com/knative-extensions/net-istio/releases/download/knative-${NET_ISTIO_VERSION}"

echo "==> Installing Knative Serving ${KNATIVE_VERSION}"

# CRDs first, and wait for establishment — applying core against
# not-yet-registered CRDs is the most common cause of a failed install.
kubectl apply -f "${SERVING}/serving-crds.yaml"
kubectl wait --for=condition=Established --timeout=90s \
  crd/services.serving.knative.dev \
  crd/configurations.serving.knative.dev \
  crd/revisions.serving.knative.dev \
  crd/routes.serving.knative.dev

kubectl apply -f "${SERVING}/serving-core.yaml"

echo "==> Installing net-istio ${NET_ISTIO_VERSION}"
kubectl apply -f "${NET_ISTIO}/net-istio.yaml"

echo "==> Waiting for the control plane"
kubectl -n knative-serving wait --for=condition=Available --timeout=300s \
  deployment/controller deployment/webhook deployment/activator deployment/autoscaler

echo "==> Applying local configuration"
kubectl apply -f "$(dirname "$0")/config/"

echo
echo "Knative Serving ${KNATIVE_VERSION} is installed."
kubectl -n knative-serving get pods
