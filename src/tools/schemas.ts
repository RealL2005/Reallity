import { z } from "zod";

export const toolNameSchema = z.enum([
  "read_file",
  "edit_file",
  "bash",
  "list_dir",
  "glob",
]);

export type ToolName = z.infer<typeof toolNameSchema>;

export const readFileArgsSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});

export const editFileArgsSchema = z.object({
  path: z.string().min(1),
  old_str: z.string(),
  new_str: z.string(),
});

export const bashArgsSchema = z.object({
  command: z.string().min(1),
});

export const listDirArgsSchema = z.object({
  path: z.string().default("."),
});

export const globArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
});

export const toolArgsSchemas = {
  read_file: readFileArgsSchema,
  edit_file: editFileArgsSchema,
  bash: bashArgsSchema,
  list_dir: listDirArgsSchema,
  glob: globArgsSchema,
} as const;

const TOOL_DEFINITIONS: Array<{
  name: ToolName;
  description: string;
  schema: z.ZodTypeAny;
}> = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. Supports optional start_line and end_line paging.",
    schema: readFileArgsSchema,
  },
  {
    name: "edit_file",
    description:
      "Replace a block of text in a file. old_str must match exactly once in the file.",
    schema: editFileArgsSchema,
  },
  {
    name: "bash",
    description:
      "Run a non-interactive shell command with a hard timeout and process-tree cleanup.",
    schema: bashArgsSchema,
  },
  {
    name: "list_dir",
    description:
      "List files and directories under a workspace path without following symlinks outside the root.",
    schema: listDirArgsSchema,
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern inside a workspace path.",
    schema: globArgsSchema,
  },
];

export interface ToolSchemaEntry {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_SCHEMAS: ToolSchemaEntry[] = TOOL_DEFINITIONS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.schema),
  },
}));

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const typeName = def.typeName as string;

  if (typeName === "ZodObject") {
    const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
    const properties = Object.fromEntries(
      Object.entries(shape).map(([key, value]) => [
        key,
        zodToJsonSchema(value),
      ]),
    );
    const required = Object.entries(shape)
      .filter(([, value]) => !isOptional(value))
      .map(([key]) => key);

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }

  if (typeName === "ZodString") {
    return { type: "string" };
  }

  if (typeName === "ZodNumber") {
    return { type: "number" };
  }

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return zodToJsonSchema(def.innerType as z.ZodTypeAny);
  }

  if (typeName === "ZodEnum") {
    return { type: "string", enum: def.values as string[] };
  }

  return {};
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional();
}
