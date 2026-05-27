// Renders a Notion page-property value to a single readable string.
// Input is `unknown` because we accept whatever the Notion API returns;
// we narrow per-type at runtime so new types fall through to JSON.stringify
// rather than erroring.

type Prop = Record<string, unknown>;

export function renderProperty(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") return "";
  const prop = value as Prop;
  const type = typeof prop["type"] === "string" ? (prop["type"] as string) : null;
  if (!type) return JSON.stringify(prop);

  const inner = prop[type];

  switch (type) {
    case "title":
    case "rich_text":
      return joinRichText(inner);
    case "number":
      return inner === null || inner === undefined ? "" : String(inner);
    case "select":
    case "status":
      return optionName(inner);
    case "multi_select":
      return joinNames(inner);
    case "date":
      return renderDate(inner);
    case "checkbox":
      return inner === true ? "true" : inner === false ? "false" : "";
    case "url":
    case "email":
    case "phone_number":
      return typeof inner === "string" ? inner : "";
    case "people":
    case "relation":
      return joinIds(inner);
    case "created_time":
    case "last_edited_time":
      return typeof inner === "string" ? inner : "";
    case "created_by":
    case "last_edited_by":
      return userId(inner);
    case "formula":
      return renderFormula(inner);
    case "rollup":
      return renderRollup(inner);
    case "files":
      return joinFileNames(inner);
    case "unique_id":
      return renderUniqueId(inner);
    default:
      return JSON.stringify(inner ?? prop);
  }
}

export function extractPageTitle(properties: Record<string, unknown> | null | undefined): string {
  if (!properties) return "";
  for (const value of Object.values(properties)) {
    if (value && typeof value === "object" && (value as Prop)["type"] === "title") {
      return renderProperty(value);
    }
  }
  return "";
}

function joinRichText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((node) =>
      node && typeof node === "object" && typeof (node as Prop)["plain_text"] === "string"
        ? ((node as Prop)["plain_text"] as string)
        : "",
    )
    .join("");
}

function optionName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const name = (value as Prop)["name"];
  return typeof name === "string" ? name : "";
}

function joinNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((opt) =>
      opt && typeof opt === "object" && typeof (opt as Prop)["name"] === "string"
        ? ((opt as Prop)["name"] as string)
        : "",
    )
    .filter(Boolean)
    .join(", ");
}

function joinIds(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((u) =>
      u && typeof u === "object" && typeof (u as Prop)["id"] === "string"
        ? ((u as Prop)["id"] as string)
        : "",
    )
    .filter(Boolean)
    .join(", ");
}

function userId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const id = (value as Prop)["id"];
  return typeof id === "string" ? id : "";
}

function renderDate(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const date = value as Prop;
  const start = typeof date["start"] === "string" ? (date["start"] as string) : "";
  const end = typeof date["end"] === "string" ? (date["end"] as string) : null;
  if (!start) return "";
  return end ? `${start} → ${end}` : start;
}

function renderFormula(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const formula = value as Prop;
  const innerType = typeof formula["type"] === "string" ? (formula["type"] as string) : null;
  if (!innerType) return "";
  const innerValue = formula[innerType];
  switch (innerType) {
    case "string":
      return typeof innerValue === "string" ? innerValue : "";
    case "number":
      return innerValue === null || innerValue === undefined ? "" : String(innerValue);
    case "boolean":
      return innerValue === true ? "true" : innerValue === false ? "false" : "";
    case "date":
      return renderDate(innerValue);
    default:
      return JSON.stringify(innerValue);
  }
}

function renderRollup(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const rollup = value as Prop;
  const innerType = typeof rollup["type"] === "string" ? (rollup["type"] as string) : null;
  if (!innerType) return "";
  if (innerType === "array") {
    const arr = rollup["array"];
    if (!Array.isArray(arr)) return "";
    return arr
      .map((item) => renderProperty(item))
      .filter(Boolean)
      .join(", ");
  }
  // number, date, etc. — render as a property-like value
  return renderProperty({ type: innerType, [innerType]: rollup[innerType] });
}

function joinFileNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((f) =>
      f && typeof f === "object" && typeof (f as Prop)["name"] === "string"
        ? ((f as Prop)["name"] as string)
        : "",
    )
    .filter(Boolean)
    .join(", ");
}

function renderUniqueId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const id = value as Prop;
  const prefix = typeof id["prefix"] === "string" ? (id["prefix"] as string) : null;
  const number = id["number"];
  const numStr = number === null || number === undefined ? "" : String(number);
  return prefix ? `${prefix}-${numStr}` : numStr;
}
