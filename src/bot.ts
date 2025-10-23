import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
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
  allowedUsers?: number[];
  email: EmailConfig;
}

class EmailMonitorBot {
  private bot: Telegraf;
  private imap!: Imap;   
  private config: BotConfig;
  private subscribedUsers: Set<number> = new Set();

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
    // Команда старт
    this.bot.start((ctx: Context) => {
      const userId = ctx.from?.id;
      const { allowedUsers } = this.config;
      if (allowedUsers === undefined) {
        throw new Error('Allowed users are not provided')
      }
      if (userId && allowedUsers.includes(userId)) {
        this.subscribedUsers.add(userId);
        ctx.reply(
          '✅ Бот запущен! Вы будете получать уведомления о письмах с темой содержащей "alert".\n\n' +
          'Команды:\n' +
          '/status - статус мониторинга\n' +
          '/stop - остановить уведомления'
        );
      } else {
        ctx.reply('❌ У вас нет доступа к этому боту.');
      }
    });

    // Команда статуса
    this.bot.command('status', (ctx: Context) => {
      const userId = ctx.from?.id;
      if (userId && this.subscribedUsers.has(userId)) {
        ctx.reply(`📊 Статус: активен\nПодписчиков: ${this.subscribedUsers.size}`);
      }
    });

    // Команда остановки
    this.bot.command('stop', (ctx: Context) => {
      const userId = ctx.from?.id;
      if (userId) {
        this.subscribedUsers.delete(userId);
        ctx.reply('🔕 Уведомления остановлены. Используйте /start для возобновления.');
      }
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
    if (this.subscribedUsers.size === 0) return;

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

        this.searchEmails()
          .then(resolve)
          .catch(reject);
      });
    });
  }

  private searchEmails(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ищем непрочитанные письма за последние 10 минут
      const since = new Date();
      since.setMinutes(since.getMinutes() - 10);

      this.imap.search(['UNSEEN', ['SINCE', since.toISOString().split('T')[0]]], (err: Error | null, results: number[]) => {
        if (err) {
          reject(err);
          return;
        }

        if (results.length === 0) {
          resolve();
          return;
        }

        const fetch = this.imap.fetch(results, { bodies: '' });
        
        fetch.on('message', (msg: any) => {
        msg.on('body', async (stream: NodeJS.ReadableStream) => {
            try {
            // Собираем данные из stream в буфер
            const chunks: Buffer[] = [];
            
            stream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });

            stream.on('end', async () => {
                try {
                // Преобразуем буфер в строку и парсим письмо
                const emailBuffer = Buffer.concat(chunks);
                const mail = await simpleParser(emailBuffer);

                // Проверяем тему на наличие слова "alert"
                if (mail.subject && mail.subject.toLowerCase().includes('alert')) {
                    await this.sendAlertNotification(mail);
                }

                // Помечаем письмо как прочитанное
                this.markAsRead(msg);
                } catch (error) {
                console.error('Error parsing email:', error);
                }
            });

            } catch (error) {
            console.error('Error processing email stream:', error);
            }
        });
        });

        fetch.once('error', (err: Error) => {
          reject(err);
        });

        fetch.once('end', () => {
          resolve();
        });
      });
    });
  }

  private markAsRead(msg: any): void {
    console.log(msg.attributes);
    this.imap.addFlags(msg.attributes.uid, ['\\Seen'], (err: Error | null) => {
      if (err) {
        console.error('Error marking email as read:', err);
      }
    });
  }

  private async sendAlertNotification(mail: any): Promise<void> {
    const message = this.formatAlertMessage(mail);
    
    for (const userId of this.subscribedUsers) {
      try {
        await this.bot.telegram.sendMessage(userId, message);
      } catch (error) {
        console.error(`Error sending message to user ${userId}:`, error);
        // Если пользователь заблокировал бота, удаляем его из подписчиков
        if (error instanceof Error && error.message.includes('blocked')) {
          this.subscribedUsers.delete(userId);
        }
      }
    }
  }

  private formatAlertMessage(mail: any): string {
    const subject = mail.subject || 'Без темы';
    const from = mail.from?.text || 'Неизвестный отправитель';
    const date = mail.date?.toLocaleString('ru-RU') || new Date().toLocaleString('ru-RU');
    const text = mail.text ? mail.text.substring(0, 500) + '...' : 'Нет текста';

    return `🚨 ALERT УВЕДОМЛЕНИЕ\n\n` +
            `📧 От: ${from}\n` +
            `📋 Тема: ${subject}\n` +
            `🕒 Время: ${date}\n\n` +
            `📝 Содержание:\n${text}`;
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
  allowedUsers: [Number(process.env.ALLOWED_USERS)],
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