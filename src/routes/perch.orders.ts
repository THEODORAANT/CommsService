import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";

export const perchOrders = Router();

const ActorSchema = z.object({
    role: z.enum(["admin","pharmacist","patient","system"]),
    user_id: z.string().optional(),
    display_name: z.string().optional()
});

const NoteCreateSchema = z.object({
    note_type: z.enum(["admin_note","clinical_note"]),
    title: z.string().optional().nullable(),
    body: z.string().min(1),
    status: z.enum(["open","resolved","archived"]).optional(),
    created_by: ActorSchema,
    external_note_ref: z.string().optional().nullable()
});

const OrderLinkSchema = z.object({
    memberID: z.number().int(),
    pharmacy_order_ref: z.string().optional().nullable(),
    status: z.string().optional().nullable()
});

perchOrders.post("/v1/perch/orders/:orderID/link", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const orderID = Number(req.params.orderID);
    const body = OrderLinkSchema.parse(req.body);

    await q(
        `INSERT INTO members(tenant_id, memberID)
     VALUES (:tenant_id, :memberID)
     ON DUPLICATE KEY UPDATE memberID=memberID`,
        { tenant_id, memberID: body.memberID }
    );

    await q(
        `INSERT INTO orders(tenant_id, orderID, memberID, pharmacy_order_ref, status)
     VALUES (:tenant_id, :orderID, :memberID, :pharmacy_order_ref, :status)
     ON DUPLICATE KEY UPDATE
       memberID=VALUES(memberID),
       pharmacy_order_ref=COALESCE(VALUES(pharmacy_order_ref), pharmacy_order_ref),
       status=COALESCE(VALUES(status), status),
       updated_at=CURRENT_TIMESTAMP(3)`,
        {
            tenant_id,
            orderID,
            memberID: body.memberID,
            pharmacy_order_ref: body.pharmacy_order_ref ?? null,
            status: body.status ?? null
        }
    );

    await emitEvent(tenant_id, "order.link.updated", { orderID, memberID: body.memberID });
    res.json({ ok: true });
});

perchOrders.get("/v1/perch/orders/:orderID/notes", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const orderID = Number(req.params.orderID);

    const notes = await q<any>(
        `SELECT * FROM notes
     WHERE tenant_id=:tenant_id AND orderID=:orderID AND scope='order'
     ORDER BY created_at DESC
     LIMIT 200`,
        { tenant_id, orderID }
    );

    const noteIds = notes.map((n: any) => n.note_id);
    let replies: any[] = [];
    if (noteIds.length) {
        // build IN list safely
        const placeholders = noteIds.map((_: any, i: number) => `:id${i}`).join(",");
        const params: any = { tenant_id };
        noteIds.forEach((id: string, i: number) => (params[`id${i}`] = id));
        replies = await q<any>(
            `SELECT * FROM note_replies
       WHERE tenant_id=:tenant_id AND note_id IN (${placeholders})
       ORDER BY created_at ASC`,
            params
        );
    }

    const repliesBy = new Map<string, any[]>();
    for (const r of replies) {
        const arr = repliesBy.get(r.note_id) || [];
        arr.push(r);
        repliesBy.set(r.note_id, arr);
    }

    res.json({ items: notes.map((n: any) => ({ ...n, replies: repliesBy.get(n.note_id) || [] })), next_cursor: null });
});

perchOrders.post("/v1/perch/orders/:orderID/notes", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const orderID = Number(req.params.orderID);
    const idem = req.header("Idempotency-Key") || undefined;

    const body = NoteCreateSchema.parse(req.body);
    const endpoint = "/v1/perch/orders/:orderID/notes";

    const { replayed, result } = await withIdempotency(tenant_id, endpoint, idem, { orderID, ...body }, async () => {
        const rows = await q<any>(
            `SELECT memberID FROM orders WHERE tenant_id=:tenant_id AND orderID=:orderID`,
            { tenant_id, orderID }
        );
        if (!rows.length) {
            const err: any = new Error("Order is not linked. Call POST /v1/perch/orders/{orderID}/link first.");
            err.status = 400;
            throw err;
        }
        const memberID = Number(rows[0].memberID);

        const note_id = crypto.randomUUID();
        const status = body.status ?? "open";

        await q(
            `INSERT INTO notes(
        note_id, tenant_id, scope, memberID, orderID,
        note_type, title, body, status,
        created_by_role, created_by_user_id, created_by_display_name, external_note_ref
      ) VALUES (
        :note_id, :tenant_id, 'order', :memberID, :orderID,
        :note_type, :title, :body, :status,
        :c_role, :c_uid, :c_name, :ext
      )`,
            {
                note_id,
                tenant_id,
                memberID,
                orderID,
                note_type: body.note_type,
                title: body.title ?? null,
                body: body.body,
                status,
                c_role: body.created_by.role,
                c_uid: body.created_by.user_id ?? null,
                c_name: body.created_by.display_name ?? null,
                ext: body.external_note_ref ?? null
            }
        );

        await emitEvent(tenant_id, "note.created", { note_id, memberID, orderID, scope: "order" });

        return { note_id, thread_root_id: note_id, scope: "order", memberID, orderID, note_type: body.note_type, status, created_at: new Date().toISOString() };
    });

    res.setHeader("X-Idempotency-Replayed", String(replayed));
    res.status(201).json(result);
});
