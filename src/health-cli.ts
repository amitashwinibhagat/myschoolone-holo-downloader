/**
 * CLI entry point for the portal health check: `npm run health`.
 */
import { runHealthCheck } from "./health.js";
import { checkSession } from "./session.js";
import { logError } from "./log.js";

runHealthCheck()
  .then(async (result) => {
    console.log(`Healthy: ${result.healthy}`);
    console.log(`Changed: ${result.changed}`);
    console.log(`Message: ${result.message}`);

    const session = await checkSession().catch(() => undefined);
    if (session) {
      console.log(`Session : ${session.status}${session.cookiesExpiringSoon ? " (cookies expire soon)" : ""}`);
    }

    process.exitCode = result.healthy ? 0 : 1;
  })
  .catch((error) => {
    logError(`\nFatal: ${(error as Error).stack || (error as Error).message}`);
    process.exitCode = 1;
  });
