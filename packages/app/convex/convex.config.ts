import { defineApp } from "convex/server";
import polar from "@convex-dev/polar/convex.config.js";
import presence from "@convex-dev/presence/convex.config";
import migrations from "@convex-dev/migrations/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();

app.use(polar);
app.use(presence);
app.use(migrations);
app.use(workpool, { name: "billingUsageEventWorkpool" });
app.use(workpool, { name: "billingRefreshWorkpool" });

export default app;
