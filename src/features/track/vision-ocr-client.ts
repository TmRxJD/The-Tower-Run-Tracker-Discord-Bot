import { getAppConfig } from '../../config';
import { logger } from '../../core/logger';
import type { AttachmentPayload } from './types';

type VisionOcrPayload = {
  textLines: string[];
  runData: Record<string, unknown>;
};

type ChatCompletionMessageContentPart = {
  type?: string;
  text?: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | ChatCompletionMessageContentPart[] | null;
    };
  }>;
};

type ErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

function resolveChatCompletionsEndpoint(configured: string | undefined): string {
  const trimmed = String(configured || '').trim();
  if (!trimmed) {
    throw new Error('TrackerAI cloud endpoint is not configured');
  }

  if (/\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/$/, '');
  }

  return `${trimmed.replace(/\/$/, '')}/chat/completions`;
}

function resolveVisionModel(configured: string | undefined): string {
  const trimmed = String(configured || '').trim();
  return trimmed || 'meta-llama/llama-4-scout-17-16e-instruct';
}

function buildImageDataUrl(file: AttachmentPayload): string {
  const contentType = String(file.contentType || 'image/png').trim() || 'image/png';
  return `data:${contentType};base64,${file.data.toString('base64')}`;
}

function extractContentText(content: string | ChatCompletionMessageContentPart[] | null | undefined): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(part => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Vision API returned non-JSON content');
}

function normalizeTextLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(entry => String(entry || '').trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeRunData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => {
      if (entry === null || entry === undefined) {
        return false;
      }

      if (typeof entry === 'string' && entry.trim() === '') {
        return false;
      }

      return true;
    }),
  );
}

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorResponse;
    const detail = [payload.error?.message, payload.error?.type, payload.error?.code]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' | ');
    if (detail) {
      return detail;
    }
  } catch {
    // fall through to text parsing
  }

  const text = String(await response.text().catch(() => '')).trim();
  return text || response.statusText || 'Vision API request failed';
}

export async function runDirectVisionOcr(file: AttachmentPayload): Promise<VisionOcrPayload> {
  const config = getAppConfig().ai;
  const apiKey = String(config.cloudApiKey || '').trim();
  if (!apiKey) {
    throw new Error('TrackerAI cloud API key is not configured');
  }

  const endpoint = resolveChatCompletionsEndpoint(config.cloudEndpoint);
  const model = resolveVisionModel(config.cloudVisionModel);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content: [
            'You extract data from The Tower screenshots.',
            'Return strict JSON only with this shape:',
            '{"textLines": string[], "runData": object}.',
            'textLines must be a readable transcription of visible screenshot text in top-to-bottom order.',
            'If the screenshot is a battle report, runData should include any fields you can infer from the image such as type, wave, tier, roundDuration, totalCoins, totalCells, totalDice, killedBy, totalEnemies, destroyedByOrbs, taggedByDeathWave, destroyedInSpotlight, destroyedInGoldenBot.',
            'If the screenshot is a lifetime stats view or not a battle report, return runData as an empty object.',
            'Do not include markdown fences or explanatory text.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract the screenshot into the required JSON response.',
            },
            {
              type: 'image_url',
              image_url: {
                url: buildImageDataUrl(file),
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Vision API ${response.status}: ${await parseErrorDetail(response)}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const rawContent = extractContentText(payload.choices?.[0]?.message?.content);
  const jsonText = extractJsonObject(rawContent);
  const parsed = JSON.parse(jsonText) as {
    textLines?: unknown;
    runData?: unknown;
  };

  const textLines = normalizeTextLines(parsed.textLines);
  if (textLines.length === 0) {
    logger.warn('Vision API OCR returned no text lines', { filename: file.filename });
    throw new Error('Vision API OCR returned no text lines');
  }

  return {
    textLines,
    runData: normalizeRunData(parsed.runData),
  };
}