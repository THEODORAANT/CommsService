import crypto from "crypto";

import { config } from "./config.js";
import { q } from "./db.js";

type PharmacyRequestOptions = {
    tenant_id?: string | null;
    operation: string;
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    requestBodyForLog?: unknown;
};

type PharmacyRequestResult<T = any> = {
    status: number;
    ok: boolean;
    bodyText: string;
    bodyJson: T | null;
};

async function ensurePharmacyHttpLogsTable() {
    await q(
        `CREATE TABLE IF NOT EXISTS pharmacy_http_logs (
            log_id CHAR(36) PRIMARY KEY,
            tenant_id VARCHAR(64) NULL,
            operation VARCHAR(128) NOT NULL,
            method VARCHAR(16) NOT NULL,
            url VARCHAR(2048) NOT NULL,
            request_body LONGTEXT NULL,
            response_status INT NULL,
            response_body LONGTEXT NULL,
            error_message TEXT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            KEY idx_pharmacy_http_logs_tenant_created (tenant_id, created_at)
        ) ENGINE=InnoDB`
    );
}

async function writePharmacyHttpLog(payload: {
    tenant_id?: string | null;
    operation: string;
    method: string;
    url: string;
    request_body: string | null;
    response_status: number | null;
    response_body: string | null;
    error_message: string | null;
}) {
    const insertLog = async () => {
        await q(
            `INSERT INTO pharmacy_http_logs(
                log_id, tenant_id, operation, method, url,
                request_body, response_status, response_body, error_message
            ) VALUES (
                :log_id, :tenant_id, :operation, :method, :url,
                :request_body, :response_status, :response_body, :error_message
            )`,
            {
                log_id: crypto.randomUUID(),
                ...payload
            }
        );
    };

    try {
        await insertLog();
    } catch (err: any) {
        if (err?.code !== "ER_NO_SUCH_TABLE") {
            return;
        }

        try {
            await ensurePharmacyHttpLogsTable();
            await insertLog();
        } catch {
            return;
        }
    }
}

export async function sendPharmacyRequest<T = any>(options: PharmacyRequestOptions): Promise<PharmacyRequestResult<T>> {
    const url = `${config.pharmacyApiBaseUrl}${options.path}`;
    const requestBody =
        options.requestBodyForLog === undefined ? null : JSON.stringify(options.requestBodyForLog);

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;

    try {
        const response = await fetch(url, {
            method: options.method,
            headers: {
                "x-api-key": config.pharmacyApiKey,
                ...(options.headers ?? {})
            },
            body: options.body
        });

        const bodyText = await response.text();
        responseStatus = response.status;
        responseBody = bodyText;

        let bodyJson: T | null = null;
        if (bodyText) {
            try {
                bodyJson = JSON.parse(bodyText) as T;
            } catch {
                bodyJson = null;
            }
        }

        await writePharmacyHttpLog({
            tenant_id: options.tenant_id ?? null,
            operation: options.operation,
            method: options.method,
            url,
            request_body: requestBody,
            response_status: responseStatus,
            response_body: responseBody,
            error_message: null
        });

        return {
            status: response.status,
            ok: response.ok,
            bodyText,
            bodyJson
        };
    } catch (err: any) {
        errorMessage = String(err?.message ?? "network error");

        await writePharmacyHttpLog({
            tenant_id: options.tenant_id ?? null,
            operation: options.operation,
            method: options.method,
            url,
            request_body: requestBody,
            response_status: responseStatus,
            response_body: responseBody,
            error_message: errorMessage
        });

        throw err;
    }
}
