#!/usr/bin/env bash
# teardown-kind.sh — nuke the dev cluster
set -euo pipefail
CLUSTER_NAME="luxecart-dev"

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "deleting kind cluster '${CLUSTER_NAME}'..."
  kind delete cluster --name "${CLUSTER_NAME}"
else
  echo "cluster '${CLUSTER_NAME}' not found — nothing to do"
fi
