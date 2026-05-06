import { defineApp } from "convex/server";
import polar from "@convex-dev/polar/convex.config.js";
import presence from "@convex-dev/presence/convex.config";
import migrations from "@convex-dev/migrations/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import r2 from "@convex-dev/r2/convex.config";

const app = defineApp();

app.use(polar);
app.use(presence);
app.use(migrations);
app.use(workpool, { name: "billing_workpool_bootstrap" });
app.use(workpool, { name: "billing_workpool_cancellation" });
app.use(workpool, { name: "billing_workpool_usage_event" });
app.use(rateLimiter, { name: "rate_limiter" });
app.use(r2);

export default app;
