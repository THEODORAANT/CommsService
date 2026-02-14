# Pharmacy Webhooks: Notes & Chat Replies

This guide describes how Comms Service processes queued note events for Pharmacy and forwards eligible events to the Pharmacy Add Order Note API.

## System flow diagram

```mermaid
flowchart LR
    Perch[Perch / Admin UI] -->|Create note / reply| Comms[Comms Service API]
    Comms -->|emitEvent| Queue[(webhook_deliveries)]
    Worker[Webhook worker / internal endpoint] -->|processWebhookBatch| Queue
    Queue -->|POST /api/orders/{orderNumber}/notes| Pharmacy[Pharmacy API]
    Comms -->|read notes/replies + member email| Comms
```

## 1) Subscription setup

Create a webhook subscription for the tenant with `subscriber_system = 'pharmacy'`. The service reads subscriptions from the `webhook_subscriptions` table and delivers queued events via the worker or internal endpoint.

**Example SQL**

```sql
INSERT INTO webhook_subscriptions (
  subscription_id,
  tenant_id,
  subscriber_system,
  url,
  secret,
  event_types,
  enabled
) VALUES (
  UUID(),
  'tenant-123',
  'pharmacy',
  'https://pharmacy.example.com/webhooks/comms',
  'replace-with-shared-secret',
  JSON_ARRAY('note.created', 'note.reply.created'),
  1
);
```

## 2) Pharmacy API request

For `subscriber_system = 'pharmacy'`, Comms Service calls Pharmacy's Add Order Note API:

* `POST /api/orders/{orderNumber}/notes`
* Headers:
  * `x-api-key: <PHARMACY_API_KEY>`
  * `Content-Type: application/json`
* Body:

```json
{
  "body": "Patient requires follow-up call.",
  "type": "ADMIN",
  "author": "Dr. Smith"
}
```

`type` is mapped from Comms `note_type`:

* `admin_note` -> `ADMIN`
* `clinical_note` -> `CLINICAL`

## 3) Event eligibility

Only order-scoped `note.created` events are forwarded to Pharmacy. Other events (including patient-scoped notes and reply events) are intentionally skipped.

## 4) Order number resolution

Pharmacy `orderNumber` is resolved from `orders.pharmacy_order_ref` using the event's `orderID`. If an order is missing `pharmacy_order_ref`, delivery fails and retries according to normal webhook retry rules.

## 5) Delivery & retries

Webhook deliveries are queued and retried with exponential-ish backoff until success or max attempts. If the Pharmacy endpoint returns a non-2xx response, delivery will be retried automatically.

## 6) Operational notes

* Pharmacy deliveries only process order-scoped `note.created` events and send them to `/api/orders/{orderNumber}/notes`.
* If you only want admin notes, set `PHARMACY_ONLY_ADMIN_NOTES=true` (default).
* Make sure linked orders have `orders.pharmacy_order_ref` populated or delivery will fail with a 422-style error.

## 7) Media availability check webhook

Comms Service also exposes a Pharmacy-protected endpoint to check whether a customer has media ready:

* `POST /api/customers/media/check`
* Headers:
  * `x-api-key: <PHARMACY_API_KEY>`
* Body:

```json
{
  "email": "customer@example.com",
  "since": "2026-01-10T00:00:00.000Z"
}
```

`since` is optional. When provided, only media uploaded after that timestamp is returned.

Example response:

```json
{
  "success": true,
  "email": "customer@example.com",
  "has_media": true,
  "media_count": 1,
  "media": [
    {
      "document_id": "3e1f0a4d-a388-4f95-9a90-b6f91942e0ca",
      "url": "https://...",
      "description": "script.jpg",
      "source_type": "file",
      "uploaded_at": "2026-01-10T10:00:00.000Z"
    }
  ]
}
```
