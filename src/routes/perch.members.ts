import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";

export const perchMembers = Router();

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

const MessageCreateSchema = z.object({
    channel: z.enum(["admin_patient","pharmacist_patient"]),
    body: z.string().min(1),
    sender: ActorSchema,
    external_message_ref: z.string().optional().nullable()
});

const MemberLinkSchema = z.object({
    email: z.string().email().optional().nullable(),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    pharmacy_patient_ref: z.string().optional().nullable()
});

perchMembers.post("/v1/perch/members/:memberID/link", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const memberID = Number(req.params.memberID);
    const body = MemberLinkSchema.parse(req.body);

    await q(
        `INSERT INTO members(tenant_id, memberID, email, first_name, last_name, phone, pharmacy_patient_ref)
     VALUES (:tenant_id, :memberID, :email, :first_name, :last_name, :phone, :pharmacy_patient_ref)
     ON DUPLICATE KEY UPDATE
       email = COALESCE(VALUES(email), email),
       first_name = COALESCE(VALUES(first_name), first_name),
       last_name = COALESCE(VALUES(last_name), last_name),
       phone = COALESCE(VALUES(phone), phone),
       pharmacy_patient_ref = COALESCE(VALUES(pharmacy_patient_ref), pharmacy_patient_ref),
       updated_at = CURRENT_TIMESTAMP(3)`,
        { tenant_id, memberID, ...body }
    );

    await emitEvent(tenant_id, "member.link.updated", { memberID });
    res.json({ ok: true });
});

perchMembers.get("/v1/perch/members/:memberID/notes", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const memberID = Number(req.params.memberID);
    const scope = (req.query.scope as string) || "patient";

    const notes = await q<any>(
        `SELECT * FROM notes
     WHERE tenant_id=:tenant_id AND memberID=:memberID
       AND (${scope === "patient" ? "scope='patient'" : "1=1"})
     ORDER BY created_at DESC
     LIMIT 200`,
        { tenant_id, memberID }
    );

    const noteIds = notes.map((n: any) => n.note_id);
    let replies: any[] = [];
    if (noteIds.length) {
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

perchMembers.post("/v1/perch/members/:memberID/notes", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const memberID = Number(req.params.memberID);
    const idem = req.header("Idempotency-Key") || undefined;

    const body = NoteCreateSchema.parse(req.body);
    const endpoint = "/v1/perch/members/:memberID/notes";

    const { replayed, result } = await withIdempotency(tenant_id, endpoint, idem, { memberID, ...body }, async () => {
        await q(
            `INSERT INTO members(tenant_id, memberID)
       VALUES (:tenant_id, :memberID)
       ON DUPLICATE KEY UPDATE memberID=memberID`,
            { tenant_id, memberID }
        );

        const note_id = crypto.randomUUID();
        const status = body.status ?? "open";

        await q(
            `INSERT INTO notes(
        note_id, tenant_id, scope, memberID, orderID,
        note_type, title, body, status,
        created_by_role, created_by_user_id, created_by_display_name, external_note_ref
      ) VALUES (
        :note_id, :tenant_id, 'patient', :memberID, NULL,
        :note_type, :title, :body, :status,
        :c_role, :c_uid, :c_name, :ext
      )`,
            {
                note_id,
                tenant_id,
                memberID,
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

        await emitEvent(tenant_id, "note.created", { note_id, memberID, scope: "patient" });

        return { note_id, thread_root_id: note_id, scope: "patient", memberID, orderID: null, note_type: body.note_type, status, created_at: new Date().toISOString() };
    });

    res.setHeader("X-Idempotency-Replayed", String(replayed));
    res.status(201).json(result);
});

perchMembers.get("/v1/perch/members/:memberID/messages", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const memberID = Number(req.params.memberID);
    const channel = (req.query.channel as string) || "all";

    const items = await q<any>(
        `SELECT * FROM messages
     WHERE tenant_id=:tenant_id AND memberID=:memberID
       AND (${channel === "all" ? "1=1" : "channel=:channel"})
     ORDER BY created_at DESC
     LIMIT 500`,
        { tenant_id, memberID, channel }
    );

    res.json({ items, next_cursor: null });
});

perchMembers.post("/v1/perch/members/:memberID/messages", async (req: AuthedRequest, res) => {
    const tenant_id = req.tenant_id;
    const memberID = Number(req.params.memberID);
    const idem = req.header("Idempotency-Key") || undefined;

    const body = MessageCreateSchema.parse(req.body);
    const endpoint = "/v1/perch/members/:memberID/messages";

    const { replayed, result } = await withIdempotency(tenant_id, endpoint, idem, { memberID, ...body }, async () => {
        await q(
            `INSERT INTO members(tenant_id, memberID)
       VALUES (:tenant_id, :memberID)
       ON DUPLICATE KEY UPDATE memberID=memberID`,
            { tenant_id, memberID }
        );

        const message_id = crypto.randomUUID();

        await q(
            `INSERT INTO messages(
        message_id, tenant_id, memberID, channel, body,
        sender_role, sender_user_id, sender_display_name, external_message_ref
      ) VALUES (
        :message_id, :tenant_id, :memberID, :channel, :body,
        :s_role, :s_uid, :s_name, :ext
      )`,
            {
                message_id,
                tenant_id,
                memberID,
                channel: body.channel,
                body: body.body,
                s_role: body.sender.role,
                s_uid: body.sender.user_id ?? null,
                s_name: body.sender.display_name ?? null,
                ext: body.external_message_ref ?? null
            }
        );

        await emitEvent(tenant_id, "message.created", { message_id, memberID, channel: body.channel });
        return { message_id, memberID, channel: body.channel, created_at: new Date().toISOString() };
    });

    res.setHeader("X-Idempotency-Replayed", String(replayed));
    res.status(201).json(result);
});
