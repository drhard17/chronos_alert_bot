export interface BotConfig {
  telegramToken: string;
  chatId: string;
  email: EmailConfig;
}

interface EmailConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  tls: boolean;
}

export class BotConfigProvider {
  private static instance: BotConfig;
  private static initialized = false;

  public static getConfig(): BotConfig {
    if (!this.initialized) {
      this.instance = this.createConfig();
      this.initialized = true;
    }
    return this.instance;
  }

  private static validateEnv(): void {
    const requiredEnvVars = [
      'EMAIL_ADDRESS',
      'EMAIL_PASSWORD',
      'IMAP_HOST',
      'IMAP_PORT',
      'BOT_TOKEN',
      'CHRONOS_CHAT_ID'
    ];

    const missing = requiredEnvVars.filter((envVar) => !process.env[envVar]);
    if (missing.length > 0) {
      throw new Error(`Missing env variables: ${missing.join(', ')}`);
    }

    const port = Number(process.env.IMAP_PORT);
    if (isNaN(port) || port <= 0) {
      throw new Error('Wrong imap port');
    }
  }

  private static createConfig(): BotConfig {
    this.validateEnv();

    const emailConfig: EmailConfig = {
      user: process.env.EMAIL_ADDRESS!,
      password: process.env.EMAIL_PASSWORD!,
      host: process.env.IMAP_HOST!,
      port: Number(process.env.IMAP_PORT!),
      tls: true
    };

    return {
      telegramToken: process.env.BOT_TOKEN!,
      chatId: process.env.CHRONOS_CHAT_ID!,
      email: emailConfig
    };
  }
}
