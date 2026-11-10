# Quill recognition service

The one server-side piece of Quill. It turns an uploaded resume into a
structured draft with UniSound's `u2-ocr` and `u2-flash` models, and returns the
draft to the extension or workbench. Everything else in Quill still runs on the
person's device.

The platform key lives only here, in `UNISOUND_API_KEY`. It is never sent to the
browser, written to storage, or logged.

## What it does with a file

| Input | Path |
| --- | --- |
| Digital PDF | Text layer is reconstructed locally on the server; images are not OCR'd. |
| Scanned / image PDF | Pages are rendered to PNG (2.5×) and read by `u2-ocr`. |
| PNG / JPG | Read by `u2-ocr`. |
| DOCX / TXT / Markdown | The client extracts text locally and posts only the text. |

The resulting text goes to `u2-flash` with a JSON Schema. Its output is
validated and normalised before it is returned: company names cannot become
schools, non-discipline strings cannot become majors, dates and contact details
are shape-checked, and duplicate awards are merged. Problems are returned as
`warnings` for the person to review.

No files, drafts or text are persisted. Request logs contain only a request id,
mode, source, page count and elapsed time.

## Requirements

- Node.js 20.11 or newer
- A UniSound MaaS key with access to `u2-ocr` and `u2-flash`

## Run locally

From the repository root:

```bash
npm install
cp server/.env.example server/.env   # then put the key in server/.env
node server/src/index.mjs
```

`npm run dev:server` does the same from the root.

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

```json
{
  "ok": true,
  "service": "quill-resume",
  "version": "0.1.3",
  "modelConfigured": true,
  "models": { "ocr": "u2-ocr", "structure": "u2-flash" },
  "betaRequired": true,
  "betaOk": true,
  "limits": { "maxUploadMb": 24, "timeoutMs": 180000, "dailyLimit": 200 }
}
```

`betaRequired` is true when `QUILL_BETA_CODE` / `QUILL_BETA_CODES` is
configured. Health stays public; `betaOk` reports whether the request's
`X-Quill-Beta` header matched.

## API

### `POST /api/resume/extract?mode=auto`

Modes:

- `auto` — use the PDF text layer when it has enough text, otherwise OCR.
- `ocr` — force OCR even when the PDF has text (the workbench's “OCR 重读”).
- `text` — never OCR; reject a PDF with no usable text.

When `QUILL_BETA_CODE` (or `QUILL_BETA_CODES`) is configured, every extraction
request must also send `X-Quill-Beta: <code>`. Health remains public so the
workbench can show whether the server is reachable and whether a code is
required.

Binary upload (the browser sends the file directly):

```bash
curl -X POST "http://127.0.0.1:8787/api/resume/extract?mode=auto" \
  -H "Content-Type: application/pdf" \
  -H "X-Quill-Filename: resume.pdf" \
  --data-binary @resume.pdf
```

Text upload (DOCX/TXT already extracted by the client):

```bash
curl -X POST "http://127.0.0.1:8787/api/resume/extract" \
  -H "Content-Type: application/json" \
  -d '{"text":"...","filename":"resume.txt"}'
```

Uploads are raw bytes, not `multipart/form-data`. The limit is 24 MB by default.

Success:

```json
{
  "ok": true,
  "source": "text",
  "pageCount": 1,
  "text": "…",
  "draft": {
    "identity": { "fullName": "…" },
    "contact": { "phone": "…", "email": "…" },
    "preference": { "position": "…", "cities": [], "jobType": "实习" },
    "education": [],
    "experience": [],
    "projects": [],
    "skills": { "items": [], "certificates": [], "awards": [], "interests": [] }
  },
  "warnings": [],
  "usage": { "ocr": null, "structure": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 } },
  "requestId": "1a2b3c4d"
}
```

Failure:

```json
{ "ok": false, "error": { "code": "MODEL_RATE_LIMIT", "message": "…" }, "requestId": "1a2b3c4d" }
```

Error codes: `MODEL_NOT_CONFIGURED`, `MODEL_UNAUTHORIZED`, `MODEL_QUOTA`,
`MODEL_RATE_LIMIT`, `MODEL_UNAVAILABLE`, `MODEL_UNREACHABLE`, `OCR_BAD_FILE`,
`OCR_EMPTY`, `PDF_WITHOUT_TEXT`, `FILE_TOO_LARGE`, `UNSUPPORTED_FILE`,
`BETA_REQUIRED`, `BETA_INVALID`, `DAILY_LIMIT`, `TIMEOUT`, `SERVER_BUSY`,
`RATE_LIMIT`, `INTERNAL`.

## Deployment notes

Keep the process on loopback and put Nginx (or another proxy) in front:

```nginx
server {
  server_name api.example.com;

  client_max_body_size 25m;

  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_read_timeout 200s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

Then set:

```bash
HOST=127.0.0.1
QUILL_ALLOWED_ORIGINS=chrome-extension://<extension-id>,https://your-workbench.example
TRUST_PROXY=1
QUILL_BETA_CODE=quill-beta-...
QUILL_DAILY_LIMIT=200
UNISOUND_API_KEY=...
```

If the service is published directly, set `HOST=0.0.0.0` and a firewall rule
that only allows the intended origins. There is no user authentication: quota
protection is the per-IP rate limit plus the concurrency cap, so do not expose
it anonymously at scale.

Systemd example:

```ini
[Unit]
Description=Quill recognition service
After=network.target

[Service]
WorkingDirectory=/opt/quill/server
EnvironmentFile=/opt/quill/server/.env
ExecStart=/usr/bin/node src/index.mjs
Restart=on-failure
User=quill

[Install]
WantedBy=multi-user.target
```
