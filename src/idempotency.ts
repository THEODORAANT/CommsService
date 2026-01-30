import crypto from "crypto";
import { q } from "./db.js";

export function sha256(obj: any): string {
    const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
    return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function withIdempotency<T>(
    tenant_id: string,
    endpoint: string,
    idemKey: string | undefined,
    requestBody: any,
    handler: () => Promise<T>
): Promise<{ replayed: boolean; result: T }> {
    if (!idemKey) return { replayed: false, result: await handler() };

    const request_hash = sha256(requestBody);

    const rows = await q<{ request_hash: string; response_body: any }>(
        `SELECT request_hash, response_body
     FROM idempotency_keys
     WHERE tenant_id=:tenant_id AND endpoint=:endpoint AND idempotency_key=:idk`,
        { tenant_id, endpoint, idk: idemKey }
    );

    if (rows.length) {
        if (rows[0].request_hash !== request_hash) {
            const err: any = new Error("Idempotency key reuse with different payload");
            err.status = 409;
            throw err;
        }
        return { replayed: true, result: rows[0].response_body as T };
    }

    const result = await handler();

    await q(
        `INSERT INTO idempotency_keys(tenant_id, endpoint, idempotency_key, request_hash, response_body)
     VALUES (:tenant_id, :endpoint, :idk, :rh, CAST(:rb AS JSON))`,
        { tenant_id, endpoint, idk: idemKey, rh: request_hash, rb: JSON.stringify(result) }
    );

    return { replayed: false, result };
}
