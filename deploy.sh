#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo "🚀 Starting Occupancy Tracking Deployment"
echo "=========================================="

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "❌ Error: .env file not found in $APP_DIR"
  echo "Please create .env with DATABASE_URL connecting to your PostgreSQL instance."
  exit 1
fi

echo "📦 Pulling latest changes from branch main..."
git fetch origin main
git checkout main
git pull origin main

echo "🐳 Building and starting containers..."
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

echo "⏳ Waiting for service to become healthy..."
APP_PORT=$(grep -E '^PORT=' .env | cut -d '=' -f2 | tr -d ' "\r' || true)
APP_PORT="${APP_PORT:-3001}"
MAX_ATTEMPTS=30
ATTEMPT=0
HEALTH_URL="http://127.0.0.1:${APP_PORT}/api/health"

until curl -s -f "$HEALTH_URL" > /dev/null || [ $ATTEMPT -eq $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "Attempt $ATTEMPT/$MAX_ATTEMPTS: Waiting for $HEALTH_URL..."
  sleep 2
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  echo "❌ Deployment failed: Healthcheck timed out."
  docker compose -f docker-compose.prod.yml logs --tail 50
  exit 1
fi

echo "✅ Service is up and healthy!"
echo "🧹 Cleaning unused Docker images..."
docker image prune -f

echo "🎉 Deployment completed successfully!"
