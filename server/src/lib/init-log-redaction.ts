import { installLogRedaction } from './log-redaction.js';

// Import before createApp() so console wrappers capture and redact before any module-init loggers.
installLogRedaction();
