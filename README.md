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
