import { createAppFromEnv } from "./bootstrap";
import { sweepStaleSubmissions } from "./services/pipeline";

// Local development server only; production runs as a Vercel function (api/index.ts).
const { app, deps } = createAppFromEnv((work) => {
  void work;
});
const port = Number(process.env.PORT ?? 3001);

// A restart of this single process means nothing can still be running: fail anything left processing (AC8).
sweepStaleSubmissions(deps.db, 0)
  .then((n) => n > 0 && deps.logger.warn("marked interrupted submissions as Error", { count: n }))
  .catch((err) => deps.logger.error("startup sweep failed", { failureClass: (err as Error).name }));

app.listen(port, () => deps.logger.info("api listening", { port }));
