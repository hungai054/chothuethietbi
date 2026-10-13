import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { noHardcodedTenant, noExtensionImport } from './rules.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const opts = { languageOptions: { ecmaVersion: 2022, sourceType: 'module' } };
const tester = new RuleTester(opts);

tester.run('no-hardcoded-tenant', noHardcodedTenant, {
  valid: [
    'if (tenant.status === "ACTIVE") {}',
    'if (user.id === "abc") {}',
    'if (tenant.slug === other.slug) {}',
    'const x = tenant.slug + "-a";',
    'if (can(features, "booking.timeline")) {}',
    'if (ctx.tenantId === currentId) {}',
  ],
  invalid: [
    { code: 'if (tenant.slug === "abc") {}', errors: 1 },
    { code: 'if ("abc" == ctx.tenant.slug) {}', errors: 1 },
    { code: 'if (ctx.tenantId !== "uuid-1") {}', errors: 1 },
    { code: 'if (tenant.id === `t1`) {}', errors: 1 },
    { code: 'if (tenant?.slug === "abc") {}', errors: 1 },
    { code: 'if (t["slug"] === "abc") {}', errors: 1 },
    { code: 'switch (tenant.slug) { case "abc": break; }', errors: 1 },
    { code: 'if (["a","b"].includes(tenant.slug)) {}', errors: 1 },
    { code: 'if (tenant.slug.startsWith("abc")) {}', errors: 1 },
  ],
});

tester.run('no-extension-import', noExtensionImport, {
  valid: [
    'import x from "@rentpro/core";',
    'import x from "./extension-point";',
    'import x from "../registry";',
  ],
  invalid: [
    { code: 'import x from "../../extensions/abc/index";', errors: 1 },
    { code: 'import x from "extensions/abc";', errors: 1 },
    { code: 'import x from "@rentpro-ext/abc";', errors: 1 },
    { code: 'export * from "../extensions/abc";', errors: 1 },
    { code: 'const m = await import("../extensions/abc");', errors: 1 },
    { code: 'const m = require("../extensions/abc");', errors: 1, languageOptions: { sourceType: 'script', ecmaVersion: 2022 } },
  ],
});
