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
  HISTORY_RETENTION_SECONDS: z.coerce.number().int().positive().default(604800),
  // A staged tree is stable only after two identical fingerprints separated by this window
  // (02-SETTLED-DECISIONS.md). Never 0 in production -- it is what stops a mid-write copy
  // from being handed off as a complete book.
  STAGING_STABILITY_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // Final-tree file modes: `preserve` (default) keeps what Librarr wrote -- 0644 files inside
  // 0755 directories, FND-00413 -- which ABS can already read. `override` applies
  // FINAL_TREE_FILE_MODE/FINAL_TREE_DIR_MODE, for deployments where ABS runs as another uid.
  // See docs/handoff/correlation-note.md section 4.
  FINAL_TREE_MODE: z.enum(['preserve', 'override']).default('preserve'),
  FINAL_TREE_FILE_MODE: z.string().regex(/^[0-7]{3,4}$/).default('0644'),
  FINAL_TREE_DIR_MODE: z.string().regex(/^[0-7]{3,4}$/).default('0755'),
  // After a confirmed import the gateway deletes the staged tree AND Librarr's now-stale
  // library row. Both are required: a leftover tree is re-registered by Librarr's startup
  // folder scanner (FND-00414) and a leftover row blocks re-acquisition via in_library dedupe.
  // Disable only for debugging a failed import; never in production.
  IMPORT_CLEANUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true')
})

export type GatewayEnv = z.infer<typeof EnvSchema>

export interface GatewayConfig extends GatewayEnv {
  stagingRoot: string
  libraries: Map<string, string>
}

// Deliberately wider than NodeJS.ProcessEnv: `process.env` satisfies this, and so does a
// plain literal of just the gateway's own variables. Typing the parameter as ProcessEnv
// makes every test's explicit env object a type error under the root tsconfig (which
// requires NODE_ENV), without buying any safety here -- everything is validated by zod below.
export function loadConfig(input: Record<string, string | undefined>): GatewayConfig {
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
