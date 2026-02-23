import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
//import fetch from "node-fetch";
import { ordersHasEscalateClinicalReviewColumn, pool, q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";
import { config } from "../config.js";
import { sendPharmacyRequest } from "../pharmacy.client.js";

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

const UpdateOrderStatusSchema = z.object({
    status: z.enum(["PENDING", "APPROVED", "CANCELLED", "REFUND"]),
    reason: z.string().trim().min(1).optional()
});

const orderLockedStatuses = new Set(["APPROVED", "PROCESSING", "REFUND"]);
const orderAllowedTransitions: Record<string, Set<string>> = {
    PAYMENT_RECEIVED: new Set(["PENDING", "CANCELLED"]),
    PENDING: new Set(["APPROVED"]),
    CANCELLED: new Set(["REFUND"])
};

type PharmacyOrderCreateResponse = {
    success: boolean;
    orderNumber?: string;
};

type PharmacyOrderStatusResponse = {
    success: boolean;
    orderNumber?: string;
    status?: string;
    message?: string;
};

async function ensureMemberExistsByCustomerId(tenant_id: string, customerId: string): Promise<number> {
    const existingRows = await q<{ memberID: number }>(
        `SELECT memberID
         FROM members
         WHERE tenant_id=:tenant_id
           AND pharmacy_patient_ref=:customerId
         LIMIT 1`,
        { tenant_id, customerId }
    );

    if (existingRows.length > 0) {
        return Number(existingRows[0].memberID);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            const [memberRows] = await connection.query<any[]>(
                `SELECT memberID
                 FROM members
                 WHERE tenant_id=:tenant_id
                   AND pharmacy_patient_ref=:customerId
                 LIMIT 1
                 FOR UPDATE`,
                { tenant_id, customerId }
            );

            if (memberRows.length > 0) {
                await connection.commit();
                return Number(memberRows[0].memberID);
            }

            const [maxRows] = await connection.query<any[]>(
                `SELECT COALESCE(MAX(memberID), 0) AS maxMemberID
                 FROM members
                 WHERE tenant_id=:tenant_id
                 FOR UPDATE`,
                { tenant_id }
            );

            const nextMemberID = Number(maxRows[0]?.maxMemberID ?? 0) + 1;

            await connection.query(
                `INSERT INTO members(tenant_id, memberID, pharmacy_patient_ref)
                 VALUES (:tenant_id, :memberID, :pharmacy_patient_ref)`,
                { tenant_id, memberID: nextMemberID, pharmacy_patient_ref: customerId }
            );

            await connection.commit();
            return nextMemberID;
        } catch (err: any) {
            await connection.rollback();

            if (err?.code === "ER_DUP_ENTRY") {
                continue;
            }

            throw err;
        } finally {
            connection.release();
        }
    }

    throw new Error("Failed to create member for customerId");
}

async function createPharmacyOrder(tenant_id: string, payload: z.infer<typeof OrderCreateSchema>): Promise<string> {
    const resp = await sendPharmacyRequest<PharmacyOrderCreateResponse>({
        tenant_id,
        operation: "create_order",
        method: "POST",
        path: "/api/orders/create",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        requestBodyForLog: payload
    });

    if (!resp.ok) {
        throw new Error(`Pharmacy API error: ${resp.status}`);
    }

    const data = (resp.bodyJson ?? {}) as PharmacyOrderCreateResponse;
    const orderNumber = data?.orderNumber;
    if (!orderNumber) {
        throw new Error("Pharmacy API missing orderNumber");
    }

    return orderNumber;
}

