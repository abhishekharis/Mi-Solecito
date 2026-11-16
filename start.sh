#!/usr/bin/env bash
# Mi Solecito — start everything cleanly in one command.
# Usage: ./start.sh

set -e
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_LOG="/tmp/mi-solecito-agent.log"
CHERT_LOG="/tmp/mi-solecito-chert.log"

echo "── Mi Solecito ──────────────────────────────────"

# ── 1. Kill anything left from a previous run ─────────
echo "→ Stopping old processes..."
pkill -9 -f "dist/agent.js"            2>/dev/null || true  # worker (relative path)
pkill -9 -f "job_proc_lazy_main"       2>/dev/null || true  # job subprocs
pkill -9 -f "inference_proc_lazy_main" 2>/dev/null || true
pkill -9 -f "@trychert/facetime"       2>/dev/null || true
pkill -9 -f "node_modules/.bin/chert"  2>/dev/null || true
ps aux | grep "Chert project" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
lsof -ti :8081 | xargs kill -9        2>/dev/null || true
sleep 2

# ── 2. Build ──────────────────────────────────────────
echo "→ Building..."
cd "$PROJECT_DIR"
npm run build
cp src/score-card.html dist/score-card.html
echo "✓ Build OK"

# ── 2b. Start webhook server ─────────────────────────
echo "→ Starting webhook server..."
node --env-file .env dist/server.js &
SERVER_PID=$!
sleep 1
echo "✓ Webhook server started (PID $SERVER_PID)"

# ── 3. Start agent worker ────────────────────────────
echo "→ Starting agent worker..."
node dist/agent.js start > "$AGENT_LOG" 2>&1 &
AGENT_PID=$!

for i in {1..15}; do
  if grep -q "registered worker" "$AGENT_LOG" 2>/dev/null; then
    echo "✓ Agent registered (PID $AGENT_PID)"
    break
  fi
  sleep 1
  if [ $i -eq 15 ]; then
    echo "✗ Agent failed to register. Check $AGENT_LOG"
    exit 1
  fi
done

# ── 4. Start Chert ───────────────────────────────────
echo "→ Starting Chert..."
npx @trychert/facetime@0.1.0-beta.21 dev \
  --agent show-and-say \
  --env-file .env > "$CHERT_LOG" 2>&1 &

# Wait for ready or line_in_use
for i in {1..12}; do
  sleep 1
  if grep -q "waiting room" "$CHERT_LOG" 2>/dev/null; then
    echo "✓ Chert ready"
    break
  fi
  if grep -q "line_in_use" "$CHERT_LOG" 2>/dev/null; then
    echo "→ Line held by old session — taking over..."
    pkill -9 -f "@trychert/facetime"      2>/dev/null || true
    pkill -9 -f "node_modules/.bin/chert" 2>/dev/null || true
    sleep 3
    npx @trychert/facetime@0.1.0-beta.21 dev \
      --agent show-and-say \
      --env-file .env \
      --takeover > "$CHERT_LOG" 2>&1 &
    sleep 6
    break
  fi
done

echo ""
tail -4 "$CHERT_LOG"
echo ""
echo "Agent log : $AGENT_LOG"
echo "Chert log : $CHERT_LOG"
echo "────────────────────────────────────────────────"
