import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export class LogfareProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Logfare key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    // Responses carry `reasoning_content` (handled by the shared fold) and an
    // extra `neurons` usage field that is passed through untouched. Premium
    // routes answer 403 and surface as a provider error, never as a retry.
    // The gateway must serve exactly the requested model (pinModel) — a
    // substituted identity is a 502 so the fallback loop rotates.
    super({ platform: 'logfare', name: 'Logfare', baseUrl: 'https://logfare.ai/v1', pinModel: true });
  }
}
