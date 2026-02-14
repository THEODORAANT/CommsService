import express from "express";
import helmet from "helmet";
import { requireAuth } from "./auth.js";
import { perchMembers } from "./routes/perch.members.js";
import { perchOrders } from "./routes/perch.orders.js";
import { notesRoutes } from "./routes/notes.js";
import { internalRoutes } from "./routes/internal.js";
import { customerMediaRoutes } from "./routes/customer.media.js";

export function createApp() {
    const app = express();
    app.use(helmet());
    app.use(express.json({ limit: "1mb" }));

    app.get("/health", (_, res) => res.json({ ok: true }));

    // Internal endpoint (protected by X-Worker-Key, no JWT required)
    app.use(internalRoutes);
    app.use(customerMediaRoutes);

    // Everything else requires JWT
    app.use(requireAuth);

    app.use(perchMembers);
    app.use(perchOrders);
    app.use(notesRoutes);

    app.use((err: any, _req: any, res: any, _next: any) => {
        const status = err.status || 500;
        res.status(status).json({
            error: status === 500 ? "internal_error" : "request_error",
            message: err.message || "Unknown error"
        });
    });

    return app;
}
