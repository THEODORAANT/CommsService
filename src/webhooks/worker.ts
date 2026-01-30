import { processWebhookBatch } from "./webhooks.service.js";

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log("Webhook worker started.");
    while (true) {
        try {
            await processWebhookBatch(100);
        } catch (e) {
            console.error("worker error", e);
        }
        await sleep(1000);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
