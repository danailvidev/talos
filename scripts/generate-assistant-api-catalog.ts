// Keep discovery in sync with the React client without executing its code.
// Top-level operation properties use two-space indentation; nested values use more.
const client = await Bun.file("web/src/api.ts").text();
const contract = await Bun.file("shared/api-contract.ts").text();
const types: Record<string, string> = {};
for (const source of [contract, client]) {
  const declarations = [...source.matchAll(/^export (?:interface|type) (\w+)/gm)];
  for (let i = 0; i < declarations.length; i++) {
    const declaration = declarations[i]!;
    const tail = source.slice(declaration.index, declarations[i + 1]?.index ?? source.length);
    // End at the next top-level declaration (including private functions/constants).
    const next = tail.slice(1).search(/\n(?:export |const |function |async function |let )/);
    types[declaration[1]!] = (next < 0 ? tail : tail.slice(0, next + 1)).trim();
  }
}
const object = client.slice(client.indexOf("export const api = {") + "export const api = {".length);
const properties = [...object.matchAll(/^  (\w+):/gm)];
const operations = properties.flatMap((property, index) => {
  const name = property[1]!;
  const usage = object.slice(property.index, properties[index + 1]?.index ?? object.lastIndexOf("};")).trim();
  if (usage.includes("/api/auth/") || name === "assistantChat") return [];
  const refs = new Set<string>();
  const addType = (type: string, depth: number) => {
    if (!types[type] || refs.has(type) || depth > 3) return;
    refs.add(type);
    for (const word of types[type]!.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []) addType(word, depth + 1);
  };
  for (const word of usage.split("=>")[0]!.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []) addType(word, 0);
  return [{ name, usage, types: [...refs] }];
});
if (operations.length < 100) throw new Error("Could not parse the React API operation catalog.");
const referenced = new Set(operations.flatMap((operation) => operation.types));
const result = JSON.stringify({ operations, types: Object.fromEntries(Object.entries(types).filter(([key]) => referenced.has(key))) }, null, 2) + "\n";
const destination = "src/api/assistant-api-catalog.json";
if (process.argv.includes("--check")) {
  if (await Bun.file(destination).text() !== result) throw new Error("Assistant API catalog is stale. Run bun run scripts/generate-assistant-api-catalog.ts");
} else {
  await Bun.write(destination, result);
}
