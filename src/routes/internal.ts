import { Router } from "express";
import { config } from "../config.js";
import { processWebhookBatch } from "../webhooks/webhooks.service.js";

export const internalRoutes = Router();

internalRoutes.post("/v1/internal/process-webhooks", async (req, res) => {
    const key = req.header("X-Worker-Key");
    if (!key || key !== config.workerKey) return res.status(403).json({ error: "forbidden" });

    const limit = Number(req.query.limit || 50);
    const result = await processWebhookBatch(limit);
    res.json(result);
});
