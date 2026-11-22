import { ConfigError } from "../../core/errors.ts";

export interface QaRuntime {
  urls: {
    base: string;
    parentPortal?: string;
    studentPortal?: string;
  };
  /** Portal and API origins needed by the configured QA pages. */
  origins: string[];
  secrets: {
    QA_STUDENT_USERNAME?: string;
    QA_STUDENT_PASSWORD?: string;
    QA_PARENT_EMAIL?: string;
    QA_PARENT_PASSWORD?: string;
    QA_PRINCIPAL_EMAIL: string;
    QA_PRINCIPAL_PASS: string;
  };
}

const OPTIONAL_URL_FIELDS = {
  parentPortal: "webSettings.parentPortalUrl",
  studentPortal: "webSettings.studentPortalUrl",
} as const;

const PRINCIPAL_EMAIL_FIELDS = [
  "userSettings.principalEmail",
  "qaFixtureSettings.principalEmail",
] as const;
const PRINCIPAL_PASS_FIELDS = [
  "userSettings.principalPass",
  "qaFixtureSettings.principalPass",
] as const;

const SUPPORTING_URL_FIELDS = [
  "apiSettings.basePath",
  "apiSettings.baseUri",
  "apiSettings.baseUriParentPortal",
  "apiSettings.baseUriParentPortal2",
  "apiSettings.baseUriStudentPortal",
  "apiSettings.studentPortalWSUri",
  "apiSettings.baseUriStudentPortalAuth",
  "apiSettings.supportUri",
] as const;

/**
 * Reads the scalar subset of the checked-in HOCON file that browser exploration
 * needs. It is deliberately not a general HOCON parser: unsupported expressions
 * are refused instead of being evaluated, and only explicitly named QA fixture
 * fields can become Playwright secrets.
 */
export function parseQaRuntime(content: string): QaRuntime {
  const values = parseHoconScalars(content);
  const urls: QaRuntime["urls"] = {
    base: configuredUrl(required(values, "webSettings.baseUrl"), "webSettings.baseUrl"),
  };
  for (const [name, path] of Object.entries(OPTIONAL_URL_FIELDS)) {
    const value = values.get(path)?.trim();
    if (value) urls[name as keyof typeof OPTIONAL_URL_FIELDS] = configuredUrl(value, path);
  }

  const principalEmail = firstConfigured(values, PRINCIPAL_EMAIL_FIELDS);
  const principalPass = firstConfigured(values, PRINCIPAL_PASS_FIELDS);
  if (!principalEmail || !principalPass) {
    throw new ConfigError(
      "QA runtime config requires principal credentials: " +
        "'userSettings.principalEmail' and 'userSettings.principalPass'.",
    );
  }
  const secrets: QaRuntime["secrets"] = {
    QA_PRINCIPAL_EMAIL: principalEmail,
    QA_PRINCIPAL_PASS: principalPass,
  };
  addCredentialPair(values, secrets, {
    firstPath: "qaFixtureSettings.studentUsername",
    secondPath: "qaFixtureSettings.studentPassword",
    firstSecret: "QA_STUDENT_USERNAME",
    secondSecret: "QA_STUDENT_PASSWORD",
    label: "student credentials",
  });
  addCredentialPair(values, secrets, {
    firstPath: "qaFixtureSettings.parentEmail",
    secondPath: "qaFixtureSettings.parentPassword",
    firstSecret: "QA_PARENT_EMAIL",
    secondSecret: "QA_PARENT_PASSWORD",
    label: "parent credentials",
  });
  const origins = new Set(Object.values(urls).map((value) => new URL(value).origin));
  for (const path of SUPPORTING_URL_FIELDS) {
    const value = values.get(path);
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Some legacy fields called "basePath" are relative. They need no origin.
    }
  }
  return { urls, origins: [...origins], secrets };
}

export function qaRuntimeGuide(runtime: QaRuntime): string {
  const credentials = [
    ...(runtime.secrets.QA_STUDENT_USERNAME
      ? [
        "- Student portal username: QA_STUDENT_USERNAME",
        "- Student portal password: QA_STUDENT_PASSWORD",
      ]
      : []),
    ...(runtime.secrets.QA_PARENT_EMAIL
      ? [
        "- Parent portal email: QA_PARENT_EMAIL",
        "- Parent portal password: QA_PARENT_PASSWORD",
      ]
      : []),
    ...(runtime.secrets.QA_PRINCIPAL_EMAIL
      ? [
        "- Main/staff portal principal email: QA_PRINCIPAL_EMAIL",
        "- Main/staff portal principal password: QA_PRINCIPAL_PASS",
        "- Principal credentials belong to the main/staff portal, not the student portal.",
      ]
      : []),
  ];
  return [
    "# QA runtime",
    "",
    "The values below came from the configured Test-Automation runtime config.",
    "Start with the main portal unless the exploratory tester instructions require a specific portal.",
    "",
    "## Configured QA portal URLs",
    `- Main portal: ${runtime.urls.base}`,
    ...(runtime.urls.parentPortal ? [`- Parent portal: ${runtime.urls.parentPortal}`] : []),
    ...(runtime.urls.studentPortal ? [`- Student portal: ${runtime.urls.studentPortal}`] : []),
    "",
    "## Playwright secret placeholders",
    ...(credentials.length
      ? [
        "The real values are held by Playwright MCP and are not readable here.",
        "Type these exact placeholder names into login fields; MCP substitutes the values:",
        ...credentials,
      ]
      : ["No login credentials are configured."]),
  ].join("\n");
}

