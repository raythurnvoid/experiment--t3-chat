import { defineApp } from "convex/server";
import presence from "@convex-dev/presence/convex.config";
import migrations from "@convex-dev/migrations/convex.config";

const app = defineApp();

app.use(presence);
app.use(migrations);

export default app;
