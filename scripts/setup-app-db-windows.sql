-- Chay bang superuser postgres: psql -U postgres -f scripts/setup-app-db-windows.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sourcing') THEN
    CREATE ROLE sourcing WITH LOGIN PASSWORD 'sourcing_dev' CREATEDB;
  ELSE
    ALTER ROLE sourcing WITH PASSWORD 'sourcing_dev' CREATEDB;
  END IF;
END
$$;
