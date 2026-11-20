import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider, type PinModelCheck } from './openai-compat.js';

// Catalog routes carry a `:free` suffix that the response omits, and the
// `lucidityai/synth-2.5-*:free` routes legitimately report the gateway's
// own `synth-2.5-preview`. Anything else (including the `open/*` routes
// observed silently answering as synth-2.5-preview) is a substitution.
const acceptsModel: PinModelCheck = (requested, returned) =>
  typeof returned === 'string' && returned.length > 0 && (
    returned === requested ||
    returned === requested.replace(/:free$/, '') ||
    (requested.startsWith('lucidityai/synth-') && returned.startsWith('synth-'))
  );

export class LucidityProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Lucidity Composite key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    super({ platform: 'lucidity', name: 'Lucidity Composite', baseUrl: 'https://composite.lucidity.sh/v1', pinModel: acceptsModel });
  }
}
