# WarenVault

Self-hosted media storage with accounts, image optimization and a web dashboard.
Node.js + Express, SQLite, and local-disk or MinIO file storage.

## What it does

- **Accounts**: register and log in, JWT-authenticated API, per-user files.
- **Images** (JPEG, PNG, GIF, WebP): sharpened, lightly saturated and normalized, then
  re-encoded with Sharp. If the result would be larger than the original, the original
  bytes are stored instead, so a stored file is never bigger than what you uploaded.
  Already-compressed photos often come back unchanged ("Original kept").
- **Videos** (MP4, WebM, MOV, AVI): stored as-is. They are not re-encoded.
- **Storage**: local disk by default, or MinIO when it is configured and reachable.
- **Dashboard**: upload, list, download and delete files, with real size statistics.
- **Hardening**: helmet headers, rate limiting, input sanitising, upload type checks,
  and no source files or database served over HTTP.

## Quick start

Requires Node.js 22 or newer.

```bash
git clone https://github.com/waren23greg-stack/media-storage-advanced.git
cd media-storage-advanced
npm install
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('hex'))" > .env
npm start
```

Open http://localhost:5000, then use the Register tab to create an account.
The server refuses to start without `JWT_SECRET`.

## Configuration

Set these in `.env` locally or in your host's environment settings (see `.env.example`).

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Required. Signs login tokens and local file links. |
| `PORT` | HTTP port, default 5000. |
| `JWT_EXPIRE` | Token lifetime, default 7d. |
| `DB_PATH` | SQLite file, default `./warenvault.db`. |
| `STORAGE_DIR` | Local file storage folder, default `./storage`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_USERNAME` | Optional. Create a first account on startup. |
| `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_USE_SSL` | Optional. Use MinIO instead of local disk. All three of endpoint and both keys must be set. |

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/register` | no | Create an account, returns a token. |
| `POST /auth/login` | no | Log in, returns a token. |
| `GET /auth/me` | yes | Current user and usage. |
| `POST /upload` | yes | Upload one file (field name `file`, up to 500 MB). |
| `GET /files` | yes | List your files with fresh links. |
| `GET /download/:uuid` | yes | Download a file you own. |
| `DELETE /delete/:uuid` | yes | Delete a file you own. |
| `GET /stats` | yes | Totals and average size reduction. |
| `GET /media/*` | signed link | Serves local-disk files through expiring signed links. |
| `GET /health` | no | Status and active storage mode. |

Send the token as `Authorization: Bearer <token>`.

## Deployment notes

- On hosts with an ephemeral disk (for example Render's free plan), the database and
  uploaded files are wiped on every deploy or restart. For real use, attach a persistent
  disk and point `DB_PATH` and `STORAGE_DIR` into it, or use a hosted MinIO.
- Use one storage mode per deployment. Files saved to local disk are not visible to MinIO
  and the reverse.
- `media-storage-client.js` is a small JavaScript client for the API.

## License

MIT, see LICENSE.
