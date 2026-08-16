import type {
  Reversibility,
  RiskSignal,
  SideEffectCategory,
  SideEffectRecord,
  TimeMachineSideEffectDescriptor,
} from "../domain/types.ts";
import { newId, nowIso } from "../domain/ids.ts";

const FILE_TOOLS = new Set([
  "edit_file",
  "write",
  "edit",
  "str_replace",
  "str_replace_editor",
  "create_file",
  "delete_file",
  "read_file",
  "write_file",
]);

const DESTRUCTIVE_HINTS = [
  "delete",
  "rm ",
  "rm\n",
  "unlink",
  "drop ",
  "truncate",
  "migration",
  "migrate",
  "chmod",
  "chown",
];

export function looksDestructive(toolName: string, args: unknown): boolean {
  const blob = `${toolName} ${safeJson(args)}`.toLowerCase();
  if (/\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-f|drop\s+database|drop\s+table)\b/.test(blob)) {
    return true;
  }
  return DESTRUCTIVE_HINTS.some((h) => blob.includes(h));
}

export function looksExternal(toolName: string, args: unknown): boolean {
  const blob = `${toolName} ${safeJson(args)}`.toLowerCase();
  return [
    "github",
    "gmail",
    "slack",
    "notion",
    "http",
    "https",
    "email",
    "send_email",
    "create_issue",
    "deploy",
    "stripe",
    "aws",
    "gcp",
    "azure",
    "crm",
    "webhook",
    "fetch",
    "request",
  ].some((h) => blob.includes(h));
}

export function looksDatabase(toolName: string, args: unknown): boolean {
  const blob = `${toolName} ${safeJson(args)}`.toLowerCase();
  return ["sql", "psql", "mysql", "migrate", "prisma", "drizzle", "sequelize", "mongodb"].some((h) =>
    blob.includes(h),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function classifySideEffect(input: {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  descriptors?: TimeMachineSideEffectDescriptor[];
}): SideEffectRecord {
  for (const d of input.descriptors ?? []) {
    const nameOk = !d.toolName || d.toolName === input.toolName;
    const matchOk = d.match ? d.match(input) : true;
    if (nameOk && matchOk) {
      return {
        id: newId("fx"),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        timestamp: nowIso(),
        category: d.category,
        reversibility: d.reversibility,
        undoStrategy: d.undoStrategy,
        summary: d.summarize(input),
      };
    }
  }

  const name = input.toolName.toLowerCase();
  const blob = `${name} ${safeJson(input.args)}`.toLowerCase();

  if (FILE_TOOLS.has(name) || name.includes("fs") || name.includes("file")) {
    return make(input, "filesystem", "reversible", "Restore workspace files from checkpoint blobs.");
  }
  if (blob.includes("send_email") || blob.includes("email") && (blob.includes("send") || blob.includes("mail"))) {
    return make(input, "message", "irreversible", "Email send cannot be unsent by Time Machine.");
  }
  if (blob.includes("create_issue") || blob.includes("github")) {
    return make(
      input,
      "external-write",
      "conditionally-reversible",
      "Remote GitHub/API write is not automatically undone. A future adapter may close or comment.",
      "manual-or-adapter",
    );
  }
  if (blob.includes("deploy") || blob.includes("production")) {
    return make(input, "deployment", "unknown", "Deployment rollback requires a dedicated adapter.");
  }
  if (looksDatabase(input.toolName, input.args)) {
    const irrevers = /\bdrop\b|\btruncate\b|\bdelete from\b/.test(blob);
    return make(
      input,
      "database",
      irrevers ? "irreversible" : "unknown",
      irrevers
        ? "Destructive SQL cannot be universally rolled back."
        : "Database state is unknown without a transaction/snapshot adapter.",
    );
  }
  if (blob.includes("git push") || blob.includes("git commit")) {
    return make(
      input,
      "git",
      "conditionally-reversible",
      blob.includes("push")
        ? "git push is an external update. History rewrite is not performed."
        : "git commit can be reverted only with an explicit, user-approved git adapter.",
      "manual-git",
    );
  }
  if (looksExternal(input.toolName, input.args)) {
    return make(input, "network", "unknown", "Remote/network action is not claimed reversible.");
  }
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) {
    return make(input, "process", "unknown", "Process side effects are observed, not universally undone.");
  }
  return make(input, "unknown", "unknown", `Unclassified tool ${input.toolName}.`);
}

function make(
  input: { toolCallId: string; toolName: string; args: unknown },
  category: SideEffectCategory,
  reversibility: Reversibility,
  summary: string,
  undoStrategy?: string,
): SideEffectRecord {
  return {
    id: newId("fx"),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    timestamp: nowIso(),
    category,
    reversibility,
    undoStrategy,
    summary,
    details: { argsPreview: preview(input.args) },
  };
}

function preview(args: unknown): unknown {
  const text = safeJson(args);
  if (text.length > 500) return `${text.slice(0, 500)}…`;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function basicRisk(toolName: string, args: unknown): RiskSignal {
  if (looksDestructive(toolName, args) || looksExternal(toolName, args) || looksDatabase(toolName, args)) {
    return { level: "high", reasons: ["tool arguments look destructive or external"] };
  }
  if (FILE_TOOLS.has(toolName.toLowerCase())) {
    return { level: "medium", reasons: ["filesystem mutation"] };
  }
  return { level: "low", reasons: [] };
}

export function expectedPathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const obj = args as Record<string, unknown>;
  const keys = ["path", "file", "filename", "target", "dest", "to"];
  const out: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") out.push(v);
  }
  if (Array.isArray(obj.paths)) {
    for (const p of obj.paths) if (typeof p === "string") out.push(p);
  }
  return out;
}
