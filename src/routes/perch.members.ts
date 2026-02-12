import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
//import fetch from "node-fetch";
import { q } from "../db.js";
import { withIdempotency } from "../idempotency.js";
import { emitEvent } from "../webhooks/webhooks.service.js";
import type { AuthedRequest } from "../auth.js";
import { config } from "../config.js";

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

async function createPharmacyCustomer(payload: {
    name: string;
    email: string;
    dob: string;
    phone: string;
    gender: string;
    addressLine1: string;
    city: string;
    postCode: string;
    country: string;
}): Promise<string> {
    const resp = await fetch(`${config.pharmacyApiBaseUrl}/api/customers`, {
        method: "POST",
        headers: {
            "x-api-key": config.pharmacyApiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });
console.log("pst");console.log(resp);

    if (!resp.ok) {
        throw new Error(`Pharmacy API error: ${resp.status}`);
    }

    const data = (await resp.json()) as PharmacyCustomerResponse;
    const customerId = data?.data?.customerId;
    if (!customerId) {
        throw new Error("Pharmacy API missing customerId");
    }

    return customerId;
}

async function getPharmacyCustomerByEmail(email: string): Promise<PharmacyCustomerLookupResponse> {
    const resp = await fetch(
        `${config.pharmacyApiBaseUrl}/api/customers/${encodeURIComponent(email)}`,
        {
            method: "GET",
            headers: {
                "x-api-key": config.pharmacyApiKey
            }
        }
    );

    if (!resp.ok) {
        const err: any = new Error(`Pharmacy API error: ${resp.status}`);
        err.status = resp.status;
        throw err;
    }

    return (await resp.json()) as PharmacyCustomerLookupResponse;
}

perchMembers.get(
    "/v1/perch/customers/:email",
    authedHandler(async (req, res) => {
        const email = z.string().email().parse(req.params.email);
        const customer = await getPharmacyCustomerByEmail(email);
        res.json(customer);
    })
);

perchMembers.post(
    "/v1/perch/members/:memberID/link",
    authedHandler(async (req, res) => {
        //console.log("Incoming body:", req.body);

        const tenant_id = req.tenant_id;
        console.log("tenant_id :", tenant_id);
        const memberID = Number(req.params.memberID);
        console.log("memberID :", memberID);
        const body = MemberLinkSchema.parse(req.body);
        const email = body.email ?? body.memberEmail ?? null;
        const fullName = body.name ?? [body.first_name, body.last_name].filter(Boolean).join(" ").trim();

        if (
            !email ||
            !fullName ||
            !body.dob ||
            !body.phone ||
            !body.gender ||
            !body.addressLine1 ||
            !body.city ||
            !body.postCode ||
            !body.country
        ) {
            res.status(400).json({ ok: false, message: "Missing required pharmacy customer fields." });
            return;
        }

        const pharmacyCustomerId = await createPharmacyCustomer({
            name: fullName,
            email,
            dob: body.dob,
            phone: body.phone,
            gender: body.gender,
            addressLine1: body.addressLine1,
            city: body.city,
            postCode: body.postCode,
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
