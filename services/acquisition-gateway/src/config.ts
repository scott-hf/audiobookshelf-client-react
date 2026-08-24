import path from 'node:path'
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ABS_INTERNAL_URL: z.string().url(),
  ABS_SERVICE_TOKEN: z.string().min(1),
  LIBRARR_INTERNAL_URL: z.string().url(),
  LIBRARR_API_KEY: z.string().min(1),
  GATEWAY_DB_PATH: z.string().min(1),
  STAGING_ROOT: z.string().min(1),
  LIBRARY_MAPPINGS_JSON: z.string().min(2),
  SEARCH_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // TorBox with download_uncached accepts any hash and can sit at 0 B forever (FND-00410);
  // this is the reconciler's stall-to-failed timeout for that case (WI-1496 correction #4).
  STALL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  HISTORY_RETENTION_SECONDS: z.coerce.number().int().positive().default(604800)
})

export type GatewayEnv = z.infer<typeof EnvSchema>

export interface GatewayConfig extends GatewayEnv {
  stagingRoot: string
  libraries: Map<string, string>
}

export function loadConfig(input: NodeJS.ProcessEnv): GatewayConfig {
  const env = EnvSchema.parse(input)
  const libraries = new Map(Object.entries(z.record(z.string(), z.string()).parse(JSON.parse(env.LIBRARY_MAPPINGS_JSON))))
  const staging = path.resolve(env.STAGING_ROOT)
  for (const root of libraries.values()) {
    const resolved = path.resolve(root)
    if (resolved === staging || resolved.startsWith(staging + path.sep) || staging.startsWith(resolved + path.sep)) {
      throw new Error(`staging/library roots overlap: ${staging} and ${resolved}`)
    }
  }
  return { ...env, stagingRoot: staging, libraries }
}
