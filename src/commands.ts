export const SAFE_CONTROL_COMMANDS = new Set<string>([
  "/help",
  "/commands",
  "/status",
  "/new",
  "/reset",
  "/clear",
  "/undo",
  "/usage",
  "/stop",
]);

export function resolveCommandToken(text: string): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const token = raw.split(/\s+/u)[0] ?? "";
  return token.trim().toLowerCase();
}

export function isSafeControlCommand(text: string): boolean {
  const token = resolveCommandToken(text);
  return SAFE_CONTROL_COMMANDS.has(token);
}

