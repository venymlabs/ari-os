import { loadConfig } from "../config/index.js";
import { createApplication } from "../app/index.js";
const app = createApplication(loadConfig(process.env), {
  modelProvider: {
    id: "smoke",
    complete: async () => ({
      message: { role: "assistant", content: "READY" },
    }),
  },
});
await app.start();
if (!app.ready()) throw new Error("not ready");
console.log("READY");
await app.stop();
