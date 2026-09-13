#!/bin/bash
set -euo pipefail

# Reconcile JavaScript dependencies after task-agent merges.
npm install --ignore-scripts --no-audit --no-fund
