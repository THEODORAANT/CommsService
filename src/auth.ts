import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export type AuthedRequest = Request & { tenant_id: string; actor?: any };

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    const auth = req.header("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "unauthorized", message: "Missing bearer token" });

    try {
        const decoded = jwt.verify(token, config.jwtSecret) as any;
        req.tenant_id = decoded.tenant_id || req.header("X-Tenant-Id") || config.tenantDefault;
        req.actor = decoded.actor || null;
        next();
    } catch {
        return res.status(401).json({ error: "unauthorized", message: "Invalid token" });
    }
}
