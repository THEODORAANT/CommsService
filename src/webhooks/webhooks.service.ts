import crypto from "crypto";
import { q } from "../db.js";
import { config } from "../config.js";

export function signWebhook(secret: string, rawBody: string): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export async function emitEvent(tenant_id: string, event_type: string, data: any) {
    const subs = await q<any>(
        `SELECT subscription_id, url, secret, event_types
     FROM webhook_subscriptions
     WHERE tenant_id=:tenant_id AND enabled=1`,
        { tenant_id }
    );

    for (const s of subs) {
        const eventTypes: string[] = JSON.parse(s.event_types);
        if (!eventTypes.includes(event_type)) continue;

        const event_id = crypto.randomUUID();
        const delivery_id = crypto.randomUUID();
        const payload = {
            event_id,
            event_type,
            occurred_at: new Date().toISOString(),
            tenant_id,
            data
        };

        await q(
            `INSERT INTO webhook_deliveries(
         delivery_id, tenant_id, subscription_id, event_id, event_type, payload,
         status, attempt_count, next_attempt_at
       ) VALUES (
         :delivery_id, :tenant_id, :subscription_id, :event_id, :event_type, CAST(:payload AS JSON),
         'pending', 0, CURRENT_TIMESTAMP(3)
       )`,
            {
                delivery_id,
                tenant_id,
                subscription_id: s.subscription_id,
                event_id,
                event_type,
                payload: JSON.stringify(payload)
            }
        );
    }
}

export function computeNextAttempt(attempt: number): number {
    // seconds (exponential-ish): 5, 15, 60, 300, 900, 3600...
    const schedule = [5, 15, 60, 300, 900, 3600, 21600, 86400];
    return schedule[Math.min(attempt, schedule.length - 1)];
}

export async function processWebhookBatch(limit = 50) {
    // lock due deliveries to avoid double-processing (simple "locked_until" lease)
    const lockSeconds = config.webhookLockSeconds;

    // Select due, unlocked deliveries
    const due = await q<any>(
        `SELECT d.delivery_id
     FROM webhook_deliveries d
     WHERE d.status='pending'
       AND d.next_attempt_at <= CURRENT_TIMESTAMP(3)
       AND (d.locked_until IS NULL OR d.locked_until < CURRENT_TIMESTAMP(3))
     ORDER BY d.next_attempt_at ASC
     LIMIT ${Number(limit)}`,
        {}
    );

    for (const row of due) {
        const delivery_id = row.delivery_id as string;

        // Acquire lock
        const locked = await q<any>(
            `UPDATE webhook_deliveries
       SET locked_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL :lockSeconds SECOND)
       WHERE delivery_id=:delivery_id
         AND status='pending'
         AND (locked_until IS NULL OR locked_until < CURRENT_TIMESTAMP(3))`,
            { delivery_id, lockSeconds }
        );

        // mysql2 returns OkPacket differently; easiest is to just re-read and ensure it's locked by us
        const dRows = await q<any>(
            `SELECT d.*, s.url, s.secret
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.subscription_id=d.subscription_id
       WHERE d.delivery_id=:delivery_id`,
            { delivery_id }
        );
        if (!dRows.length) continue;
        const d = dRows[0];

        const rawBody = JSON.stringify(JSON.parse(d.payload));
        const sig = signWebhook(d.secret, rawBody);

        let ok = false;
        let errText: string | null = null;

        try {
            const resp = await fetch(d.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Event-Id": d.event_id,
                    "X-Event-Type": d.event_type,
                    "X-Event-Timestamp": new Date().toISOString(),
                    "X-Signature": `sha256=${sig}`
                },
                body: rawBody
            });
            ok = resp.ok;
            if (!ok) errText = `HTTP ${resp.status}`;
        } catch (e: any) {
            ok = false;
            errText = e?.message || "network error";
        }

        const nextAttemptSeconds = computeNextAttempt(Number(d.attempt_count) + 1);
        const willRetry = !ok && (Number(d.attempt_count) + 1) < config.webhookMaxAttempts;

        await q(
            `UPDATE webhook_deliveries
       SET status = :status,
           attempt_count = attempt_count + 1,
           last_attempt_at = CURRENT_TIMESTAMP(3),
           last_error = :last_error,
           next_attempt_at = CASE
             WHEN :willRetry = 1 THEN DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL :delaySec SECOND)
             ELSE next_attempt_at
           END,
           locked_until = NULL
       WHERE delivery_id = :delivery_id`,
            {
                delivery_id,
                status: ok ? "sent" : (willRetry ? "pending" : "failed"),
                last_error: ok ? null : errText,
                willRetry: willRetry ? 1 : 0,
                delaySec: nextAttemptSeconds
            }
        );
    }

    return { processed: due.length };
}
