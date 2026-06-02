# App DB trên Windows — PostgreSQL cài sẵn (không Docker)

## Bước 1 — Cài PostgreSQL

1. Tải installer: https://www.postgresql.org/download/windows/
2. Cài PostgreSQL **16** (hoặc 15+), nhớ mật khẩu user **`postgres`**.
3. Cổng mặc định: **5432**.
4. (Khuyến nghị) Tick **Stack Builder** không bắt buộc; quan trọng là service **postgresql-x64-16** đang chạy.

Thêm `psql` vào PATH (nếu terminal chưa nhận — bạn cài **PostgreSQL 18**):

```text
C:\Program Files\PostgreSQL\18\bin
```

Hoặc tạm trong session hiện tại:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\18\bin"
```

Script `npm run setup:app-db:windows` **tự tìm** `psql` trong `C:\Program Files\PostgreSQL\*\bin` nếu chưa có PATH.

Mở **PowerShell mới**, kiểm tra:

```powershell
psql --version
```

## Bước 2 — Tạo database app

Từ thư mục `be`:

```powershell
cd C:\Users\thanhnam.tran_ctv\Desktop\Sourcing\be
.\scripts\setup-app-db-windows.ps1
```

Nhập mật khẩu user `postgres` khi được hỏi.

**Hoặc thủ công (pgAdmin / psql):** mở file [`scripts/setup-app-db-windows.sql`](../scripts/setup-app-db-windows.sql) và chạy toàn bộ.

Kết quả:

- User: `sourcing` / password: `sourcing_dev`
- Database: `sourcing_app_local`

## Bước 3 — `.env`

```env
DATABASE_URL_APP=postgresql://sourcing:sourcing_dev@localhost:5432/sourcing_app_local

# Dev local (FE Vite)
CORS_ORIGIN=http://localhost:5173
AUTH_FRONTEND_URL=http://localhost:5173
AUTH_COOKIE_SECURE=false

ADMIN_BOOTSTRAP_EMAIL=your@gmail.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
AUTH_JWT_SECRET=<random-32-bytes-hex>
```

Giữ nguyên `DATABASE_URL` (crawl DB công ty).

## Bước 4 — Migrate + seed

```powershell
npm run prisma:migrate:app
npm run seed:app
```

(`prisma:migrate:app` dùng `migrate deploy` — không cần shadow DB. Nếu cần tạo migration mới: `npm run prisma:migrate:app:dev` sau khi user `sourcing` có quyền `CREATEDB`.)

## Bước 5 — Google OAuth

Console: https://console.cloud.google.com/apis/credentials

- Redirect URI: `http://localhost:3001/api/auth/google/callback`

## Bước 6 — Chạy app

```powershell
# be
npm run dev

# fe (terminal khác)
cd ..\fe
npm run dev
```

Mở http://localhost:5173

## Sửa lỗi thường gặp

| Lỗi | Cách xử lý |
|-----|------------|
| `psql` not recognized | Thêm PostgreSQL `bin` vào PATH |
| `password authentication failed` | Sai mật khẩu `postgres` hoặc user `sourcing` |
| `database does not exist` | Chạy lại `setup-app-db-windows.ps1` |
| `Can't reach database server` | Services → **postgresql-x64-16** → Start |
| BE: `DATABASE_URL_APP is required` | Thêm dòng vào `.env`, restart `npm run dev` |

## Docker (tùy chọn)

Nếu sau này cài Docker Desktop, có thể dùng `docker compose up -d` và đổi port sang **5433** — không bắt buộc khi đã dùng Postgres Windows.
