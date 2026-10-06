import { cfLiteTest } from "@cf-lite/testing/config";

export default cfLiteTest({ bindings: { CACHE_PURGE_TOKEN: "test-token", E2E_LOGIN_SECRET: "e2e-secret" } });
