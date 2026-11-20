import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export class AirforceProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Api.Airforce key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    // One request per minute per account: a 429 carries Retry-After and is
    // surfaced as-is so the router backs off instead of retrying into it.
    // The gateway must serve exactly the requested model (pinModel) — a
    // substituted identity is a 502 so the fallback loop rotates.
    super({ platform: 'airforce', name: 'Api.Airforce', baseUrl: 'https://api.airforce/v1', pinModel: true });
  }
}
