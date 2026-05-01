import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateClaudeId(): string {
  const bytes = randomBytes(8);
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return id;
}

export function generateMessageId(): string {
  return `msg_${randomBytes(10).toString("hex")}`;
}
