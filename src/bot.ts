import { Telegraf, Context } from 'telegraf';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import * as cron from 'node-cron';

interface EmailConfig {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  tls: boolean;
}

interface BotConfig {
  telegramToken?: string;
  email: EmailConfig;
}

class EmailMonitorBot {
  private bot: Telegraf;
  private imap!: Imap;
  private config: BotConfig;

  constructor(config: BotConfig) {
    const token = config.telegramToken;
    if (token === undefined) {
        throw new Error('Bot token is not provided');
    }
    this.config = config;
    this.bot = new Telegraf(token);
    this.setupImap();
    this.setupBot();
  }

  private setupImap(): void {
    const { user, password, host, port } = this.config.email;
    if (
        user === undefined ||
        password === undefined ||
        host === undefined ||
        port === undefined
    ) {
        throw new Error('Email credentials are not provided')
    }
    this.imap = new Imap({
      user,
      password,
      host,
      port,
      tls: this.config.email.tls,
      tlsOptions: { rejectUnauthorized: false }
    });

    this.imap.once('ready', () => {
      console.log('IMAP connection ready');
      this.startMonitoring();
    });

    this.imap.once('error', (err: Error) => {
      console.error('IMAP error:', err);
    });

    this.imap.once('end', () => {
      console.log('IMAP connection ended');
    });
  }

  private setupBot(): void {
    // Команда статуса
    this.bot.command('status', (ctx: Context) => {
        // TODO something
    });

    this.bot.command('chatid', (ctx: Context) => {
      const chatId = ctx.chat?.id;
      ctx.reply(`Chat ID: ${chatId}`);
    });

    // Обработка ошибок
    this.bot.catch((err: any, ctx: Context) => {
      console.error(`Error for ${ctx.updateType}:`, err);
    });
  }

  private startMonitoring(): void {
    // Проверка каждые 2 минуты
    cron.schedule('*/1 * * * *', () => {
      this.checkNewEmails();
    });
  }

  private async checkNewEmails(): Promise<void> {
    try {
      await this.openInbox();
    } catch (error) {
      console.error('Error checking emails:', error);
    }
  }

  private openInbox(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imap.openBox('INBOX', false, (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        this.searchEmails().then(resolve).catch(reject);
      });
    });
  }

  private searchEmails(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ищем непрочитанные письма за последние 10 минут
      const since = new Date();
      since.setMinutes(since.getMinutes() - 30);

      this.imap.search(
        ['UNSEEN', ['SINCE', since.toISOString().split('T')[0]]],
        (err: Error | null, results: number[]) => {
          if (err) {
            reject(err);
            return;
          }

          if (results.length === 0) {
            resolve();
            return;
          }

          console.log(`📨 Found ${results.length} unread emails`);

          // ✅ Ключевое решение: используем markSeen: true
          const fetch = this.imap.fetch(results, {
            bodies: '',
            markSeen: true // IMAP сервер сам помечает письма как прочитанные
          });

          let alertCount = 0;

          fetch.on('message', (msg: any) => {
            const chunks: Buffer[] = [];

            msg.on('body', (stream: NodeJS.ReadableStream) => {
              stream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
              });

              stream.on('end', async () => {
                try {
                  const emailBuffer = Buffer.concat(chunks);
                  const mail = await simpleParser(emailBuffer);

                  if (
                    mail.subject &&
                    mail.subject.toLowerCase().includes('alert')
                  ) {
                    console.log(`🚨 ALERT: "${mail.subject}"`);
                    await this.sendAlertNotification(mail);
                    alertCount++;
                  }
                } catch (error) {
                  console.error('Error parsing email:', error);
                }
              });
            });
          });

          fetch.once('error', (err: Error) => {
            reject(err);
          });

          fetch.once('end', () => {
            resolve();
          });
        }
      );
    });
  }

  private async sendAlertNotification(mail: any): Promise<void> {
    const message = this.formatAlertMessage(mail);
    const chat_id = process.env.CHRONOS_CHAT_ID
    if (chat_id === undefined) {
        throw new Error('Chat_id is not provided')
    }
      try {
        await this.bot.telegram.sendMessage(chat_id, message);
      } catch (error) {
        console.error(`Error sending message:`, error);
      }
  }

  private formatAlertMessage(mail: any): string {
    const subject = mail.subject || 'Без темы';
    const date =
      mail.date?.toLocaleString('ru-RU') || new Date().toLocaleString('ru-RU');
    const text = mail.text ? mail.text.substring(0, 1024) : 'Нет текста';

    return (
      `🚨 ${subject}\n\n` +
      `🕒 ${date}\n\n` +
      `📝 ${text}`
    );
  }

  public async start(): Promise<void> {
    // Подключаемся к IMAP
    this.imap.connect();

    // Запускаем бота
    await this.bot.launch();
    console.log('Telegram bot started');

    // Graceful shutdown
    process.once('SIGINT', () => this.stop());
    process.once('SIGTERM', () => this.stop());
  }

  public stop(): void {
    this.bot.stop();
    this.imap.end();
    console.log('Bot stopped');
  }
}

// Конфигурация
const config: BotConfig = {
  telegramToken: process.env.BOT_TOKEN,
  email: {
    user: process.env.EMAIL_ADDRESS,
    password: process.env.EMAIL_PASSWORD,
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    tls: true
  }
};

// Запуск бота
const bot = new EmailMonitorBot(config);
bot.start().catch(console.error);
