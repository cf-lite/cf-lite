import { cfLiteTest } from "../dist/config.js"; // in an app: "@cf-lite/testing/config"

export default cfLiteTest({ migrations: "./migrations", bindings: { E2E_LOGIN_SECRET: "s3cret" } });
