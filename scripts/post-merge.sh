#!/bin/bash
set -euo pipefail

# Reconcile JavaScript dependencies after task-agent merges.
npm install --ignore-scripts --no-audit --no-fund

# Publish diffs the DEVELOPMENT database schema against production.
# Prepare only DATABASE_URL here; never run this in a deployment build hook.
node scripts/prepare-portfolio-development.js
