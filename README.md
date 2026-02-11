# Comms Service (MySQL, no Redis)

Perch-native Notes + Threaded Replies + 3-way Chat keyed by memberID and orderID.

## Setup
1) Run `src/sql/001_init_mysql.sql` on MySQL 8

2) Create `.env` (you can copy from `comms-service-mysql/.env.example`) and fill values.

3) Install + run:
   npm i
   npm run build
   npm run start

## Webhooks (no Redis)
### Worker setup (recommended)
1) Build the project:
   ```bash
   npm i
   npm run build
   ```
2) Confirm required env vars are set (at minimum):
   * `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
   * `WEBHOOK_MAX_ATTEMPTS` (optional, default `10`)
   * `WEBHOOK_LOCK_SECONDS` (optional, default `30`)
   * `PHARMACY_API_BASE_URL`, `PHARMACY_API_KEY` (for pharmacy forwarding)
3) Start the worker loop:
   ```bash
   npm run worker
   ```

The worker continuously polls pending deliveries and processes batches every second.

### Run worker in production (systemd example)
```ini
[Unit]
Description=Comms Service Webhook Worker
After=network.target

[Service]
WorkingDirectory=/opt/comms-service
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/comms-service/.env

[Install]
WantedBy=multi-user.target
```
Then run:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now comms-worker
sudo systemctl status comms-worker
```

### Alternative: cron + internal endpoint
If you cannot run a long-lived process, trigger webhook processing via cron:
```bash
curl -X POST "https://comms.example.com/v1/internal/process-webhooks?limit=100" \
  -H "X-Worker-Key: <INTERNAL_WORKER_KEY>"
```
`INTERNAL_WORKER_KEY` must match `X-Worker-Key`.

## Perch integration
Link orders before order-scoped notes:
POST /v1/perch/orders/{orderID}/link
{ "memberID": 376, "status": "paid" }
PHARMACY_PUSH_NOTES: enable/disable pushing notes to Pharmacy

PHARMACY_ONLY_ADMIN_NOTES: if true, only push admin_note (typical requirement)
Pharmacy webhook processing only forwards order-scoped notes to Pharmacy Add Order Note API (`/api/orders/{orderNumber}/notes`).
node -e "
const jwt=require('jsonwebtoken');
console.log(jwt.sign(
{
tenant_id:'gwl-cy',
actor:{role:'admin',user_id:'cli',display_name:'CLI'},
iss:'perch',
aud:'comms-service'
},
'2wwTARwF19RYnS3POX/8UyP8eIKDhx2jjY479IeKGag=',
{ algorithm:'HS256', expiresIn:'1h' }
));
"

## Pharmacy webhooks
See [docs/pharmacy-webhooks.md](docs/pharmacy-webhooks.md) for Pharmacy-facing webhook subscription and payload details.
