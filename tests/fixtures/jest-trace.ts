/**
 * A GitLab job trace from an Angular + Jest CI run, with the things that make a
 * real trace hard to read: ANSI colour, GitLab section markers, and a progress
 * line rewritten with carriage returns.
 *
 * Written as a template with explicit escapes rather than pasted raw, so the
 * control characters are visible to anyone editing this file.
 */

const ESC = "";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

export const JEST_FAILURE_TRACE = [
  `section_start:1755680000:prepare_executor\r${ESC}[0K${GREEN}Preparing the "docker" executor${RESET}`,
  `Using Docker executor with image node:20-alpine ...`,
  `section_end:1755680010:prepare_executor\r${ESC}[0K`,
  `section_start:1755680011:step_script\r${ESC}[0K${BOLD}$ npm run test:ci${RESET}`,
  `> webapp@3.0.0 test:ci`,
  `> cross-env CI=true npm run test -- --ci --coverage --forceExit`,
  ``,
  // A progress line rewritten in place: only the final state is real output.
  `Determining test suites to run...\rDetermining test suites to run... 20%\rDetermining test suites to run... 80%\rRUNS  src/app/checkout/checkout.component.spec.ts`,
  `${GREEN}PASS${RESET} src/app/shared/pipes/currency.pipe.spec.ts (8.412 s)`,
  `${RED}FAIL${RESET} src/app/checkout/checkout.component.spec.ts (14.203 s)`,
  `  ${RED}●${RESET} CheckoutComponent › applies a percentage discount to the subtotal`,
  ``,
  `    expect(received).toBe(expected) // Object.is equality`,
  ``,
  `    Expected: 90`,
  `    Received: 100`,
  ``,
  `      39 |     component.applyDiscount(10);`,
  `    > 40 |     expect(component.total).toBe(90);`,
  `         |                             ^`,
  `      41 |   });`,
  ``,
  `      at Object.<anonymous> (src/app/checkout/checkout.component.spec.ts:40:29)`,
  ``,
  `  ${RED}●${RESET} CheckoutComponent › rejects a negative quantity`,
  ``,
  `    expect(received).toThrow(expected)`,
  ``,
  `    Received function did not throw`,
  ``,
  `      at Object.<anonymous> (src/app/checkout/checkout.component.spec.ts:57:5)`,
  ``,
  `${RED}FAIL${RESET} projects/parent-portal/src/app/billing/billing.service.spec.ts`,
  `  ● Test suite failed to run`,
  ``,
  `    Cannot find module '@app/billing/rates' from 'billing.service.spec.ts'`,
  ``,
  `${GREEN}PASS${RESET} src/app/core/services/auth.service.spec.ts (6.001 s)`,
  ``,
  `Test Suites: ${RED}2 failed${RESET}, 41 passed, 43 total`,
  `Tests:       ${RED}2 failed${RESET}, 238 passed, 240 total`,
  `Snapshots:   0 total`,
  `Time:        184.32 s`,
  `Ran all test suites.`,
  `section_end:1755680320:step_script\r${ESC}[0K`,
  `${RED}ERROR: Job failed: exit code 1${RESET}`,
].join("\n");

/** A suite that dies on import: no test names, so only counts and the tail. */
export const JEST_SUITE_CRASH_TRACE = [
  `$ npm run test:ci`,
  `${RED}FAIL${RESET} src/app/app.component.spec.ts`,
  `  ● Test suite failed to run`,
  ``,
  `    SyntaxError: Unexpected token '}' in src/app/app.module.ts:14`,
  ``,
  `Test Suites: 1 failed, 0 passed, 1 total`,
  `Tests:       0 total`,
  `ERROR: Job failed: exit code 1`,
].join("\n");

