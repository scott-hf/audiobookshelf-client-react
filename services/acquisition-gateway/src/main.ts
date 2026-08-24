import pino from 'pino'
import { buildApp } from './app'
import { loadConfig } from './config'

const logger = pino({ name: 'acquisition-gateway' })

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const app = buildApp({ config })

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' })
    logger.info({ port: config.PORT }, 'acquisition-gateway listening')
  } catch (error) {
    logger.error({ err: error }, 'failed to start acquisition-gateway')
    process.exit(1)
  }
}

if (process.argv.includes('--help')) {
  // eslint-disable-next-line no-console
  console.log('acquisition-gateway: reads its configuration from environment variables. See services/acquisition-gateway/src/config.ts.')
  process.exit(0)
} else {
  void main()
}
