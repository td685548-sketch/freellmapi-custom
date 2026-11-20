import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export class WaterfallProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Waterfall key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    // Upstream outages arrive as 503 with a structured `detail` object
    // ({"type":"waterfall_transport_error","code":"upstream_unavailable"});
    // the shared error path keeps the status and falls back to statusText.
    // The gateway must serve exactly the requested model (pinModel) — a
    // substituted identity is a 502 so the fallback loop rotates.
    super({ platform: 'waterfall', name: 'Waterfall', baseUrl: 'https://api.getwaterfall.org/v1', pinModel: true });
  }
}
