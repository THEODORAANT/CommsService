import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
//import fetch from "node-fetch";
import { q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";
import { config } from "../config.js";

export const perchOrders = Router();

const authedHandler =
    (handler: (req: AuthedRequest, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(handler(req as AuthedRequest, res)).catch(next);
    };

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

const OrderCreateSchema = z.object({
    customerId: z.string().min(1),
    items: z.array(
        z.object({
            productId: z.string().min(1),
            quantity: z.number().int().positive()
        })
    ).min(1),
    shipping: z.object({
        addressLine1: z.string().min(1),
        addressLine2: z.string().optional().nullable(),
        city: z.string().min(1),
        postCode: z.string().min(1),
        country: z.string().min(1)
    }),
    assessment: z.array(
        z.object({
            question: z.string().min(1),
            answer: z.string().min(1)
        })
    ).optional(),
    notes: z.string().optional().nullable()
});

type PharmacyOrderCreateResponse = {
    success: boolean;
    orderNumber?: string;
};

type PharmacyOrderNoteResponse = {
    success: boolean;
    message?: string;
    note?: {
        _id?: string;
        content?: string;
        type?: string;
        author?: string;
        createdAt?: string;
    };
    pharmacy_note_id?: string;
    thread_id?: string;
};

const pharmacyNoteTypeMap: Record<string, string> = {
    admin_note: "ADMIN",
    clinical_note: "CLINICAL"
};

async function createPharmacyOrderNote(payload: {
    orderNumber: string;
    body: string;
    type: string;
    author?: string | null;
}): Promise<PharmacyOrderNoteResponse> {
    const resp = await fetch(`${config.pharmacyApiBaseUrl}/api/orders/${payload.orderNumber}/notes`, {
        method: "POST",
        headers: {
            "x-api-key": config.pharmacyApiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            body: payload.body,
            type: payload.type,
            author: payload.author ?? undefined
        })
    });

    if (!resp.ok) {
        throw new Error(`Pharmacy API error: ${resp.status}`);
    }

    return (await resp.json()) as PharmacyOrderNoteResponse;
}

async function createPharmacyOrder(payload: z.infer<typeof OrderCreateSchema>): Promise<string> {
    const resp = await fetch(`${config.pharmacyApiBaseUrl}/api/orders/create`, {
        method: "POST",
        headers: {
            "x-api-key": config.pharmacyApiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        throw new Error(`Pharmacy API error: ${resp.status}`);
    }

    const data = (await resp.json()) as PharmacyOrderCreateResponse;
    const orderNumber = data?.orderNumber;
    if (!orderNumber) {
        throw new Error("Pharmacy API missing orderNumber");
    }

    return orderNumber;
}

perchOrders.post(
    "/v1/perch/orders/:orderID/create",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const orderID = Number(req.params.orderID);
        const idem = req.header("Idempotency-Key") || undefined;

        const body = OrderCreateSchema.parse(req.body);
        const endpoint = "/v1/perch/orders/:orderID/create";

        const { replayed, result } = await withIdempotency(tenant_id, endpoint, idem, { orderID, ...body }, async () => {
            const memberRows = await q<any>(
                `SELECT memberID FROM members WHERE tenant_id=:tenant_id AND pharmacy_patient_ref=:customerId`,
                { tenant_id, customerId: body.customerId }
            );
            if (!memberRows.length) {
                const err: any = new Error("Member not found for customerId. Link member with pharmacy_patient_ref first.");
                err.status = 422;
                throw err;
            }
            const memberID = Number(memberRows[0].memberID);

            const pharmacyOrderNumber = await createPharmacyOrder(body);

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
                    memberID,
                    pharmacy_order_ref: pharmacyOrderNumber,
                    status: null
                }
            );

            await emitEvent(tenant_id, "order.link.updated", { orderID, memberID });

            return { ok: true, orderNumber: pharmacyOrderNumber };
        });

        res.setHeader("X-Idempotency-Replayed", String(replayed));
        res.status(201).json(result);
    })
);

perchOrders.post(
    "/v1/perch/orders/:orderID/link",
    authedHandler(async (req, res) => {
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
        res.json({ ok: true,pharmacy_order_ref:body.pharmacy_order_ref });
    })
);

perchOrders.get(
    "/v1/perch/orders/:orderID/notes",
    authedHandler(async (req, res) => {
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

        res.json({
            items: notes.map((n: any) => ({ ...n, replies: repliesBy.get(n.note_id) || [] })),
            next_cursor: null
        });
    })
);

perchOrders.post(
    "/v1/perch/orders/:orderID/notes",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const orderID = Number(req.params.orderID);
        const idem = req.header("Idempotency-Key") || undefined;

        const body = NoteCreateSchema.parse(req.body);
        const endpoint = "/v1/perch/orders/:orderID/notes";

        const { replayed, result } = await withIdempotency(tenant_id, endpoint, idem, { orderID, ...body }, async () => {
            const rows = await q<any>(
                `SELECT memberID, pharmacy_order_ref FROM orders WHERE tenant_id=:tenant_id AND orderID=:orderID`,
                { tenant_id, orderID }
            );
            if (!rows.length) {
                const err: any = new Error("Order is not linked. Call POST /v1/perch/orders/{orderID}/link first.");
                err.status = 400;
                throw err;
            }
            const memberID = Number(rows[0].memberID);
            const pharmacyOrderRef = rows[0].pharmacy_order_ref as string | null;
            if (!pharmacyOrderRef) {
                const err: any = new Error("Order is missing pharmacy_order_ref. Link the order with pharmacy_order_ref first.");
                err.status = 422;
                throw err;
            }

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

            const pharmacyResponse = await createPharmacyOrderNote({
                orderNumber: pharmacyOrderRef,
                body: body.body,
                type: pharmacyNoteTypeMap[body.note_type] ?? "ADMIN",
                author: body.created_by.display_name ?? body.created_by.user_id ?? body.created_by.role
            });

            return {
                note_id,
                thread_root_id: note_id,
                scope: "order",
                memberID,
                orderID,
                note_type: body.note_type,
                status,
                created_at: new Date().toISOString(),
                pharmacy_note_id: pharmacyResponse.pharmacy_note_id ?? pharmacyResponse.note?._id ?? null,
                pharmacy_thread_id: pharmacyResponse.thread_id ?? null
            };
        });

        res.setHeader("X-Idempotency-Replayed", String(replayed));
        res.status(201).json(result);
    })
);
