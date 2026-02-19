import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db.js";
import { sendPharmacyRequest } from "../pharmacy.client.js";
import { processWebhookBatch } from "../webhooks/webhooks.service.js";

export const internalRoutes = Router();

const processWebhooksQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional()
});

const processWebhooksHandler = async (req: any, res: any, next: any) => {
    try {
        const key = req.header("X-Worker-Key");
        if (!key || key !== config.workerKey) return res.status(403).json({ error: "forbidden" });

        const { limit } = processWebhooksQuerySchema.parse(req.query);
        const result = await processWebhookBatch(limit ?? 50);
        return res.json(result);
    } catch (err) {
        return next(err);
    }
};

internalRoutes.post("/v1/internal/process-webhooks", processWebhooksHandler);
internalRoutes.get("/v1/internal/process-webhooks", processWebhooksHandler);

const updateOrderStatusPathSchema = z.object({
    orderNumber: z.string().regex(/^ORD-\d{4}-\d{5}$/)
});

const updateOrderStatusBodySchema = z.object({
    status: z.enum(["PENDING", "APPROVED", "CANCELLED", "REFUND"]),
    reason: z.string().trim().min(1).optional()
});

const updateCustomerByEmailPathSchema = z.object({
    email: z.string().email()
});

const updateCustomerByEmailBodySchema = z
    .object({
        name: z.string().trim().min(1).optional(),
        dob: z.string().trim().min(1).optional(),
        phone: z.string().trim().min(1).optional(),
        gender: z.string().trim().min(1).optional(),
        address1: z.string().trim().min(1).optional(),
        city: z.string().trim().min(1).optional(),
        zip: z.string().trim().min(1).optional(),
        country: z.string().trim().min(1).optional()
    })
    .refine((payload) => Object.keys(payload).length > 0, {
        message: "At least one field must be provided"
    });

const lockedStatuses = new Set(["APPROVED", "PROCESSING", "REFUND"]);
const allowedTransitions: Record<string, Set<string>> = {
    PAYMENT_RECEIVED: new Set(["PENDING", "CANCELLED"]),
    PENDING: new Set(["APPROVED"]),
    CANCELLED: new Set(["REFUND"])
};

internalRoutes.patch("/api/orders/:orderNumber/status", async (req, res, next) => {
    try {
        const key = req.header("x-api-key");
        if (!key || key !== config.pharmacyApiKey) {
            return res.status(403).json({ error: "forbidden" });
        }

        const { orderNumber } = updateOrderStatusPathSchema.parse(req.params);
        const body = updateOrderStatusBodySchema.parse(req.body);

        if ((body.status === "CANCELLED" || body.status === "REFUND") && !body.reason) {
            return res.status(400).json({
                error: "request_error",
                message: "reason is required when status is CANCELLED or REFUND"
            });
        }

        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            const [orders] = await connection.query<any[]>(
                `SELECT tenant_id, orderID, status
                   FROM orders
                  WHERE pharmacy_order_ref = :orderNumber
                  LIMIT 1
                  FOR UPDATE`,
                { orderNumber }
            );

            if (!orders.length) {
                await connection.rollback();
                return res.status(404).json({
                    error: "request_error",
                    message: "Order not found"
                });
            }

            const order = orders[0];
            const currentStatus = String(order.status ?? "").toUpperCase();

            if (lockedStatuses.has(currentStatus)) {
                await connection.rollback();
                return res.status(409).json({
                    error: "request_error",
                    message: `Order status is locked from ${currentStatus}`
                });
            }

            const validTargets = allowedTransitions[currentStatus];
            if (!validTargets || !validTargets.has(body.status)) {
                await connection.rollback();
                return res.status(409).json({
                    error: "request_error",
                    message: `Invalid status transition from ${currentStatus} to ${body.status}`
                });
            }

            await connection.query(
                `UPDATE orders
                    SET status = :status,
                        updated_at = CURRENT_TIMESTAMP(3)
                  WHERE tenant_id = :tenant_id AND orderID = :orderID`,
                {
                    status: body.status,
                    tenant_id: order.tenant_id,
                    orderID: order.orderID
                }
            );

            if (body.status === "PENDING") {
                await connection.query(
                    `INSERT INTO order_work_queue(tenant_id, orderID, order_number, status)
                     VALUES (:tenant_id, :orderID, :order_number, 'queued')
                     ON DUPLICATE KEY UPDATE
                       status='queued',
                       updated_at=CURRENT_TIMESTAMP(3)`,
                    {
                        tenant_id: order.tenant_id,
                        orderID: order.orderID,
                        order_number: orderNumber
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
                        tenant_id: order.tenant_id,
                        orderID: order.orderID,
                        order_number: orderNumber,
                        refund_reason: body.reason ?? null
                    }
                );
            }

            await connection.commit();

            return res.json({
                ok: true,
                orderNumber,
                previousStatus: currentStatus,
                status: body.status
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        next(err);
    }
});

internalRoutes.put("/api/customers/:email", async (req, res, next) => {
    try {
        const key = req.header("x-api-key");
        if (!key || key !== config.pharmacyApiKey) {
            return res.status(403).json({ error: "forbidden" });
        }

        const { email } = updateCustomerByEmailPathSchema.parse(req.params);
        const payload = updateCustomerByEmailBodySchema.parse(req.body);

        const response = await sendPharmacyRequest({
            tenant_id: config.tenantDefault,
            operation: "update_customer_by_email",
            method: "PUT",
            path: `/api/customers/${encodeURIComponent(email)}`,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            requestBodyForLog: payload
        });

        if (!response.ok) {
            return res.status(response.status).json(
                response.bodyJson ?? {
                    error: "request_error",
                    message: `Pharmacy API error: ${response.status}`
                }
            );
        }

        return res.status(200).json(response.bodyJson ?? { success: true });
    } catch (err) {
        return next(err);
    }
});
