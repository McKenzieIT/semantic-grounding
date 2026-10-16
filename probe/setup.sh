#!/bin/bash
# #178 probe setup: install + build in the research worktree. Long-running; run with nohup.
set -x
W=/Users/mckenzie/workspace/sg-research-178
cd "$W" || exit 1
echo "=== node/pnpm versions ==="
node -v
pnpm -v
git -v
echo "=== pnpm install ==="
pnpm install --frozen-lockfile 2>&1 | tail -20
echo "INSTALL_EXIT=$?"
echo "=== pnpm -r build ==="
pnpm -r build 2>&1 | tail -30
echo "BUILD_EXIT=$?"
ls -la "$W/packages/substrate/lib" | head -5
ls -la "$W/packages/mcp/lib" | head -5
echo "SETUP_DONE"
