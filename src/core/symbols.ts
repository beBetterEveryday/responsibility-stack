import * as ts from "typescript";
import { digest } from "./util.js";

export interface CodeSymbol {
  name: string;
  kind: "class" | "function" | "method" | "variable-function";
  start: number;
  end: number;
  text: string;
  digest: string;
}

export function supportsSymbols(pathname: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(pathname);
}

export function symbolsIn(pathname: string, source: string): CodeSymbol[] {
  if (!supportsSymbols(pathname)) return [];
  const kind = pathname.endsWith("x") ? ts.ScriptKind.TSX : pathname.match(/\.[cm]?js$/) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(pathname, source, ts.ScriptTarget.Latest, true, kind);
  const symbols: CodeSymbol[] = [];

  const add = (name: string, symbolKind: CodeSymbol["kind"], node: ts.Node): void => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const text = source.slice(start, end);
    symbols.push({ name, kind: symbolKind, start, end, text, digest: digest(text) });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, "function", statement);
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      add(className, "class", statement);
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        add(`${className}.${member.name.getText(sourceFile)}`, "method", member);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
          add(declaration.name.text, "variable-function", declaration);
        }
      }
    }
  }

  return symbols;
}

export function changedSymbols(pathname: string, before: string, after: string): CodeSymbol[] {
  const earlier = new Map(symbolsIn(pathname, before).map((symbol) => [symbol.name, symbol]));
  return symbolsIn(pathname, after).filter((symbol) => earlier.get(symbol.name)?.digest !== symbol.digest);
}
