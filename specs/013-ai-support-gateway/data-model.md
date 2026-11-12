# Data Model & Shared TypeScript Interfaces (`013-ai-support-gateway`)

Tất cả 4 Agent tuân thủ chính xác các kiểu dữ liệu và tên hàm dưới đây để tích hợp không cần chỉnh sửa chéo.

## 1. Shared TypeScript Interfaces (`server/src/custom/x-gateway/support-store.ts`)

```ts
export class SupportStoreError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface SupportRoleConfig {
  role: string;           // e.g. 'guest' | 'customer' | 'staff' | 'admin'
  label: string;
  description?: string;
  permissions: string[];  // e.g. ['products:read', 'orders:read_own']
}

export interface SupportTenant {
  id: number;
  name: string;
  slug: string;
  publicKey: string;      // 'pk_sup_<hex>'
  signingSecretMasked: string;
  defaultModel: string;   // 'auto' hoặc 'combo:<name>' hoặc '<provider>/<model>'
  systemPrompt: string;
  allowedOrigins: string[];
  allowGuest: boolean;
  rolesConfig: SupportRoleConfig[];
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportUserContext {
  tenantId: number;
  userId: string;
  name?: string;
  email?: string;
  role: string;
  permissions: string[];
  metadata?: Record<string, unknown>;
  verified: boolean;
  expiresAt?: number;
}

export interface SupportWebhookTool {
  id: number;
  tenantId: number;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  endpointUrl: string;
  headers: Record<string, string>;
  parametersSchema: Record<string, unknown>;
  allowedRoles: string[];
  lockUserIdParam: string | null;
  bypassUserLockRoles: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTablePolicy {
  tableName: string;
  description?: string;
  allowedRoles: string[];
  allowedColumns?: string[];
  deniedColumns?: string[];
  rowOwnerColumn?: string | null;
  bypassRowLockRoles?: string[];
}

export interface SupportDbSource {
  id: number;
  tenantId: number;
  name: string;
  driver: 'sqlite-sandbox' | 'sql-http';
  connectionUrl: string;
  authTokenMasked: string;
  schemaSql: string;
  tablePolicies: SupportTablePolicy[];
  maxRows: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

## 2. SQLite Tables (Auto-Bootstrapped via `ensureSupportTables()`)

- **`x_support_tenants`**:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `name TEXT NOT NULL`, `slug TEXT NOT NULL UNIQUE`, `public_key TEXT NOT NULL UNIQUE`
  - `secret_encrypted TEXT NOT NULL`, `secret_iv TEXT NOT NULL`, `secret_auth_tag TEXT NOT NULL`
  - `default_model TEXT NOT NULL DEFAULT 'auto'`, `system_prompt TEXT NOT NULL DEFAULT ''`
  - `allowed_origins_json TEXT NOT NULL DEFAULT '[]'`, `allow_guest INTEGER NOT NULL DEFAULT 1`
  - `roles_config_json TEXT NOT NULL DEFAULT '[]'`, `enabled INTEGER NOT NULL DEFAULT 1`
  - `created_by INTEGER`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
- **`x_support_tools`**:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`, `tenant_id INTEGER NOT NULL`
  - `name TEXT NOT NULL`, `description TEXT NOT NULL DEFAULT ''`, `method TEXT NOT NULL DEFAULT 'POST'`
  - `endpoint_url TEXT NOT NULL`, `headers_json TEXT NOT NULL DEFAULT '{}'`
  - `parameters_schema_json TEXT NOT NULL DEFAULT '{}'`, `allowed_roles_json TEXT NOT NULL DEFAULT '[]'`
  - `lock_user_id_param TEXT`, `bypass_user_lock_roles_json TEXT NOT NULL DEFAULT '["admin","staff"]'`
  - `enabled INTEGER NOT NULL DEFAULT 1`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
  - `UNIQUE(tenant_id, name)`
- **`x_support_db_sources`**:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`, `tenant_id INTEGER NOT NULL`
  - `name TEXT NOT NULL`, `driver TEXT NOT NULL DEFAULT 'sqlite-sandbox'`
  - `connection_url TEXT NOT NULL DEFAULT ''`
  - `token_encrypted TEXT`, `token_iv TEXT`, `token_auth_tag TEXT`
  - `schema_sql TEXT NOT NULL DEFAULT ''`, `table_policies_json TEXT NOT NULL DEFAULT '[]'`
  - `max_rows INTEGER NOT NULL DEFAULT 50`, `enabled INTEGER NOT NULL DEFAULT 1`
  - `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
