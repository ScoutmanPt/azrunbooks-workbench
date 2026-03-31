import type { LocalSettings } from './workspaceManager';

export const CONNECTION_TYPE_KEY = '__connectionType';
export const CONNECTION_DESCRIPTION_KEY = '__description';
export const CERTIFICATE_DESCRIPTION_KEY = '__description';
export const CERTIFICATE_THUMBPRINT_KEY = 'Thumbprint';
export const CERTIFICATE_EXPIRY_KEY = 'ExpiryTime';
export const CERTIFICATE_EXPORTABLE_KEY = 'IsExportable';
export const CERTIFICATE_BASE64_KEY = 'Base64';
export const CERTIFICATE_PASSWORD_KEY = 'Password';

export function credentialSettingsFromAzure(userName?: string): LocalSettings['Assets']['Credentials'][string] {
  return {
    Username: userName ?? '',
    Password: '',
  };
}

export function normalizeAutomationVariableValue(value: string | undefined): string {
  if (value === undefined) { return ''; }

  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      // Keep the original string when it is not a valid JSON string literal.
    }
  }

  return value;
}

export function connectionSettingsFromAzure(
  connectionType?: string,
  fieldValues?: Record<string, string>,
  description?: string
): Record<string, string> {
  return {
    ...(fieldValues ?? {}),
    ...(connectionType ? { [CONNECTION_TYPE_KEY]: connectionType } : {}),
    ...(description ? { [CONNECTION_DESCRIPTION_KEY]: description } : {}),
  };
}

export function parseConnectionSettingsForAzure(
  values: Record<string, string>
): {
  connectionType?: string;
  description?: string;
  fieldValues: Record<string, string>;
} {
  const fieldValues: Record<string, string> = {};
  let connectionType: string | undefined;
  let description: string | undefined;

  for (const [key, value] of Object.entries(values)) {
    if (key === CONNECTION_TYPE_KEY) {
      connectionType = value.trim() || undefined;
      continue;
    }
    if (key === CONNECTION_DESCRIPTION_KEY) {
      description = value.trim() || undefined;
      continue;
    }
    fieldValues[key] = value;
  }

  return { connectionType, description, fieldValues };
}

export function certificateSettingsFromAzure(
  thumbprint?: string,
  expiryTime?: string,
  isExportable?: boolean,
  description?: string
): Record<string, string> {
  return {
    ...(thumbprint ? { [CERTIFICATE_THUMBPRINT_KEY]: thumbprint } : {}),
    ...(expiryTime ? { [CERTIFICATE_EXPIRY_KEY]: expiryTime } : {}),
    [CERTIFICATE_EXPORTABLE_KEY]: isExportable ? 'true' : 'false',
    ...(description ? { [CERTIFICATE_DESCRIPTION_KEY]: description } : {}),
    [CERTIFICATE_BASE64_KEY]: '',
    [CERTIFICATE_PASSWORD_KEY]: '',
  };
}