/** A credential-redacted shape matching the source file for instructions that refer to it. */
export function sanitizedQaRuntimeConfig(runtime: QaRuntime): string {
  return [
    "webSettings {",
    `  baseUrl = ${JSON.stringify(runtime.urls.base)}`,
    ...(runtime.urls.parentPortal
      ? [`  parentPortalUrl = ${JSON.stringify(runtime.urls.parentPortal)}`]
      : []),
    ...(runtime.urls.studentPortal
      ? [`  studentPortalUrl = ${JSON.stringify(runtime.urls.studentPortal)}`]
      : []),
    "}",
    ...(runtime.secrets.QA_STUDENT_USERNAME || runtime.secrets.QA_PARENT_EMAIL
      ? [
        "",
        "qaFixtureSettings {",
        ...(runtime.secrets.QA_STUDENT_USERNAME
          ? [
            '  studentUsername = "QA_STUDENT_USERNAME"',
            '  studentPassword = "QA_STUDENT_PASSWORD"',
          ]
          : []),
        ...(runtime.secrets.QA_PARENT_EMAIL
          ? [
            '  parentEmail = "QA_PARENT_EMAIL"',
            '  parentPassword = "QA_PARENT_PASSWORD"',
          ]
          : []),
        "}",
      ]
      : []),
    ...(runtime.secrets.QA_PRINCIPAL_EMAIL
      ? [
        "",
        "userSettings {",
        '  principalEmail = "QA_PRINCIPAL_EMAIL"',
        '  principalPass = "QA_PRINCIPAL_PASS"',
        "}",
      ]
      : []),
  ].join("\n");
}

export function playwrightSecretsEnv(runtime: QaRuntime): string {
  return Object.entries(runtime.secrets)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
}

function required(values: ReadonlyMap<string, string>, path: string): string {
  const value = values.get(path)?.trim();
  if (!value) throw new ConfigError(`QA runtime config is missing '${path}'.`);
  return value;
}

function configuredUrl(value: string, path: string): string {
  try {
    return new URL(value).toString();
  } catch (cause) {
    throw new ConfigError(`QA runtime field '${path}' is not a valid URL.`, { cause });
  }
}

function addCredentialPair(
  values: ReadonlyMap<string, string>,
  secrets: QaRuntime["secrets"],
  pair: {
    firstPath: string;
    secondPath: string;
    firstSecret: keyof QaRuntime["secrets"];
    secondSecret: keyof QaRuntime["secrets"];
    label: string;
  },
): void {
  const first = values.get(pair.firstPath)?.trim();
  const second = values.get(pair.secondPath)?.trim();
  if (Boolean(first) !== Boolean(second)) {
    throw new ConfigError(
      `QA runtime ${pair.label} require both '${pair.firstPath}' and '${pair.secondPath}'.`,
    );
  }
  if (first && second) {
    secrets[pair.firstSecret] = first;
    secrets[pair.secondSecret] = second;
  }
}

function firstConfigured(
  values: ReadonlyMap<string, string>,
  paths: readonly string[],
): string | undefined {
  for (const path of paths) {
    const value = values.get(path)?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseHoconScalars(content: string): Map<string, string> {
  const raw = new Map<string, string>();
  const stack: string[] = [];
  for (const original of content.split(/\r?\n/)) {
    const line = stripComment(original).trim();
    if (!line) continue;
    const block = line.match(/^([A-Za-z0-9_.-]+)\s*\{\s*$/);
    if (block) {
      stack.push(block[1]!);
      continue;
    }
    if (/^}\s*,?$/.test(line)) {
      stack.pop();
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*[=:]\s*(.+?)\s*,?$/);
    if (!assignment) continue;
    raw.set([...stack, assignment[1]!].join("."), assignment[2]!);
  }
  const values = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (path: string): string | undefined => {
    const cached = values.get(path);
    if (cached != null) return cached;
    const expression = raw.get(path);
    if (expression == null || resolving.has(path)) return undefined;
    resolving.add(path);
    const resolved = resolveHoconExpression(expression, path, raw, resolve);
    resolving.delete(path);
    if (resolved != null) values.set(path, resolved);
    return resolved;
  };
  for (const path of raw.keys()) resolve(path);
  return values;
}

function resolveHoconExpression(
  expression: string,
  currentPath: string,
  raw: ReadonlyMap<string, string>,
  resolve: (path: string) => string | undefined,
): string | undefined {
  let rest = expression.trim().replace(/,\s*$/, "");
  let output = "";
  let consumed = false;
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (rest.startsWith('"')) {
      const quoted = rest.match(/^"((?:\\.|[^"\\])*)"/);
      if (!quoted) return undefined;
      try {
        output += JSON.parse(`"${quoted[1]}"`) as string;
      } catch {
        return undefined;
      }
      rest = rest.slice(quoted[0].length);
      consumed = true;
      continue;
    }
    const substitution = rest.match(/^\$\{([^}]+)\}/);
    if (substitution) {
      const reference = substitution[1]!.trim();
      const resolved = resolveReference(reference, currentPath, raw, resolve);
      if (resolved == null) return undefined;
      output += resolved;
      rest = rest.slice(substitution[0].length);
      consumed = true;
      continue;
    }
    // The fields this feature consumes are strings. Refuse HOCON objects,
    // arrays, booleans and functions rather than evaluating arbitrary config.
    return undefined;
  }
  return consumed ? output : undefined;
}

function resolveReference(
  reference: string,
  currentPath: string,
  raw: ReadonlyMap<string, string>,
  resolve: (path: string) => string | undefined,
): string | undefined {
  if (raw.has(reference)) return resolve(reference);
  const parents = currentPath.split(".");
  parents.pop();
  while (parents.length > 0) {
    const candidate = [...parents, reference].join(".");
    if (raw.has(candidate)) return resolve(candidate);
    parents.pop();
  }
  return undefined;
}

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}
