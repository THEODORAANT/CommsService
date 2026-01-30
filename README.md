# Comms Service (MySQL, no Redis)

Perch-native Notes + Threaded Replies + 3-way Chat keyed by memberID and orderID.

## Setup
1) Run `src/sql/001_init_mysql.sql` on MySQL 8

2) Copy `.env.example` to `.env` and fill values.

3) Install + run:
   npm i
   npm run build
   npm run start

## Webhooks (no Redis)
Option A (recommended): run worker loop
npm run worker

Option B: cron calls internal endpoint
curl -X POST "https://comms.example.com/v1/internal/process-webhooks?limit=100" \
-H "X-Worker-Key: <INTERNAL_WORKER_KEY>"

## Perch integration
Link orders before order-scoped notes:
POST /v1/perch/orders/{orderID}/link
{ "memberID": 376, "status": "paid" }
