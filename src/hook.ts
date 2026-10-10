#!/usr/bin/env node
import { handleCodexHook, type CodexHookInput } from "./core/hook-recorder.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    handleCodexHook(JSON.parse(input.replace(/^\uFEFF/, "")) as CodexHookInput);
  } catch (error) {
    console.error(`responsibility-stack hook: ${(error as Error).message}`);
    process.exitCode = 1;
  }
});
