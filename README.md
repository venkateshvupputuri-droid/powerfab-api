# PowerFab API

A REST API for tracking fabrication model instances with QR codes. Each instance receives a unique QR identifier, a PNG endpoint, and a browser-friendly print label. Scanning a QR code resolves the instance; a mobile app can then call the status endpoint.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run db:push
npm run db:seed
npm run dev
```

The API runs at `http://localhost:3000`.

## Deploy to Render

The repository includes `render.yaml`. In Render, choose **New > Blueprint**, connect the GitHub repository, and apply the blueprint. It creates a web service with a persistent 1 GB disk for SQLite. After deployment, use the generated service URL as the live API URL.

To publish this repository to GitHub from PowerShell after creating `venkateshvupputuri-droid/powerfab-api`:

```powershell
git remote add origin https://github.com/venkateshvupputuri-droid/powerfab-api.git
git push -u origin main
```

## Endpoints

- `GET /health` - health check
- `GET /api/statuses` - available fabrication statuses
- `GET /api/instances` - list instances; optional `?status=IN_PROGRESS`
- `POST /api/instances` - create an instance
- `GET /api/instances/:id-or-qr-code` - retrieve an instance
- `PATCH /api/instances/:id-or-qr-code/status` - update status after a QR scan
- `GET /api/instances/:id-or-qr-code/history` - status history
- `GET /api/instances/:id-or-qr-code/qr` - QR PNG for app display or download
- `GET /api/instances/:id-or-qr-code/print` - printable HTML QR label

Create an instance:

```json
{
  "modelNumber": "PF-1004",
  "name": "Stair Stringer",
  "description": "North stair stringer",
  "location": "Bay 3"
}
```

Update status using the QR code printed on the instance:

```http
PATCH /api/instances/<qrCode>/status
Content-Type: application/json
```

```json
{
  "status": "IN_PROGRESS",
  "note": "Cutting complete",
  "updatedBy": "operator-12"
}
```

Statuses are `PLANNED`, `IN_PROGRESS`, `QUALITY_CHECK`, `READY`, `COMPLETED`, and `ON_HOLD`. The API currently accepts any status transition and records every change in `StatusHistory`; workflow-specific transition rules can be added when your shop process is finalized.
