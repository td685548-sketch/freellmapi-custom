# Data Model
No DB changes. PlaygroundModel: id/name/provider. PlaygroundRequest: model, messages (system/user/assistant with text or image parts), temperature, max_tokens. Conversation: id/title/model/messages/updatedAt. Turn: id/role/content/images?/meta?. Browser history keyed by authenticated userId; strip images before persistence.
