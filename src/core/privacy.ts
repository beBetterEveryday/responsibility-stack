import { digest } from "./util.js";

export interface ProtectedIntent {
  value: string;
  digest: string;
  redacted: boolean;
}

export function protectIntent(input: string): ProtectedIntent {
  const original = input.trim() || "Undeclared";
  let value = original
    .replace(
      /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"';}{]+)/gi,
      (_match, prefix: string, secret: string) => {
        const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
        return `${prefix}${quote}[REDACTED]${quote}`;
      },
    );
  return { value, digest: digest(original), redacted: value !== original };
}
