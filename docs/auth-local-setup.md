# Auth + App DB — local setup

## 1. Postgres app

**Windows — PostgreSQL cài sẵn (khuyến nghị nếu không có Docker):**  
→ [auth-local-setup-windows-postgres.md](./auth-local-setup-windows-postgres.md)

```powershell
cd be
.\scripts\setup-app-db-windows.ps1
npm run prisma:migrate:app
npm run seed:app
```

Connection: `postgresql://sourcing:sourcing_dev@localhost:5432/sourcing_app_local`

**Docker (tùy chọn):**

```bash
cd be
docker compose up -d
```

Connection: `postgresql://sourcing:sourcing_dev@localhost:5433/sourcing_app_local`

## 2. Environment

Copy `.env.example` → `.env` and set:

- `DATABASE_URL` — existing crawl DB (read-only)
- `DATABASE_URL_APP` — Docker URL above
- `ADMIN_BOOTSTRAP_EMAIL` — your Google account email (first admin)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `AUTH_JWT_SECRET` — e.g. `openssl rand -hex 32`

## 3. Google Cloud Console

1. Create OAuth 2.0 Client ID (Web application).
2. Authorized redirect URI: `http://localhost:3001/api/auth/google/callback`
3. Paste client id/secret into `.env`.

## 4. Migrate + seed app DB

```bash
npm run prisma:migrate:app
npm run seed:app
```

## 5. Run

```bash
# Terminal 1 — BE
npm run dev

# Terminal 2 — FE (../fe)
npm run dev
```

Open http://localhost:5173 → redirects to login.

## 6. Smoke test

1. Login with `ADMIN_BOOTSTRAP_EMAIL` → full access + Admin menu.
2. Login with another Google account → `/waiting`.
3. Admin → `/admin/users` → approve user and grant tabs.
4. Edit a library on `/libraries` → data persists in app DB.

## Phase 2 (company DB server)

Change only `DATABASE_URL_APP` to the remote host, then:

```bash
npm run prisma:migrate:app:deploy
npm run seed:app
```