/**
 * What gitlab.com actually returns for an Angular + Jest monorepo, reduced.
 *
 * Three things the simpler fixtures above lack, each of which broke the parser
 * against the real thing:
 *
 * 1. `FF_TIMESTAMPS` line prefixes — `2026-08-21T02:46:53.491Z 01E ` — which
 *    defeat every `^`-anchored pattern, with a `+` variant for continuations.
 * 2. Each failure printed twice: inline, then under "Summary of all failing
 *    tests". The inline copy is interleaved with other workers' console noise.
 * 3. A coverage reporter printing its own `Tests:` line *after* Jest's summary.
 */
const TS = (n: number) => `2026-08-21T02:4${n % 10}:53.49${n % 10}496Z 01E `;

export const GITLAB_TIMESTAMPED_TRACE = [
  `2026-08-21T01:32:11.553862Z 00O section_end:1787275931:prepare_executor\r${ESC}[0K`,
  `2026-08-21T01:32:11.553950Z 00O+section_start:1787275933:step_script\r${ESC}[0K`,
  `${TS(1)}$ npm run test:ci`,
  // Inline copy, with another worker's output spliced into the middle of it.
  `${TS(2)}  ${RED}●${RESET} CheckoutComponent › applies a percentage discount`,
  `${TS(2)}`,
  `${TS(2)}    expect(received).toBe(expected)`,
  `${TS(2)}    Expected: 90`,
  `${TS(2)}    Received: 100`,
  `${TS(3)}    NG0303: Can't bind to 'somethingElse' — unrelated worker noise`,
  `${TS(3)}    NG0303: Can't bind to 'somethingElse' — unrelated worker noise`,
  `${TS(4)}  ${RED}●${RESET} CheckoutComponent › rejects a negative quantity`,
  `${TS(4)}    Received function did not throw`,
  `2026-08-21T02:46:52.243508Z 01O =============================== Coverage summary ====`,
  // The canonical recap: contiguous, and the source we want.
  `${TS(5)}`,
  `${TS(5)}Summary of all failing tests`,
  `${TS(5)}${RED}FAIL${RESET} src/app/checkout/checkout.component.spec.ts (9.45 s)`,
  `${TS(5)}  ${RED}●${RESET} CheckoutComponent › applies a percentage discount`,
  `${TS(5)}`,
  `${TS(5)}    expect(received).toBe(expected)`,
  `${TS(5)}    Expected: 90`,
  `${TS(5)}    Received: 100`,
  `${TS(6)}  ${RED}●${RESET} CheckoutComponent › rejects a negative quantity`,
  `${TS(6)}    Received function did not throw`,
  `${TS(7)}`,
  `${TS(7)}Test Suites: 1 failed, 41 passed, 42 total`,
  `${TS(7)}Tests:       2 failed, 238 passed, 240 total`,
  `${TS(7)}Snapshots:   0 total`,
  `${TS(7)}Ran all test suites.`,
  // A coverage reporter's own box, after Jest's summary and with grouped digits.
  `2026-08-21T02:46:54.962469Z 01O ╔═══════════════════════════════╗`,
  `2026-08-21T02:46:54.962473Z 01O ║  Tests:  11,997 total, 13 failures  ║`,
  `2026-08-21T02:46:54.962474Z 01O ╚═══════════════════════════════╝`,
  `2026-08-21T02:46:59.345702Z 00O+section_start:1787280419:cleanup\r${ESC}[0K`,
  `2026-08-21T02:47:00.000000Z 01E ${RED}ERROR: Job failed: exit code 1${RESET}`,
].join("\n");

/** Not a test failure at all: the job died before the runner started. */
export const NON_TEST_FAILURE_TRACE = [
  `section_start:1755680000:prepare_executor\r${ESC}[0K`,
  `Preparing the "docker" executor`,
  `section_end:1755680002:prepare_executor\r${ESC}[0K`,
  `$ npm ci`,
  `npm error code EBADENGINE`,
  `npm error engine Unsupported engine`,
  `npm error required: { node: '>=20' }`,
  `npm error current: { node: 'v18.19.0' }`,
  `ERROR: Job failed: exit code 1`,
].join("\n");
