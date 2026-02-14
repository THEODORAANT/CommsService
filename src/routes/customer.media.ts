import { Router } from "express";
import crypto from "crypto";
import { config } from "../config.js";
import { q } from "../db.js";

export const customerMediaRoutes = Router();

type ParsedMultipart = {
    fields: Record<string, string>;
    file?: {
        filename: string;
        contentType: string;
        buffer: Buffer;
    };
};

function getBoundary(contentType: string): string | null {
    const match = contentType.match(/boundary=([^;]+)/i);
    return match ? match[1].trim().replace(/^"|"$/g, "") : null;
}

async function readRawBody(req: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function parseMultipartFormData(body: Buffer, boundary: string): ParsedMultipart {
    const fields: Record<string, string> = {};
    const boundaryBytes = Buffer.from(`--${boundary}`);
    const parts: Buffer[] = [];

    let cursor = 0;
    while (true) {
        const start = body.indexOf(boundaryBytes, cursor);
        if (start === -1) break;

        const next = body.indexOf(boundaryBytes, start + boundaryBytes.length);
        if (next === -1) break;

        const part = body.subarray(start + boundaryBytes.length, next);
        parts.push(part);
        cursor = next;
    }

    const parsed: ParsedMultipart = { fields };

    for (const rawPart of parts) {
        let part = rawPart;
        if (part.subarray(0, 2).equals(Buffer.from("\r\n"))) part = part.subarray(2);
        if (!part.length || part.equals(Buffer.from("--\r\n"))) continue;

        const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
        if (headerEnd === -1) continue;

        const headerText = part.subarray(0, headerEnd).toString("utf8");
        const content = part.subarray(headerEnd + 4, Math.max(headerEnd + 4, part.length - 2));

        const disposition = headerText
            .split("\r\n")
            .find((line) => line.toLowerCase().startsWith("content-disposition:"));
        if (!disposition) continue;

        const nameMatch = disposition.match(/name="([^"]+)"/i);
        if (!nameMatch) continue;

        const fieldName = nameMatch[1];
        const fileNameMatch = disposition.match(/filename="([^"]*)"/i);
        const contentTypeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);

        if (fileNameMatch) {
            parsed.file = {
                filename: fileNameMatch[1] || "upload.bin",
                contentType: contentTypeMatch?.[1]?.trim() || "application/octet-stream",
                buffer: content
            };
        } else {
            fields[fieldName] = content.toString("utf8").trim();
        }
    }

    return parsed;
}

customerMediaRoutes.post("/api/customers/media", async (req, res, next) => {
    try {
        const key = req.header("x-api-key");
        if (!key || key !== config.pharmacyApiKey) {
            return res.status(403).json({ success: false, message: "forbidden" });
        }

        const contentType = String(req.header("content-type") || "").toLowerCase();

        let email = "";
        let url: string | undefined;
        let uploadedFile: ParsedMultipart["file"];

        if (contentType.includes("multipart/form-data")) {
            const boundary = getBoundary(contentType);
            if (!boundary) {
                return res.status(400).json({ success: false, message: "Invalid multipart boundary" });
            }

            const rawBody = await readRawBody(req);
            const parsed = parseMultipartFormData(rawBody, boundary);
            email = String(parsed.fields.email || "").trim();
            url = parsed.fields.url ? String(parsed.fields.url).trim() : undefined;
            uploadedFile = parsed.file;
        } else {
            email = String(req.body?.email || "").trim();
            url = req.body?.url ? String(req.body.url).trim() : undefined;
        }

        if (!email) {
            return res.status(400).json({ success: false, message: "Customer email is required" });
        }

        if (!uploadedFile && !url) {
            return res.status(400).json({ success: false, message: "Either file or url is required" });
        }

        if (uploadedFile && url) {
            return res.status(400).json({ success: false, message: "Provide either file or url, not both" });
        }

        const members = await q<{ memberID: number }>(
            `SELECT memberID
               FROM members
              WHERE tenant_id = :tenant_id
                AND email = :email
              LIMIT 1`,
            {
                tenant_id: config.tenantDefault,
                email
            }
        );

        if (!members.length) {
            return res.status(404).json({ success: false, message: "Customer not found" });
        }

        let pharmacyResp: Response;
        if (uploadedFile) {
            const form = new FormData();
            form.append("email", email);
            form.append(
                "file",
                new Blob([new Uint8Array(uploadedFile.buffer)], { type: uploadedFile.contentType }),
                uploadedFile.filename
            );

            pharmacyResp = await fetch(`${config.pharmacyApiBaseUrl}/api/customers/media`, {
                method: "POST",
                headers: {
                    "x-api-key": config.pharmacyApiKey
                },
                body: form
            });
        } else {
            pharmacyResp = await fetch(`${config.pharmacyApiBaseUrl}/api/customers/media`, {
                method: "POST",
                headers: {
                    "x-api-key": config.pharmacyApiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ email, url })
            });
        }

        const pharmacyBody = await pharmacyResp.json().catch(() => ({} as any));

        if (pharmacyResp.status === 404) {
            return res.status(404).json({ success: false, message: "Customer not found" });
        }

        if (!pharmacyResp.ok) {
            return res.status(400).json({
                success: false,
                message: pharmacyBody?.message || "Failed to upload media"
            });
        }

        const responseDocument = pharmacyBody?.document || {};
        const finalUrl = String(responseDocument.url || url || "").trim();

        const documentId = crypto.randomUUID();
        const description = String(responseDocument.description || (uploadedFile ? uploadedFile.filename : "Customer document"));

        await q(
            `INSERT INTO customer_media_documents(
                document_id, tenant_id, memberID, email, url, description, source_type, uploaded_at
            ) VALUES (
                :document_id, :tenant_id, :memberID, :email, :url, :description, :source_type, CURRENT_TIMESTAMP(3)
            )`,
            {
                document_id: documentId,
                tenant_id: config.tenantDefault,
                memberID: members[0].memberID,
                email,
                url: finalUrl,
                description,
                source_type: uploadedFile ? "file" : "url"
            }
        );

        return res.status(200).json({
            success: true,
            message: "Media uploaded successfully",
            document: {
                _id: responseDocument._id || documentId,
                url: finalUrl,
                description,
                uploadedAt: responseDocument.uploadedAt || new Date().toISOString()
            }
        });
    } catch (err) {
        next(err);
    }
});
