#!/bin/bash
# ============================================================
#  ParkingPro — Local Mode Setup Script
#  Sets up a local PostgreSQL database and configures the
#  backend for on-premise operation.
# ============================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "============================================="
echo "  ParkingPro - Configuración Modo Local"
echo "============================================="
echo ""

# ── 1. Check PostgreSQL is installed ──────────────────────────
if ! command -v psql &> /dev/null; then
    echo -e "${RED}PostgreSQL no está instalado.${NC}"
    echo ""
    echo "Instale PostgreSQL primero:"
    echo "  Ubuntu/Debian: sudo apt install postgresql postgresql-contrib"
    echo "  macOS:         brew install postgresql@16"
    echo "  Windows:       Descargue de https://www.postgresql.org/download/"
    echo ""
    exit 1
fi

echo -e "${GREEN}✓${NC} PostgreSQL encontrado: $(psql --version)"

# ── 2. Database configuration ────────────────────────────────
DB_NAME="${PARKINGPRO_DB_NAME:-parkingpro}"
DB_USER="${PARKINGPRO_DB_USER:-parkingpro}"
DB_PASS="${PARKINGPRO_DB_PASS:-parkingpro_local_$(openssl rand -hex 8)}"
DB_HOST="${PARKINGPRO_DB_HOST:-localhost}"
DB_PORT="${PARKINGPRO_DB_PORT:-5432}"

echo ""
echo "Configuración de base de datos:"
echo "  Base de datos: $DB_NAME"
echo "  Usuario:       $DB_USER"
echo "  Host:          $DB_HOST:$DB_PORT"
echo ""

# ── 3. Create user and database ──────────────────────────────
echo "Creando usuario y base de datos..."

# Try to create user (may already exist)
sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || \
    echo -e "${YELLOW}Usuario $DB_USER ya existe (OK)${NC}"

# Create database
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || \
    echo -e "${YELLOW}Base de datos $DB_NAME ya existe (OK)${NC}"

# Grant privileges
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

# Enable extensions
sudo -u postgres psql -d $DB_NAME -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' 2>/dev/null
sudo -u postgres psql -d $DB_NAME -c 'CREATE EXTENSION IF NOT EXISTS "pg_trgm";' 2>/dev/null

echo -e "${GREEN}✓${NC} Base de datos configurada"

# ── 4. Apply schema ──────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
SCHEMA_FILE="$BACKEND_DIR/database/schema.sql"
MIGRATIONS_DIR="$BACKEND_DIR/database/migrations"

DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME"

if [ -f "$SCHEMA_FILE" ]; then
    echo "Aplicando schema principal..."
    PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$SCHEMA_FILE" 2>&1 | tail -5
    echo -e "${GREEN}✓${NC} Schema aplicado"
fi

# ── 5. Apply migrations ─────────────────────────────────────
if [ -d "$MIGRATIONS_DIR" ]; then
    echo "Aplicando migraciones..."
    for migration in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
        echo "  → $(basename $migration)"
        PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$migration" 2>&1 | tail -2
    done
    echo -e "${GREEN}✓${NC} Migraciones aplicadas"
fi

# ── 6. Generate .env for local mode ─────────────────────────
ENV_FILE="$BACKEND_DIR/.env.local"

cat > "$ENV_FILE" << EOF
# ============================================
# ParkingPro — Configuración Modo Local
# Generado automáticamente $(date)
# ============================================

# Modalidad
DEPLOYMENT_MODE=local

# Servidor
PORT=3000
NODE_ENV=production
FRONTEND_URL=http://localhost:3000

# Base de Datos Local
DATABASE_URL=$DATABASE_URL

# JWT (generado automáticamente)
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES_IN=24h

# Supabase NO requerido en modo local
# SUPABASE_URL=
# SUPABASE_SERVICE_KEY=

# Impuestos RD
TAX_RATE=0.18
CASH_DIFF_THRESHOLD=200
REFUND_LIMIT_OPERATOR=500
EOF

echo -e "${GREEN}✓${NC} Archivo .env.local generado"

# ── 7. Summary ───────────────────────────────────────────────
echo ""
echo "============================================="
echo -e "  ${GREEN}Configuración Local Completada${NC}"
echo "============================================="
echo ""
echo "  Base de datos: $DATABASE_URL"
echo "  Archivo .env:  $ENV_FILE"
echo ""
echo "  Para iniciar en modo local:"
echo "    cp .env.local .env"
echo "    npm start"
echo ""
echo "  El sistema estará disponible en:"
echo "    http://localhost:3000"
echo ""
