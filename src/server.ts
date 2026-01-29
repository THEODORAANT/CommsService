import { createApp } from "./app.js";
import { config } from "./config.js";

async function main() {
    if (process.argv.includes("--migrate")) {
        console.log("Run the SQL at src/sql/001_init_mysql.sql against your MySQL server.");
        process.exit(0);
    }

    const app = createApp();
    app.listen(config.port, () => console.log(`Comms Service (MySQL) on :${config.port}`));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
