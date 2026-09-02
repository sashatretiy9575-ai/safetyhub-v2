import 'server-only';

interface SendTelegramMessageOptions {
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
}

/**
 * Robust server-side Telegram notification sender with automatic HTML escaping and fallback.
 */
export async function sendTelegramNotification({
  text,
  parseMode = 'HTML',
  disableWebPagePreview = true,
}: SendTelegramMessageOptions): Promise<{ success: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId =
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();

  if (!token || !chatId) {
    return {
      success: false,
      error: 'TELEGRAM_CONFIG_MISSING',
    };
  }

  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: disableWebPagePreview,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const body = await response.json();

    if (!response.ok || !body.ok) {
      console.error('[Telegram] API error:', body);
      return {
        success: false,
        error: body?.description || `HTTP ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error('[Telegram] Network dispatch error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'TELEGRAM_NETWORK_ERROR',
    };
  }
}
