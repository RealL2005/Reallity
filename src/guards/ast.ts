import { readFile } from "node:fs/promises";
import ts from "typescript";

export interface AstDiagnostic {
  line?: number;
  column?: number;
  message: string;
}

export interface AstAnalysis {
  ok: boolean;
  diagnostics: AstDiagnostic[];
}

export function isCodeFile(filePath: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(filePath);
}

export function analyzeSource(
  source: string,
  fileName: string,
): AstAnalysis {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2022,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const diagnostics = (result.diagnostics ?? []).map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      line: position.line + 1,
      column: position.character + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
  });

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

export async function analyzeFile(filePath: string): Promise<AstAnalysis> {
  if (!isCodeFile(filePath)) {
    return { ok: true, diagnostics: [] };
  }

  const source = await readFile(filePath, "utf8");
  return analyzeSource(source, filePath);
}
