/*import chalk from "chalk";
import dayjs from "dayjs";

export function logRoutes(app, attempt = 1) {
  const MAX_ATTEMPTS = 10; // tries for 10 × 500ms = 5s total
  const WAIT = 500;

  const env = process.env.NODE_ENV || "development";
  const now = dayjs().format("YYYY-MM-DD HH:mm:ss");

  // 🔒 Safety: skip if app not ready yet
  if (!app || !app._router || !Array.isArray(app._router.stack) || app._router.stack.length === 0) {
    if (attempt <= MAX_ATTEMPTS) {
      console.warn(
        chalk.yellow(
          `⚠️  Router still empty (attempt ${attempt}/${MAX_ATTEMPTS}) — waiting ${WAIT} ms...`
        )
      );
      setTimeout(() => logRoutes(app, attempt + 1), WAIT);
      return;
    }
    console.error(chalk.red("❌ Router never initialized — skipping route log."));
    return;
  }

  // ✅ Router ready
  console.log(chalk.gray("\n────────────────────────────────────────────"));
  console.log(`${chalk.bold("🌍 Environment:")} ${chalk.green(env.toUpperCase())}`);
  console.log(`${chalk.bold("🕒 Timestamp:")} ${chalk.cyan(now)}`);
  console.log(chalk.cyanBright("\n🧭 REGISTERED ROUTES"));
  console.log(chalk.gray("────────────────────────────────────────────"));

  const routes = [];

  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods).join(", ").toUpperCase(),
      });
    } else if (middleware.name === "router" && middleware.handle.stack) {
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          routes.push({
            path: handler.route.path,
            methods: Object.keys(handler.route.methods)
              .join(", ")
              .toUpperCase(),
          });
        }
      });
    }
  });

  if (routes.length === 0) {
    console.log(chalk.yellow("⚠️  No routes found."));
    return;
  }

  // 🔹 Group by first segment
  const grouped = {};
  for (const r of routes) {
    const base = r.path.split("/")[1] || "/";
    if (!grouped[base]) grouped[base] = [];
    grouped[base].push(r);
  }

  Object.entries(grouped).forEach(([group, list]) => {
    console.log(chalk.magentaBright(`\n📂 /${group}`));
    list.forEach((r) =>
      console.log(`${chalk.green(r.methods.padEnd(10))} ${chalk.white(r.path)}`)
    );
  });

  console.log(chalk.gray("────────────────────────────────────────────\n"));
}*/