async function updatePharmacyOrderStatus(tenant_id: string, payload: {
    orderNumber: string;
    status: z.infer<typeof UpdateOrderStatusSchema>["status"];
}): Promise<PharmacyOrderStatusResponse> {
    const requestPayload = { status: payload.status };
    const resp = await sendPharmacyRequest<PharmacyOrderStatusResponse>({
        tenant_id,
        operation: "update_order_status",
        method: "PATCH",
        path: `/api/orders/${payload.orderNumber}/status`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        requestBodyForLog: requestPayload
    });

    if (!resp.ok) {
        throw new Error(`Pharmacy API error: ${resp.status}`);
    }

    return (resp.bodyJson ?? {}) as PharmacyOrderStatusResponse;
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
            const memberID = await ensureMemberExistsByCustomerId(tenant_id, body.customerId);

            const pharmacyOrderNumber = await createPharmacyOrder(tenant_id, body);

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
                    status: "PAYMENT_RECEIVED"
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

perchOrders.post(
    "/v1/perch/orders/:orderID/status",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const orderID = Number(req.params.orderID);
        const body = UpdateOrderStatusSchema.parse(req.body);

        if (!Number.isInteger(orderID) || orderID <= 0) {
            const err: any = new Error("Invalid orderID");
            err.status = 400;
            throw err;
        }

        if ((body.status === "CANCELLED" || body.status === "REFUND") && !body.reason) {
            const err: any = new Error("reason is required when status is CANCELLED or REFUND");
            err.status = 400;
            throw err;
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const [rows] = await connection.query<any[]>(
                `SELECT tenant_id, orderID, pharmacy_order_ref, status
                   FROM orders
                  WHERE tenant_id=:tenant_id AND orderID=:orderID
                  LIMIT 1
                  FOR UPDATE`,
                { tenant_id, orderID }
            );

            if (!rows.length) {
                const err: any = new Error("Order not found");
                err.status = 404;
                throw err;
            }

            const order = rows[0];
            const currentStatus = String(order.status ?? "").toUpperCase();
            const pharmacyOrderRef = order.pharmacy_order_ref as string | null;

            if (!pharmacyOrderRef) {
                const err: any = new Error("Order is missing pharmacy_order_ref.");
                err.status = 422;
                throw err;
            }

            if (orderLockedStatuses.has(currentStatus)) {
                const err: any = new Error(`Order status is locked from ${currentStatus}`);
                err.status = 409;
                throw err;
            }

            const validTargets = orderAllowedTransitions[currentStatus];
            if (!validTargets || !validTargets.has(body.status)) {
                const err: any = new Error(`Invalid status transition from ${currentStatus} to ${body.status}`);
                err.status = 409;
                throw err;
            }

            await connection.query(
                `UPDATE orders
                    SET status=:status,
                        updated_at=CURRENT_TIMESTAMP(3)
                  WHERE tenant_id=:tenant_id AND orderID=:orderID`,
                {
                    status: body.status,
                    tenant_id,
                    orderID
                }
            );

            await updatePharmacyOrderStatus(tenant_id, {
                orderNumber: pharmacyOrderRef,
                status: body.status
            });

            if (body.status === "PENDING") {
                await connection.query(
                    `INSERT INTO order_work_queue(tenant_id, orderID, order_number, status)
                     VALUES (:tenant_id, :orderID, :order_number, 'queued')
                     ON DUPLICATE KEY UPDATE
                       status='queued',
                       updated_at=CURRENT_TIMESTAMP(3)`,
                    {
                        tenant_id,
                        orderID,
                        order_number: pharmacyOrderRef
                    }
                );
            }

            if (body.status === "REFUND") {
                await connection.query(
                    `INSERT INTO order_assessment_status(tenant_id, orderID, order_number, status, refund_reason)
                     VALUES (:tenant_id, :orderID, :order_number, 'refunded', :refund_reason)
                     ON DUPLICATE KEY UPDATE
                       status='refunded',
                       refund_reason=VALUES(refund_reason),
                       updated_at=CURRENT_TIMESTAMP(3)`,
                    {
                        tenant_id,
                        orderID,
                        order_number: pharmacyOrderRef,
                        refund_reason: body.reason ?? null
                    }
                );
            }

            await connection.commit();
            res.json({
                ok: true,
                orderID,
                previousStatus: currentStatus,
                status: body.status
            });
        } catch (e) {
            await connection.rollback();
            throw e;
        } finally {
            connection.release();
        }
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
            const hasEscalateClinicalReviewColumn = await ordersHasEscalateClinicalReviewColumn();
            const escalateClinicalReviewSelect = hasEscalateClinicalReviewColumn
                ? "o.escalate_clinical_review"
                : "0 AS escalate_clinical_review";
            const rows = await q<any>(
                `SELECT o.memberID, ${escalateClinicalReviewSelect}
                 FROM orders o
                 WHERE o.tenant_id=:tenant_id AND o.orderID=:orderID`,
                { tenant_id, orderID }
            );
            if (!rows.length) {
                const err: any = new Error("Order is not linked. Call POST /v1/perch/orders/{orderID}/link first.");
                err.status = 400;
                throw err;
            }
            const memberID = Number(rows[0].memberID);
            const isEscalatedClinicalReview = Number(rows[0].escalate_clinical_review ?? 0) === 1;
            const shouldForwardToPharmacy = true;//isEscalatedClinicalReview || body.note_type === "admin_note" || body.note_type === "clinical_note";
            const note_id = crypto.randomUUID();
            const status = body.status ?? "open";

            await q(
                `INSERT INTO notes(
        note_id, tenant_id, scope, memberID, orderID,
        note_type, title, body, status,
        created_by_role, created_by_user_id, created_by_display_name, external_note_ref,escalate_clinical_review
      ) VALUES (
        :note_id, :tenant_id, 'order', :memberID, :orderID,
        :note_type, :title, :body, :status,
        :c_role, :c_uid, :c_name, :ext,:isEscalatedClinicalReview
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
                    ext: body.external_note_ref ?? null,
                    isEscalatedClinicalReview
                }
            );

            await emitEvent(tenant_id, "note.created", { note_id, memberID, orderID, scope: "order" });

            if (!shouldForwardToPharmacy) {
                return {
                    note_id,
                    memberID,
                    orderID,
                    scope: "order",
                    note_type: body.note_type,
                    title: body.title ?? null,
                    body: body.body,
                    status,
                    created_by: body.created_by,
                    external_note_ref: body.external_note_ref ?? null,
                    created_at: new Date().toISOString(),
                    pharmacy_note_id: null,
                    pharmacy_thread_id: null
                };
            }

            return {
                note_id,
                thread_root_id: note_id,
                scope: "order",
                memberID,
                orderID,
                note_type: body.note_type,
                status,
                created_at: new Date().toISOString(),
                pharmacy_note_id: null,
                pharmacy_thread_id: null
            };
        });

        res.setHeader("X-Idempotency-Replayed", String(replayed));
        res.status(201).json(result);
    })
);
