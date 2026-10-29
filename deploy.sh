#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo "🚀 Starting Occupancy Tracking Deployment"
echo "=========================================="

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# Ensure standard binary paths and pnpm are in PATH for non-interactive SSH
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:$HOME/.local/share/pnpm:$HOME/.pnpm-global/bin:$PATH"

if [ ! -f .env ]; then
  echo "❌ Error: .env file not found in $APP_DIR"
  echo "Please create .env with DATABASE_URL connecting to your PostgreSQL instance."
  exit 1
fi

# Detect configured PORT from .env, default to 3001
PORT=$(grep -E '^PORT=' .env | head -n 1 | cut -d '=' -f2 | tr -d ' "\r' || true)
PORT=${PORT:-3001}

echo "📦 Pulling latest changes from branch main..."
git fetch origin main || true
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ]; then
  git pull origin main
fi

# Check deployment mode: systemd (occupancy-tracking), PM2, or Docker
if systemctl is-active --quiet occupancy-tracking.service 2>/dev/null || [ -f /etc/systemd/system/occupancy-tracking.service ]; then
  echo "⚙️ Deploying with systemd (occupancy-tracking.service)..."
  pnpm install --frozen-lockfile
  pnpm run build
  if [ "$(id -u)" -eq 0 ]; then
    systemctl daemon-reload || true
    systemctl restart occupancy-tracking
  elif command -v sudo &> /dev/null; then
    sudo systemctl daemon-reload || true
    sudo systemctl restart occupancy-tracking
  else
    systemctl restart occupancy-tracking
  fi
elif command -v pm2 &> /dev/null && (pm2 list | grep -q "occupancy-tracking" || [ -f ecosystem.config.cjs ]); then
  echo "⚡ Deploying with PM2..."
  pnpm install --frozen-lockfile
  pnpm run build
  if pm2 list | grep -q "occupancy-tracking"; then
    pm2 reload occupancy-tracking --update-env
  else
    pm2 start ecosystem.config.cjs
  fi
  pm2 save
elif command -v docker &> /dev/null && [ -f docker-compose.prod.yml ]; then
  echo "🐳 Deploying with Docker Compose..."
  docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
  docker image prune -f
else
  echo "📦 Building with pnpm..."
  pnpm install --frozen-lockfile
  pnpm run build
  echo "ℹ️ PM2 or systemd not active yet. You can start the server with: pnpm start"
fi

echo "⏳ Waiting for service to become healthy on port $PORT..."
MAX_ATTEMPTS=30
ATTEMPT=0
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

until curl -s -f "$HEALTH_URL" > /dev/null || [ $ATTEMPT -eq $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "Attempt $ATTEMPT/$MAX_ATTEMPTS: Waiting for $HEALTH_URL..."
  sleep 2
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  echo "⚠️ Warning: Healthcheck probe timed out at $HEALTH_URL."
  echo "Check application logs (journalctl -u occupancy-tracking or pm2 logs)."
else
  echo "✅ Service is up and healthy on port $PORT!"
fi

echo "🎉 Deployment step completed!"
