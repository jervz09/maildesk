import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  scrypt as scryptCallback,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export async function passwordHash(value) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scrypt(value, salt, 64)).toString("hex")}`;
}
export async function passwordMatches(value, stored) {
  const [salt, digest] = stored.split(":");
  const result = await scrypt(value, salt, 64);
  return timingSafeEqual(result, Buffer.from(digest, "hex"));
}
export function vault(keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || ""))
    throw new Error(
      "ENCRYPTION_KEY must contain 64 hexadecimal characters. Run npm run setup.",
    );
  const key = Buffer.from(keyHex, "hex");
  return {
    encrypt(value, org) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(org));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return [iv, cipher.getAuthTag(), data]
        .map((b) => b.toString("base64url"))
        .join(".");
    },
    decrypt(value, org) {
      const [iv, tag, data] = value
        .split(".")
        .map((s) => Buffer.from(s, "base64url"));
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(org));
      cipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
      );
    },
    token(org, email) {
      const data = Buffer.from(JSON.stringify({ org, email })).toString(
        "base64url",
      );
      return `${data}.${createHmac("sha256", key).update(data).digest("base64url")}`;
    },
    readToken(token) {
      const [data, signature] = String(token).split(".");
      const expected = createHmac("sha256", key)
        .update(data || "")
        .digest("base64url");
      if (
        !signature ||
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      )
        throw new Error("Invalid unsubscribe link");
      return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    },
  };
}
