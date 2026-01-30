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
