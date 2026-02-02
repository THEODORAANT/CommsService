import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export type AuthedRequest = Request & { tenant_id: string; actor?: any };

export const requireAuth: RequestHandler = (req, res, next) => {
    const authedReq = req as AuthedRequest;
    const auth = req.header("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: "unauthorized", message: "Missing bearer token" });
        return;
    }

    try {
        const decoded = jwt.verify(token, config.jwtSecret) as any;
        authedReq.tenant_id = decoded.tenant_id || req.header("X-Tenant-Id") || config.tenantDefault;
        authedReq.actor = decoded.actor || null;
        next();
    } catch {
        res.status(401).json({ error: "unauthorized", message: "Invalid token" });
    }
};
