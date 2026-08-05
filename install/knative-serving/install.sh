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

# Pin deliberately, and pin to something your cluster's Kubernetes version
# actually supports. Knative tracks Kubernetes closely — each release is built
# against a specific k8s API version and supports roughly the last three minors.
#
# To choose: check what the release was built against, and match your cluster.
#
#   kubectl version -o json | jq -r .serverVersion.gitVersion
#   curl -s https://raw.githubusercontent.com/knative/serving/knative-vX.Y.Z/go.mod \
#     | grep -m1 'k8s.io/api v'
#
#   k8s.io/api v0.31.x  ->  Kubernetes 1.31
#
# v1.17.0 is built against k8s.io/api v0.31.4, matching the weeb cluster's
# Kubernetes 1.31.2. Newer Knative (1.23 targets k8s 1.35) will misbehave here.
KNATIVE_VERSION="${KNATIVE_VERSION:-v1.17.0}"
NET_ISTIO_VERSION="${NET_ISTIO_VERSION:-v1.17.0}"

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

# Merge-patch rather than apply.
#
# `kubectl apply` replaces a ConfigMap's entire `data` map, which would drop the
# keys Knative writes at install time — most importantly queue-sidecar-image in
# config-deployment, which points at the digest of the queue-proxy image for
# this exact release. Without it the webhook rejects the ConfigMap outright, and
# if it were accepted every revision would fail to start.
#
# A merge patch sets only the keys we care about and leaves the rest alone,
# which also means these files stay valid across Knative upgrades.
for f in "$(dirname "$0")"/config/*.yaml; do
  name=$(grep -m1 '^  name:' "$f" | awk '{print $2}')
  echo "    patching $name"
  kubectl -n knative-serving patch configmap "$name" --type merge --patch-file "$f"
done

echo
echo "Knative Serving ${KNATIVE_VERSION} is installed."
kubectl -n knative-serving get pods
