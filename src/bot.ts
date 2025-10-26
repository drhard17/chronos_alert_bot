import { Telegraf, Context } from 'telegraf';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import * as cron from 'node-cron';
import { BotConfigProvider, BotConfig } from './BotConfigProvider';

class EmailMonitorBot {
  private bot: Telegraf;
  private imap!: Imap;
  private config: BotConfig;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new Telegraf(config.telegramToken);
    this.setupImap();
    this.setupBot();
  }

  private setupImap(): void {
    const { user, password, host, port, tls } = this.config.email;
    this.imap = new Imap({
      user,
      password,
      host,
      port,
      tls,
      tlsOptions: { rejectUnauthorized: false }
    });

    this.imap.once('ready', () => {
      console.log('IMAP connection ready');
      this.reconnectAttempts = 0;
      this.startMonitoring();
    });

    this.imap.once('error', (err: Error) => {
      console.error('IMAP error:', err);
      this.handleImapError();
    });

    this.imap.once('end', () => {
      console.log('IMAP connection ended');
      this.handleImapError();
    });
  }

  private handleImapError(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay =
        this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // экспоненциальная задержка

      console.log(
        `Attempting to reconnect to IMAP (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`
      );

      setTimeout(() => {
        console.log('Reconnecting to IMAP...');
        this.setupImap();
        this.imap.connect();
      }, delay);
    } else {
      console.error(
        `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`
      );
      if (this.config.chatId != undefined) {
        this.bot.telegram.sendMessage(
          this.config.chatId,
          'Imap error'
        );
      }
    }
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
      if (this.imap.state === 'disconnected') {
        console.log('IMAP not connected, skipping email check');
        console.log(this.imap.state);
        if (this.config.chatId != undefined) {
          this.bot.telegram.sendMessage(
            this.config.chatId,
            'Imap error'
          );
        }
        return;
      }
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
    const chat_id = this.config.chatId;
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

    return `🚨 ${subject}\n\n` + `🕒 ${date}\n\n` + `📝 ${text}`;
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

// Запуск бота

const botConfig = BotConfigProvider.getConfig();
const bot = new EmailMonitorBot(botConfig);
bot.start().catch(console.error);
