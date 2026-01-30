import dotenv from "dotenv";
dotenv.config();

export const config = {
    port: Number(process.env.PORT || 8080),
    jwtSecret: process.env.JWT_SHARED_SECRET!,
    tenantDefault: process.env.TENANT_DEFAULT || "gwl-cy",
    workerKey: process.env.INTERNAL_WORKER_KEY!,
    webhookMaxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS || 10),
    webhookLockSeconds: Number(process.env.WEBHOOK_LOCK_SECONDS || 30),
    mysql: {
        host: process.env.MYSQL_HOST!,
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER!,
        password: process.env.MYSQL_PASSWORD!,
        database: process.env.MYSQL_DATABASE!
    }
};
