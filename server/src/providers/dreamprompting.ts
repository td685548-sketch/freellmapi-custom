import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider, type PinModelCheck } from './openai-compat.js';

// DreamPrompting is a fail-over router. `auto` legitimately reports
// whichever upstream served the call. Every other route is addressed as
// `<upstream>/<upstream model id>` and the response reports the upstream
// id: `groq/openai/gpt-oss-20b` -> `openai/gpt-oss-20b`,
// `codestral/codestral-latest` -> `codestral-latest`, `chat/ch.at` ->
// `ch.at`, with any `:free` suffix dropped. Anything else is a substitution.
const acceptsModel: PinModelCheck = (requested, returned) => {
  if (requested === 'auto') return true;
  const stripped = requested.replace(/:free$/, '');
  const unprefixed = stripped.includes('/') ? stripped.slice(stripped.indexOf('/') + 1) : stripped;
  return typeof returned === 'string' && returned.length > 0 && (
    returned === requested || returned === stripped || returned === unprefixed
  );
};

export class DreamPromptingProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'DreamPrompting key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    super({ platform: 'dreamprompting', name: 'DreamPrompting', baseUrl: 'https://dreamprompting.com/api/v1', pinModel: acceptsModel });
  }
}
