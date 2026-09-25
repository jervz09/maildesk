export function deploymentConfig(env) {
  if (!env.DATABASE_URL)
    throw new Error("Set DATABASE_URL to the Supabase transaction pooler URI.");
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || ""))
    throw new Error(
      "Set ENCRYPTION_KEY to a persistent 64-character hex secret.",
    );
  if (!env.WORKER_SECRET || env.WORKER_SECRET.length < 32)
    throw new Error(
      "Set WORKER_SECRET to a random secret of at least 32 characters.",
    );
  const publicUrl = new URL(env.PUBLIC_URL);
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  )
    throw new Error(
      "PUBLIC_URL must be the public HTTPS origin without a path.",
    );
  return {
    databaseUrl: env.DATABASE_URL,
    key: env.ENCRYPTION_KEY,
    publicUrl: publicUrl.origin,
    production: true,
    vercel: env.VERCEL === "1",
    allowSignup: env.ALLOW_SIGNUP === "true",
    workerSecret: env.WORKER_SECRET,
    maxCampaignsPerTick: 1,
  };
}
