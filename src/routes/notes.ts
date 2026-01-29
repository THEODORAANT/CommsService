import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";

export const notesRoutes = Router();

const ActorSchema = z.object({
    role: z.enum(["admin","pharmacist","patient","system"]),
    user_id: z.string().optional(),
    display_name: z.string().optional()
});

const ReplySchema = z.object({
    body: z.string().min(1),
    created_by: ActorSchema,
    external_reply_ref: z.string().optional().nullable()
});

notesRoutes.post("/v1/notes/:note_id/replies", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const note_id = req.params.note_id;
    const idem = req.header("Idempotency-Key") || undefined;

    const body = ReplySchema.parse(req.body);
    const endpoint = "/v1/notes/:note_id/replies";

    const { replayed, result } = await withIdempotency(tenant_id, endpoint, idem, { note_id, ...body }, async () => {
        const rows = await q<any>(
            `SELECT memberID, orderID FROM notes WHERE tenant_id=:tenant_id AND note_id=:note_id`,
            { tenant_id, note_id }
        );
        if (!rows.length) {
            const err: any = new Error("Note not found");
            err.status = 404;
            throw err;
        }

        const note_reply_id = crypto.randomUUID();

        await q(
            `INSERT INTO note_replies(
        note_reply_id, tenant_id, note_id, body,
        created_by_role, created_by_user_id, created_by_display_name, external_reply_ref
      ) VALUES (
        :note_reply_id, :tenant_id, :note_id, :body,
        :c_role, :c_uid, :c_name, :ext
      )`,
            {
                note_reply_id,
                tenant_id,
                note_id,
                body: body.body,
                c_role: body.created_by.role,
                c_uid: body.created_by.user_id ?? null,
                c_name: body.created_by.display_name ?? null,
                ext: body.external_reply_ref ?? null
            }
        );

        await emitEvent(tenant_id, "note.reply.created", {
            note_id,
            note_reply_id,
            memberID: Number(rows[0].memberID),
            orderID: rows[0].orderID ? Number(rows[0].orderID) : null
        });

        return { note_reply_id, note_id, created_at: new Date().toISOString() };
    });

    res.setHeader("X-Idempotency-Replayed", String(replayed));
    res.status(201).json(result);
});
