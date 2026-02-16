import mysql from "mysql2/promise";
import { config } from "./config.js";

export const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: 10,
    namedPlaceholders: true
});

export async function q<T = any>(sql: string, params: any = {}): Promise<T[]> {
    const [rows] = await pool.query(sql, params);
    return rows as T[];
}

let hasEscalateClinicalReviewColumn: boolean | null = null;

export async function ordersHasEscalateClinicalReviewColumn(): Promise<boolean> {
    if (hasEscalateClinicalReviewColumn !== null) {
        return hasEscalateClinicalReviewColumn;
    }

    const rows = await q<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'orders'
           AND COLUMN_NAME = 'escalate_clinical_review'`
    );

    hasEscalateClinicalReviewColumn = Number(rows[0]?.cnt ?? 0) > 0;
    return hasEscalateClinicalReviewColumn;
}
