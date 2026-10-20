#!/usr/bin/env bash
# Crea una base de datos desechable, aplica la réplica de Supabase, todas las
# migraciones y ejecuta las pruebas SQL de supabase/tests/*.test.sql.
#
# Requiere psql y un usuario con permiso para crear bases de datos.
# Variables: PGHOST, PGPORT, PGUSER, PGPASSWORD (las estándar de libpq).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="guardia_test_$$"
PSQL=(psql -X -q -t -v ON_ERROR_STOP=1 --no-psqlrc -d "$DB")

cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

createdb "$DB"
# Los roles son globales al servidor: se crean una vez y se reutilizan.
psql -X -q -d "$DB" -tc "select 1 from pg_roles where rolname = 'authenticated'" | grep -q 1 \
  && sed '/^create role/d' "$ROOT/supabase/tests/support/supabase_stub.sql" | "${PSQL[@]}" \
  || "${PSQL[@]}" -f "$ROOT/supabase/tests/support/supabase_stub.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -f "$f"
done
"${PSQL[@]}" -f "$ROOT/supabase/tests/support/helpers.sql"

pass=0; fail=0
for t in "$ROOT"/supabase/tests/*.test.sql; do
  name="$(basename "$t")"
  # Cada fichero corre en su propia transacción y se deshace al terminar.
  if out="$( { echo 'begin;'; cat "$t"; echo 'rollback;'; } | "${PSQL[@]}" 2>&1)"; then
    pass=$((pass + 1))
    checks="$(echo "$out" | grep -c 'NOTICE:  ok - ' || true)"
    echo "ok - $name ($checks comprobaciones)"
    if [ -n "${VERBOSE:-}" ]; then echo "$out" | grep -o 'ok - .*' | sed 's/^/    /'; fi
  else
    fail=$((fail + 1))
    echo "not ok - $name"
    echo "$out" | grep -E 'NOTICE:  ok - |ERROR|FALLO|DETAIL|CONTEXT' | tail -6 | sed 's/^/    /'
  fi
done
echo "# db tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
