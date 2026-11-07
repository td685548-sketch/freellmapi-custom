export interface PlaygroundModel { id: string; name: string; provider: string }
export interface PlaygroundCatalog { enabled: boolean; models: PlaygroundModel[] }
export type PlaygroundContent = string | Array<
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
>;
export interface PlaygroundRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: PlaygroundContent }[];
  temperature?: number;
  max_tokens?: number;
}
