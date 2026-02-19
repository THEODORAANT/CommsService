import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
//import fetch from "node-fetch";
import { q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";
import { sendPharmacyRequest } from "../pharmacy.client.js";

export const perchMembers = Router();

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

const LegacyNoteCreateSchema = z.object({
    note_type: z.enum(["admin_note", "clinical_note", "complaint_note"]),
    title: z.string().optional().nullable(),
    body: z.string().min(1),
    status: z.enum(["open", "resolved", "archived"]).optional(),
    created_by: ActorSchema,
    external_note_ref: z.string().optional().nullable()
});

const PharmacyMemberNoteCreateSchema = z
    .object({
        email: z.string().email(),
        body: z.string().trim().optional(),
        note: z.string().trim().optional(),
        type: z.enum(["ADMIN", "CLINICAL", "COMPLAINT"]).optional(),
        author: z.string().trim().optional()
    })
    .refine((payload) => Boolean(payload.body?.trim() || payload.note?.trim()), {
        message: "Either body or note is required"
    });

const NoteCreateSchema = z.union([LegacyNoteCreateSchema, PharmacyMemberNoteCreateSchema]);

function normalizeMemberNoteInput(input: z.infer<typeof NoteCreateSchema>) {
    if ("created_by" in input) {
        return input;
    }

    const resolvedBody = (input.body?.trim() || input.note?.trim() || "").trim();
    const normalizedType = input.type ?? "ADMIN";

    const noteTypeMap = {
        ADMIN: "admin_note",
        CLINICAL: "clinical_note",
        COMPLAINT: "complaint_note"
    } as const;

    return {
        note_type: noteTypeMap[normalizedType],
        title: null,
        body: resolvedBody,
        status: "open" as const,
        created_by: {
            role: "admin" as const,
            user_id: undefined,
            display_name: input.author?.trim() || "Pharmacy"
        },
        external_note_ref: null
    };
}

const MessageCreateSchema = z.object({
    channel: z.enum(["admin_patient","pharmacist_patient"]),
    body: z.string().min(1),
    sender: ActorSchema,
    external_message_ref: z.string().optional().nullable()
});

const MemberLinkSchema = z.object({
    email: z.string().email().optional().nullable(),
    memberEmail: z.string().email().optional().nullable(),
    name: z.string().optional().nullable(),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    pharmacy_patient_ref: z.string().optional().nullable(),
    dob: z.string().optional().nullable(),
    gender: z.string().optional().nullable(),
    addressLine1: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    postCode: z.string().optional().nullable(),
    country: z.string().optional().nullable()
});

type PharmacyCustomerResponse = {
    success: boolean;
    message?: string;
    data?: {
        customerId?: string;
    };
};

type PharmacyCustomerLookupResponse = {
    success: boolean;
    message?: string;
    data?: Record<string, unknown>;
};

const updateCustomerByEmailPayloadSchema = z
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

type PharmacyUpdateCustomerResponse = {
    success: boolean;
    message?: string;
    data?: Record<string, unknown>;
};

async function createPharmacyCustomer(tenant_id: string, payload: {
    name: string;
    email: string;
    dob: string;
    phone: string;
    gender: string;
    addressLine1?: string;
    city?: string;
    postCode?: string;
    country: string;
}): Promise<string> {
    const resp = await sendPharmacyRequest<PharmacyCustomerResponse>({
        tenant_id,
        operation: "create_customer",
        method: "POST",
        path: "/api/customers",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        requestBodyForLog: payload
    });

    if (!resp.ok) {
        throw new Error(`Pharmacy API error: ${resp.status}`);
    }

    const data = (resp.bodyJson ?? {}) as PharmacyCustomerResponse;
    const customerId = data?.data?.customerId;
    if (!customerId) {
        throw new Error("Pharmacy API missing customerId");
    }

    return customerId;
}

async function getPharmacyCustomerByEmail(tenant_id: string, email: string): Promise<PharmacyCustomerLookupResponse> {
    const resp = await sendPharmacyRequest<PharmacyCustomerLookupResponse>({
        tenant_id,
        operation: "get_customer_by_email",
        method: "GET",
        path: `/api/customers/${encodeURIComponent(email)}`
    });

    if (!resp.ok) {
        const err: any = new Error(`Pharmacy API error: ${resp.status}`);
        err.status = resp.status;
        throw err;
    }

    return (resp.bodyJson ?? {}) as PharmacyCustomerLookupResponse;
}

async function updatePharmacyCustomerByEmail(
    tenant_id: string,
    email: string,
    payload: z.infer<typeof updateCustomerByEmailPayloadSchema>
): Promise<PharmacyUpdateCustomerResponse> {
    const resp = await sendPharmacyRequest<PharmacyUpdateCustomerResponse>({
        tenant_id,
        operation: "update_customer_by_email",
        method: "PUT",
        path: `/api/customers/${encodeURIComponent(email)}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        requestBodyForLog: payload
    });

    if (!resp.ok) {
        const err: any = new Error(`Pharmacy API error: ${resp.status}`);
        err.status = resp.status;
        err.body = resp.bodyJson;
        throw err;
    }

    return (resp.bodyJson ?? { success: true }) as PharmacyUpdateCustomerResponse;
}

perchMembers.get(
    "/v1/perch/customers/:email",
    authedHandler(async (req, res) => {
        const email = z.string().email().parse(req.params.email);
        const customer = await getPharmacyCustomerByEmail(req.tenant_id, email);
        res.json(customer);
    })
);

perchMembers.put(
    "/v1/perch/customers/:email",
    authedHandler(async (req, res) => {
        const email = z.string().email().parse(req.params.email);
        const payload = updateCustomerByEmailPayloadSchema.parse(req.body);

        try {
            const result = await updatePharmacyCustomerByEmail(req.tenant_id, email, payload);
            res.json(result);
            return;
        } catch (err: any) {
            if (typeof err?.status === "number") {
                res.status(err.status).json(
                    err.body ?? {
                        error: "request_error",
                        message: err.message
                    }
                );
                return;
            }

            throw err;
        }
    })
);

perchMembers.post(
    "/v1/perch/members/:memberID/link",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const memberID = Number(req.params.memberID);
        const body = MemberLinkSchema.parse(req.body);
        const email = body.email ?? body.memberEmail ?? null;
        const fullName = body.name ?? [body.first_name, body.last_name].filter(Boolean).join(" ").trim();

        if (
            !email ||
            !fullName ||
            !body.dob ||
            !body.phone ||
            !body.gender ||
            !body.country
        ) {
            res.status(400).json({ ok: false, message: "Missing required pharmacy customer fields." });
            return;
        }

        const pharmacyCustomerId = await createPharmacyCustomer(tenant_id, {
            name: fullName,
            email,
            dob: body.dob,
            phone: body.phone,
            gender: body.gender,
            addressLine1: body.addressLine1 ?? undefined,
            city: body.city ?? undefined,
            postCode: body.postCode ?? undefined,
            country: body.country
        });

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
            {
                tenant_id,
                memberID,
                email,
                first_name: body.first_name ?? null,
                last_name: body.last_name ?? null,
                phone: body.phone ?? null,
                pharmacy_patient_ref: pharmacyCustomerId
            }
        );

        await emitEvent(tenant_id, "member.link.updated", { memberID });
        res.json({ ok: true,customerId:pharmacyCustomerId });
    })
);

perchMembers.get(
    "/v1/perch/members/notes",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const scope = (req.query.scope as string) || "patient";

        const notes = await q<any>(
            `SELECT * FROM notes
       WHERE tenant_id=:tenant_id
         AND (${scope === "patient" ? "scope='patient'" : "1=1"})
       ORDER BY memberID ASC, created_at DESC
       LIMIT 2000`,
            { tenant_id }
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

        const notesByMember = new Map<number, any[]>();
        for (const note of notes) {
            const memberNotes = notesByMember.get(note.memberID) || [];
            memberNotes.push({ ...note, replies: repliesBy.get(note.note_id) || [] });
            notesByMember.set(note.memberID, memberNotes);
        }

        const items = Array.from(notesByMember.entries()).map(([memberID, memberNotes]) => ({
            memberID,
            notes: memberNotes
        }));

        res.json({ items, next_cursor: null });
    })
);

perchMembers.get(
    "/v1/perch/members/:memberID/notes",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const memberID = Number(req.params.memberID);
        const scope = (req.query.scope as string) || "patient";

        const notes = await q<any>(
            `SELECT * FROM notes
       WHERE tenant_id=:tenant_id AND memberID=:memberID
        
       ORDER BY created_at DESC
       LIMIT 200`,
            { tenant_id, memberID }
        );
// AND (${scope === "patient" ? "scope='patient'" : "1=1"})
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

        const memberNotes = notes.map((n: any) => ({ ...n, replies: repliesBy.get(n.note_id) || [] }));

        res.json({
            items: [
                {
                    memberID,
                    notes: memberNotes
                }
            ],
            next_cursor: null
        });
    })
);

perchMembers.post(
    "/v1/perch/members/:memberID/notes",
    authedHandler(async (req, res) => {
        const tenant_id = req.tenant_id;
        const memberID = Number(req.params.memberID);
        const idem = req.header("Idempotency-Key") || undefined;

    const parsedBody = NoteCreateSchema.parse(req.body);
    const body = normalizeMemberNoteInput(parsedBody);
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
    })
);

perchMembers.get(
    "/v1/perch/members/:memberID/messages",
    authedHandler(async (req, res) => {
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
    })
);

perchMembers.post(
    "/v1/perch/members/:memberID/messages",
    authedHandler(async (req, res) => {
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
    })
);
